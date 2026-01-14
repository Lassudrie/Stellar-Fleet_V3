import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MathUtils,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3
} from 'three';
import {
  SurfaceMapWorkerClient,
  buildSurfaceMapWorkerRequest,
  type CloudShadowSettings,
  type SurfaceTextureOptions,
  type SurfaceTextureResult
} from '../../../workers';
import type {
  AtmosphereType,
  GameState,
  PlanetSurfaceDescriptor,
  PlanetType,
  StarSystem
} from '../../../../shared/shared';
import { hashStringToUnit } from '../systemViewLayout';
import { ATMOSPHERE_PRESETS, resolveAirMassIndex } from './atmosphere';
import {
  CITY_LIGHTS_DIAMETER_FULL_PX,
  CITY_LIGHTS_DIAMETER_MIN_PX,
  CITY_LIGHTS_INTENSITY_MAX,
  CITY_LIGHTS_INTENSITY_MIN,
  GAS_GIANT_NORMAL_STRENGTH,
  HIGH_DETAIL_GEOMETRY_DIAMETER_PX,
  HIGH_DETAIL_GEOMETRY_HYSTERESIS_PX,
  OWNER_TINT_STRENGTH,
  PLANET_TYPE_COLORS,
  SURFACE_DISPLACEMENT_BIAS,
  SURFACE_DISPLACEMENT_SCALE
} from './config';
import { createSeededRandom, linearToSrgbByte, smoothstep } from './renderUtils';
import type { OrbitingPlanet } from './systemModel';

const SURFACE_TEXTURE_MIN_DIAMETER_PX = 80;
const SURFACE_TEXTURE_MED_DIAMETER_PX = 160;
const SURFACE_TEXTURE_HIGH_DIAMETER_PX = 320;
const SURFACE_TEXTURE_ULTRA_DIAMETER_PX = 640;
const SURFACE_TEXTURE_UPSHIFT_DESKTOP = 1.18;
const SURFACE_TEXTURE_DOWNSHIFT_DESKTOP = 0.84;
const SURFACE_TEXTURE_MAX_CACHE_ENTRIES = 24;
const SURFACE_TEXTURE_MAX_INFLIGHT = 4;
const SURFACE_TEXTURE_WORKER_POOL_SIZE = 3;
const MAX_BODY_UPDATES_PER_FRAME = 3;
const SURFACE_TEXTURE_IDLE_DELAY_MS = 250;
const SURFACE_TEXTURE_WARMUP_WINDOW_MS = 1200;
const SURFACE_TEXTURE_BASELINE_RESOLUTION = { width: 512, height: 256 };
const SURFACE_TEXTURE_MIN_RESOLUTION = { width: 256, height: 128 };
const CAMERA_MOTION_POS_EPS = 1e-4;
const CAMERA_MOTION_ROT_EPS = 1e-4;
const CAMERA_MOTION_FOV_EPS = 1e-3;
const SURFACE_MIPMAP_ANISOTROPY_DESKTOP = 8;

type SurfaceTextureResolution = { width: number; height: number };
type SurfaceTextureDebugInfo = {
  cacheSize: number;
  inflightSize: number;
  activeBodies: Array<{
    bodyId: string;
    diameterPx: number;
    resolution: SurfaceTextureResolution | null;
    isOnScreen: boolean;
  }>;
};
type BodyMetrics = { diameterPx: number; isOnScreen: boolean };
type BodyInfo = {
  isSolid: boolean;
  isGasGiant: boolean;
  planetType: PlanetType | null;
  hasAtmosphere: boolean;
  isMoon: boolean;
};

const SURFACE_TEXTURE_RESOLUTIONS: Array<SurfaceTextureResolution & { minDiameter: number }> = [
  { width: 256, height: 128, minDiameter: SURFACE_TEXTURE_MIN_DIAMETER_PX },
  { width: 512, height: 256, minDiameter: SURFACE_TEXTURE_MED_DIAMETER_PX },
  { width: 1024, height: 512, minDiameter: SURFACE_TEXTURE_HIGH_DIAMETER_PX },
  { width: 2048, height: 1024, minDiameter: SURFACE_TEXTURE_ULTRA_DIAMETER_PX }
];

const getSurfaceResolutionIndex = (resolution: SurfaceTextureResolution | null): number => {
  if (!resolution) return -1;
  for (let i = 0; i < SURFACE_TEXTURE_RESOLUTIONS.length; i += 1) {
    const candidate = SURFACE_TEXTURE_RESOLUTIONS[i];
    if (candidate.width === resolution.width && candidate.height === resolution.height) {
      return i;
    }
  }
  return -1;
};

const pickSurfaceTextureResolution = (
  diameterPx: number,
  preferUltra: boolean,
  lastResolution: SurfaceTextureResolution | null,
  upshift: number,
  downshift: number
): SurfaceTextureResolution | null => {
  if (!Number.isFinite(diameterPx) || diameterPx <= 0) return null;
  const maxIndex = preferUltra ? SURFACE_TEXTURE_RESOLUTIONS.length - 1 : SURFACE_TEXTURE_RESOLUTIONS.length - 2;
  let targetIndex = 0;
  for (let i = 0; i <= maxIndex; i += 1) {
    if (diameterPx >= SURFACE_TEXTURE_RESOLUTIONS[i].minDiameter) {
      targetIndex = i;
    }
  }
  const lastIndexRaw = getSurfaceResolutionIndex(lastResolution);
  if (lastIndexRaw >= 0) {
    const lastIndex = Math.min(lastIndexRaw, maxIndex);
    const upIndex = Math.min(lastIndex + 1, maxIndex);
    const downIndex = Math.max(lastIndex - 1, 0);
    const upThreshold = SURFACE_TEXTURE_RESOLUTIONS[upIndex].minDiameter * upshift;
    const downThreshold = SURFACE_TEXTURE_RESOLUTIONS[lastIndex].minDiameter * downshift;
    if (lastIndex < maxIndex && diameterPx >= upThreshold) {
      return SURFACE_TEXTURE_RESOLUTIONS[upIndex];
    }
    if (lastIndex > 0 && diameterPx < downThreshold) {
      return SURFACE_TEXTURE_RESOLUTIONS[downIndex];
    }
    return SURFACE_TEXTURE_RESOLUTIONS[lastIndex];
  }
  return SURFACE_TEXTURE_RESOLUTIONS[targetIndex];
};

const createGasGiantTextureData = (
  seedKey: string,
  baseColor: string,
  width: number,
  height: number,
  isIceGiant: boolean
): { color: Uint8Array; roughness: Uint8Array; heightField: Float32Array } => {
  const seed = Math.floor(hashStringToUnit(seedKey) * 0xffffffff);
  const rand = createSeededRandom(seed);
  const base = new Color(baseColor);
  const light = base.clone().lerp(new Color('#ffffff'), 0.18 + rand() * 0.2);
  const dark = base.clone().lerp(new Color('#0b1020'), 0.22 + rand() * 0.22);
  const accent = base.clone().lerp(new Color(isIceGiant ? '#e0f2fe' : '#fcd34d'), 0.2 + rand() * 0.3);

  const bandFreq = 5 + Math.floor(rand() * 7);
  const bandJitter = 0.2 + rand() * 0.35;
  const bandContrast = 0.12 + rand() * 0.18;
  const lonFreq = 1.6 + rand() * 2.8;
  const lonStrength = 0.05 + rand() * 0.09;
  const vortexU = rand();
  const vortexV = 0.25 + rand() * 0.5;
  const vortexRadius = 0.08 + rand() * 0.12;
  const vortexStrength = 0.18 + rand() * 0.2;
  const vortexTwist = 4.5 + rand() * 3.5;
  const roughBase = isIceGiant ? 0.52 : 0.38;
  const roughVar = isIceGiant ? 0.16 : 0.12;

  const rowOffsets = new Float32Array(height);
  for (let y = 0; y < height; y += 1) {
    rowOffsets[y] = (rand() - 0.5) * bandJitter;
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (let y = 0; y < height; y += 1) {
      const prev = rowOffsets[y === 0 ? 0 : y - 1];
      const next = rowOffsets[y === height - 1 ? height - 1 : y + 1];
      rowOffsets[y] = (rowOffsets[y] + prev + next) / 3;
    }
  }

  const color = new Uint8Array(width * height * 4);
  const roughness = new Uint8Array(width * height * 4);
  const heightField = new Float32Array(width * height);
  const twoPi = Math.PI * 2;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const lat = (v - 0.5) * Math.PI;
    const latSin = Math.sin(lat);
    const latNorm = Math.abs(v - 0.5) * 2;
    const poleBlend = 1 - smoothstep(0.55, 0.92, latNorm);
    const detailFactor = MathUtils.lerp(0.4, 1, poleBlend);
    const bandBase = Math.sin(latSin * bandFreq + rowOffsets[y]);
    const bandValue = 0.5 + 0.5 * bandBase;

    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const uAngle = u * twoPi;
      const lonNoise = Math.sin(uAngle * lonFreq + lat * 2.1) * lonStrength;
      let band = bandValue + lonNoise * detailFactor;

      const dx = Math.min(Math.abs(u - vortexU), 1 - Math.abs(u - vortexU));
      const dy = Math.abs(v - vortexV);
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < vortexRadius) {
        const t = 1 - dist / vortexRadius;
        band += Math.sin((dist * vortexTwist + uAngle) * 2.5) * vortexStrength * t;
      }

      const bandWeight = smoothstep(0.35 - bandContrast, 0.65 + bandContrast, band);
      const tint = bandWeight < 0.5
        ? dark.clone().lerp(base, bandWeight * 2)
        : base.clone().lerp(light, (bandWeight - 0.5) * 2);
      const accentWeight = Math.max(0, 0.25 - Math.abs(bandWeight - 0.55)) * 3.2;
      const r = MathUtils.lerp(tint.r, accent.r, accentWeight);
      const g = MathUtils.lerp(tint.g, accent.g, accentWeight);
      const b = MathUtils.lerp(tint.b, accent.b, accentWeight);

      const idx = (y * width + x) * 4;
      color[idx] = linearToSrgbByte(r);
      color[idx + 1] = linearToSrgbByte(g);
      color[idx + 2] = linearToSrgbByte(b);
      color[idx + 3] = 255;
      heightField[y * width + x] = MathUtils.clamp(bandWeight, 0, 1);

      const roughNoise = Math.sin(uAngle * (lonFreq * 0.7) + lat * 1.7) * 0.05;
      const rough = MathUtils.clamp(roughBase + (0.5 - band) * roughVar + roughNoise, 0.2, 0.95);
      const roughByte = Math.round(rough * 255);
      roughness[idx] = roughByte;
      roughness[idx + 1] = roughByte;
      roughness[idx + 2] = roughByte;
      roughness[idx + 3] = 255;
    }
  }

  return { color, roughness, heightField };
};

const buildGasGiantNormalRgba = (
  heightField: Float32Array,
  width: number,
  height: number
): Uint8Array => {
  const normalRgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const latNorm = Math.abs(v - 0.5) * 2;
    const poleBlend = 1 - smoothstep(0.55, 0.92, latNorm);
    const rowStrength = GAS_GIANT_NORMAL_STRENGTH * (0.35 + poleBlend * 0.65);
    const row = y * width;
    const row0 = (y === 0 ? 0 : y - 1) * width;
    const row1 = (y === height - 1 ? height - 1 : y + 1) * width;

    for (let x = 0; x < width; x += 1) {
      const x0 = x === 0 ? width - 1 : x - 1;
      const x1 = x === width - 1 ? 0 : x + 1;
      const idx = row + x;
      const hL = heightField[row + x0];
      const hR = heightField[row + x1];
      const hU = heightField[row0 + x];
      const hD = heightField[row1 + x];
      let nx = -(hR - hL) * rowStrength;
      let ny = -(hD - hU) * rowStrength;
      let nz = 1.0;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const nIdx = idx * 4;
      normalRgba[nIdx] = Math.round((nx * 0.5 + 0.5) * 255);
      normalRgba[nIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalRgba[nIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normalRgba[nIdx + 3] = 255;
    }
  }
  return normalRgba;
};

export const SystemSurfaceTextureManager: React.FC<{
  starSystem: StarSystem;
  astroKey: string;
  planetSurfaceDescriptorsByBodyId?: Record<string, PlanetSurfaceDescriptor>;
  ownerColorByBodyId: Record<string, string>;
  planets: OrbitingPlanet[];
  bodyWorldPositions: Record<string, [number, number, number]>;
  bodyRadii: Record<string, number>;
  selectedBodyId: string | null;
  cloudShadowStrengthScale: number;
  debugEnabled?: boolean;
  onDebugUpdate?: (info: SurfaceTextureDebugInfo) => void;
  onCloseUpBodyIdChange?: (bodyId: string | null) => void;
  resolveMaterial: (bodyId: string) => MeshStandardMaterial | null;
}> = ({
  starSystem,
  astroKey,
  planetSurfaceDescriptorsByBodyId,
  ownerColorByBodyId,
  planets,
  bodyWorldPositions,
  bodyRadii,
  selectedBodyId,
  cloudShadowStrengthScale,
  debugEnabled = false,
  onDebugUpdate,
  onCloseUpBodyIdChange,
  resolveMaterial
}) => {
  const { camera, gl, size } = useThree();
  const workerPoolRef = useRef<SurfaceMapWorkerClient[]>([]);
  const workerIndexRef = useRef(0);
  type SurfaceTextureBundle = {
    color: DataTexture;
    normal: DataTexture | null;
    ao: DataTexture | null;
    roughness: DataTexture | null;
    height: DataTexture | null;
    emissive: DataTexture | null;
  };
  const cacheRef = useRef<Map<string, SurfaceTextureBundle>>(new Map());
  const cacheLastUsedRef = useRef<Map<string, number>>(new Map());
  const inFlightRef = useRef<Map<string, { bodyId: string; epoch: number }>>(new Map());
  const desiredKeyByBodyIdRef = useRef<Map<string, string | null>>(new Map());
  const lastResolutionByBodyIdRef = useRef<Map<string, SurfaceTextureResolution>>(new Map());
  const activeKeysRef = useRef<Set<string>>(new Set());
  const bodyMetricsByIdRef = useRef<Map<string, BodyMetrics>>(new Map());
  const bodyInfoByIdRef = useRef<Map<string, BodyInfo>>(new Map());
  const closeUpBodyIdRef = useRef<string | null>(null);
  const updateCursorRef = useRef(0);
  const lastDebugUpdateRef = useRef(0);
  const requestStateRef = useRef<GameState | null>(null);
  const requestEpochRef = useRef(0);
  const planetsRef = useRef(planets);
  const selectedBodyIdRef = useRef<string | null>(selectedBodyId);
  const warmupTargetsRef = useRef<Map<string, number>>(new Map());
  const cameraMotionRef = useRef({
    position: new Vector3(),
    quaternion: new Quaternion(),
    fov: 0,
    hasSample: false,
    lastMotionTime: 0
  });
  const maxCacheEntries = SURFACE_TEXTURE_MAX_CACHE_ENTRIES;
  const maxInflight = SURFACE_TEXTURE_MAX_INFLIGHT;
  const scratch = useMemo(() => ({
    world: new Vector3(),
    view: new Vector3(),
    ndc: new Vector3()
  }), []);
  const maxAnisotropy = useMemo(() => {
    try {
      return gl.capabilities.getMaxAnisotropy?.() ?? 1;
    } catch {
      return 1;
    }
  }, [gl.capabilities]);
  const createDataTexture = useCallback((rgba: Uint8Array, width: number, height: number, useSrgb: boolean): DataTexture => {
    const texture = new DataTexture(rgba, width, height);
    if (useSrgb) {
      texture.colorSpace = SRGBColorSpace;
    }
    texture.wrapS = RepeatWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    const useMipmaps = true;
    const maxSurfaceAnisotropy = SURFACE_MIPMAP_ANISOTROPY_DESKTOP;
    texture.minFilter = useMipmaps ? LinearMipmapLinearFilter : LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = useMipmaps;
    texture.anisotropy = useMipmaps ? Math.min(maxSurfaceAnisotropy, Math.max(1, maxAnisotropy)) : 1;
    texture.flipY = false;
    texture.needsUpdate = true;
    return texture;
  }, [maxAnisotropy]);

  const cloudShadowByBodyId = useMemo(() => {
    const map = new Map<string, CloudShadowSettings>();
    if (cloudShadowStrengthScale <= 0) return map;

    const addShadow = (
      body: { id: string; atmosphere?: AtmosphereType; airMassIndex?: number; pressureBar?: number; temperatureK?: number },
      isSolid: boolean
    ) => {
      if (!isSolid) return;
      const atmosphere = body.atmosphere;
      if (!atmosphere || atmosphere === 'None') return;
      const preset = ATMOSPHERE_PRESETS[atmosphere];
      const cloudStyle = preset.cloudStyle;
      if (!cloudStyle) return;

      const airMass = resolveAirMassIndex(body.airMassIndex, body.pressureBar, atmosphere);
      const temperatureK = typeof body.temperatureK === 'number' && Number.isFinite(body.temperatureK)
        ? body.temperatureK
        : (atmosphere === 'H2He' ? 140 : 288);

      let cloudiness = MathUtils.clamp(preset.clouds * MathUtils.lerp(0.55, 1.2, airMass), 0, 1);
      switch (atmosphere) {
        case 'Earthlike': {
          const tempSuitability = MathUtils.clamp(1 - Math.abs(temperatureK - 288) / 170, 0, 1);
          cloudiness = MathUtils.clamp(cloudiness * MathUtils.lerp(0.6, 1.3, tempSuitability), 0, 1);
          break;
        }
        case 'CO2': {
          cloudiness = MathUtils.clamp(cloudiness * 0.9, 0, 1);
          break;
        }
        case 'H2He': {
          cloudiness = MathUtils.clamp(cloudiness * 1.05, 0, 1);
          break;
        }
        default:
          break;
      }

      if (cloudiness <= 0.08) return;

      const seed = Math.floor(hashStringToUnit(`${body.id}|cloud_shadow_seed`) * 0xffffffff);
      const seed2 = Math.floor(hashStringToUnit(`${body.id}|cloud_shadow_seed2`) * 0xffffffff);
      const bandOffset = hashStringToUnit(`${body.id}|cloud_shadow_band_offset`) * Math.PI * 2;
      const strength = MathUtils.clamp((0.08 + cloudiness * 0.28) * cloudShadowStrengthScale, 0.02, 0.35 * cloudShadowStrengthScale);
      if (strength <= 0.01) return;

      map.set(body.id, {
        strength,
        noiseScale: Math.max(2, cloudStyle.noiseScale * 2),
        threshold: MathUtils.clamp(cloudStyle.threshold - cloudiness * 0.1, 0.2, 0.9),
        softness: MathUtils.clamp(cloudStyle.softness * 1.35, 0.03, 0.25),
        seed,
        seed2,
        bandStrength: cloudStyle.bandStrength,
        bandFrequency: cloudStyle.bandFrequency,
        bandOffset
      });
    };

    planets.forEach((planet) => {
      addShadow(planet, planet.isSolid ?? true);
      planet.moons.forEach(moon => addShadow(moon, moon.isSolid ?? true));
    });

    return map;
  }, [cloudShadowStrengthScale, planets]);

  useEffect(() => {
    requestStateRef.current = ({
      systems: [starSystem],
      planetSurfaceDescriptorsByBodyId
    } as unknown as GameState);
  }, [planetSurfaceDescriptorsByBodyId, starSystem]);

  useEffect(() => {
    planetsRef.current = planets;
  }, [planets]);

  useEffect(() => {
    selectedBodyIdRef.current = selectedBodyId;
  }, [selectedBodyId]);

  const disposeTextureBundle = useCallback((bundle: SurfaceTextureBundle) => {
    bundle.color.dispose();
    bundle.normal?.dispose();
    bundle.ao?.dispose();
    bundle.roughness?.dispose();
    bundle.height?.dispose();
    bundle.emissive?.dispose();
  }, []);

  useEffect(() => {
    workerPoolRef.current = Array.from(
      { length: SURFACE_TEXTURE_WORKER_POOL_SIZE },
      () => new SurfaceMapWorkerClient()
    );
    return () => {
      workerPoolRef.current.forEach(worker => worker.dispose());
      workerPoolRef.current = [];
      cacheRef.current.forEach(bundle => disposeTextureBundle(bundle));
      cacheRef.current.clear();
      cacheLastUsedRef.current.clear();
      inFlightRef.current.clear();
      desiredKeyByBodyIdRef.current.clear();
    };
  }, [disposeTextureBundle]);

  const buildTextureKey = useCallback((bodyId: string, descriptor: PlanetSurfaceDescriptor, resolution: SurfaceTextureResolution): string => {
    const config = descriptor.config;
    const { planetIndex, moonIndex } = descriptor.astroRef;
    return [
      bodyId,
      descriptor.seed,
      config.w,
      config.h,
      config.wrapX ? 'wrap' : 'nowrap',
      config.generatorVersion,
      planetIndex,
      moonIndex ?? 'no-moon',
      astroKey,
      resolution.width,
      resolution.height
    ].join('|');
  }, [astroKey]);
  const buildTextureOptionsKey = useCallback((options: SurfaceTextureOptions | null): string => {
    const includeNormalMap = options?.includeNormalMap ?? true;
    const includeAoMap = options?.includeAoMap ?? true;
    const includeRoughnessMap = options?.includeRoughnessMap ?? true;
    const includeHeightMap = options?.includeHeightMap ?? false;
    const includeEmissiveMap = options?.includeEmissiveMap ?? false;
    const source = options?.source ?? 'field';
    return `maps:${source}:n${includeNormalMap ? 1 : 0}a${includeAoMap ? 1 : 0}r${includeRoughnessMap ? 1 : 0}h${includeHeightMap ? 1 : 0}e${includeEmissiveMap ? 1 : 0}`;
  }, []);

  const buildGasGiantTextureKey = useCallback((
    bodyId: string,
    planetType: PlanetType | null,
    resolution: SurfaceTextureResolution,
    options: SurfaceTextureOptions | null
  ): string => (
    ['gas', bodyId, planetType ?? 'unknown', astroKey, resolution.width, resolution.height, buildTextureOptionsKey(options)].join('|')
  ), [astroKey, buildTextureOptionsKey]);

  const buildGasGiantBundle = useCallback((
    bodyId: string,
    planetType: PlanetType | null,
    resolution: SurfaceTextureResolution,
    options: SurfaceTextureOptions | null
  ): SurfaceTextureBundle => {
    const baseColor = planetType ? PLANET_TYPE_COLORS[planetType] : '#cbd5e1';
    const isIceGiant = planetType === 'IceGiant';
    const seedKey = `${bodyId}|${astroKey}|${resolution.width}x${resolution.height}`;
    const data = createGasGiantTextureData(seedKey, baseColor, resolution.width, resolution.height, isIceGiant);
    const colorTexture = createDataTexture(data.color, resolution.width, resolution.height, true);
    const includeRoughness = options?.includeRoughnessMap ?? true;
    const roughnessTexture = includeRoughness
      ? createDataTexture(data.roughness, resolution.width, resolution.height, false)
      : null;
    const includeNormal = options?.includeNormalMap ?? true;
    const normalTexture = includeNormal
      ? createDataTexture(buildGasGiantNormalRgba(data.heightField, resolution.width, resolution.height), resolution.width, resolution.height, false)
      : null;
    return {
      color: colorTexture,
      normal: normalTexture,
      ao: null,
      roughness: roughnessTexture,
      height: null,
      emissive: null
    };
  }, [astroKey, createDataTexture]);

  const applyOwnerTintColor = useCallback((material: MeshStandardMaterial, baseColor: string) => {
    const ownerTint = typeof material.userData.ownerTintColor === 'string'
      ? material.userData.ownerTintColor
      : '#ffffff';
    const ownerStrength = typeof material.userData.ownerTintStrength === 'number'
      ? material.userData.ownerTintStrength
      : 0;
    if (ownerStrength <= 0 || ownerTint === '#ffffff') {
      material.color.set(baseColor);
      return;
    }
    const tinted = new Color(baseColor).lerp(new Color(ownerTint), ownerStrength);
    material.color.copy(tinted);
  }, []);

  const resolveCityLightsIntensity = useCallback((diameterPx: number): number => {
    if (!Number.isFinite(diameterPx)) return 0;
    if (diameterPx <= CITY_LIGHTS_DIAMETER_MIN_PX) return 0;
    const t = MathUtils.clamp(
      (diameterPx - CITY_LIGHTS_DIAMETER_MIN_PX) / (CITY_LIGHTS_DIAMETER_FULL_PX - CITY_LIGHTS_DIAMETER_MIN_PX),
      0,
      1
    );
    return MathUtils.lerp(CITY_LIGHTS_INTENSITY_MIN, CITY_LIGHTS_INTENSITY_MAX, t);
  }, []);

  const applyTextureToMaterial = useCallback((material: MeshStandardMaterial, key: string, bundle: SurfaceTextureBundle) => {
    let needsUpdate = false;
    if (material.map !== bundle.color) {
      material.map = bundle.color;
      const surfaceTint = typeof material.userData.surfaceTintColor === 'string'
        ? material.userData.surfaceTintColor
        : '#ffffff';
      applyOwnerTintColor(material, surfaceTint);
      needsUpdate = true;
    }
    const nextNormal = bundle.normal ?? null;
    if (material.normalMap !== nextNormal) {
      material.normalMap = nextNormal;
      needsUpdate = true;
    }
    const nextAo = bundle.ao ?? null;
    if (material.aoMap !== nextAo) {
      material.aoMap = nextAo;
      needsUpdate = true;
    }
    const nextRoughness = bundle.roughness ?? null;
    if (material.roughnessMap !== nextRoughness) {
      material.roughnessMap = nextRoughness;
      needsUpdate = true;
    }
    const nextHeight = bundle.height ?? null;
    if (material.displacementMap !== nextHeight) {
      material.displacementMap = nextHeight;
      needsUpdate = true;
    }
    const nextEmissive = bundle.emissive ?? null;
    if (material.emissiveMap !== nextEmissive) {
      material.emissiveMap = nextEmissive;
      if (nextEmissive) {
        material.emissive.set('#ffffff');
      }
      needsUpdate = true;
    }
    const baseRoughness = typeof material.userData.baseRoughness === 'number'
      ? material.userData.baseRoughness
      : material.roughness;
    if (nextRoughness) {
      material.roughness = 1;
    } else if (material.roughness !== baseRoughness) {
      material.roughness = baseRoughness;
    }
    if (nextHeight) {
      const displacementScale = typeof material.userData.surfaceDisplacementScale === 'number'
        ? material.userData.surfaceDisplacementScale
        : SURFACE_DISPLACEMENT_SCALE;
      const displacementBias = typeof material.userData.surfaceDisplacementBias === 'number'
        ? material.userData.surfaceDisplacementBias
        : SURFACE_DISPLACEMENT_BIAS;
      material.displacementScale = displacementScale;
      material.displacementBias = displacementBias;
    } else if (material.displacementScale !== 0 || material.displacementBias !== 0) {
      material.displacementScale = 0;
      material.displacementBias = 0;
    }
    const baseEmissiveIntensity = typeof material.userData.baseEmissiveIntensity === 'number'
      ? material.userData.baseEmissiveIntensity
      : 0;
    if (nextEmissive) {
      const targetIntensity = typeof material.userData.surfaceEmissiveIntensity === 'number'
        ? material.userData.surfaceEmissiveIntensity
        : baseEmissiveIntensity;
      if (material.emissiveIntensity !== targetIntensity) {
        material.emissiveIntensity = targetIntensity;
      }
    } else if (material.emissiveIntensity !== baseEmissiveIntensity) {
      material.emissiveIntensity = baseEmissiveIntensity;
    }
    if (needsUpdate) {
      material.needsUpdate = true;
    }
    material.userData.surfaceTextureKey = key;
    material.userData.surfaceNormalTextureKey = nextNormal ? key : null;
    material.userData.surfaceAoTextureKey = nextAo ? key : null;
    material.userData.surfaceRoughnessTextureKey = nextRoughness ? key : null;
    material.userData.surfaceHeightTextureKey = nextHeight ? key : null;
    material.userData.surfaceEmissiveTextureKey = nextEmissive ? key : null;
  }, [applyOwnerTintColor]);

  const clearTextureFromMaterial = useCallback((material: MeshStandardMaterial) => {
    let needsUpdate = false;
    if (material.map) {
      material.map = null;
      needsUpdate = true;
    }
    if (material.normalMap) {
      material.normalMap = null;
      needsUpdate = true;
    }
    if (material.aoMap) {
      material.aoMap = null;
      needsUpdate = true;
    }
    if (material.roughnessMap) {
      material.roughnessMap = null;
      needsUpdate = true;
    }
    if (material.emissiveMap) {
      material.emissiveMap = null;
      needsUpdate = true;
    }
    if (material.displacementMap) {
      material.displacementMap = null;
      material.displacementScale = 0;
      material.displacementBias = 0;
      needsUpdate = true;
    }
    if (needsUpdate) {
      material.needsUpdate = true;
    }
    const baseColor = typeof material.userData.baseColor === 'string' ? material.userData.baseColor : null;
    if (baseColor) {
      applyOwnerTintColor(material, baseColor);
    }
    const baseRoughness = typeof material.userData.baseRoughness === 'number' ? material.userData.baseRoughness : null;
    if (typeof baseRoughness === 'number') {
      material.roughness = baseRoughness;
    }
    const baseEmissiveIntensity = typeof material.userData.baseEmissiveIntensity === 'number'
      ? material.userData.baseEmissiveIntensity
      : 0;
    if (material.emissiveIntensity !== baseEmissiveIntensity) {
      material.emissiveIntensity = baseEmissiveIntensity;
    }
    material.userData.surfaceTextureKey = null;
    material.userData.surfaceNormalTextureKey = null;
    material.userData.surfaceAoTextureKey = null;
    material.userData.surfaceRoughnessTextureKey = null;
    material.userData.surfaceHeightTextureKey = null;
    material.userData.surfaceEmissiveTextureKey = null;
  }, [applyOwnerTintColor]);

  useEffect(() => {
    requestEpochRef.current += 1;
    cacheRef.current.forEach(bundle => disposeTextureBundle(bundle));
    cacheRef.current.clear();
    cacheLastUsedRef.current.clear();
    inFlightRef.current.clear();
    desiredKeyByBodyIdRef.current.clear();
    lastResolutionByBodyIdRef.current.clear();
    closeUpBodyIdRef.current = null;
    onCloseUpBodyIdChange?.(null);
    warmupTargetsRef.current.clear();
    const warmupBodyId = selectedBodyIdRef.current;
    if (warmupBodyId) {
      warmupTargetsRef.current.set(warmupBodyId, performance.now() + SURFACE_TEXTURE_WARMUP_WINDOW_MS);
    }

    planetsRef.current.forEach((planet) => {
      const material = resolveMaterial(planet.id);
      if (material) {
        clearTextureFromMaterial(material);
      }
      planet.moons.forEach((moon) => {
        const moonMaterial = resolveMaterial(moon.id);
        if (moonMaterial) {
          clearTextureFromMaterial(moonMaterial);
        }
      });
    });
  }, [astroKey, clearTextureFromMaterial, disposeTextureBundle, onCloseUpBodyIdChange, resolveMaterial]);

  useFrame(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    if (!planetSurfaceDescriptorsByBodyId) {
      const hasGasGiant = planets.some(planet => planet.type === 'GasGiant' || planet.type === 'IceGiant');
      if (!hasGasGiant) return;
    }

    camera.updateMatrixWorld();

    const now = performance.now();
    const cameraMotion = cameraMotionRef.current;
    if (!cameraMotion.hasSample) {
      cameraMotion.position.copy(camera.position);
      cameraMotion.quaternion.copy(camera.quaternion);
      cameraMotion.fov = camera.fov;
      cameraMotion.hasSample = true;
      cameraMotion.lastMotionTime = now;
    } else {
      const posDeltaSq = camera.position.distanceToSquared(cameraMotion.position);
      const quatDot = Math.abs(camera.quaternion.dot(cameraMotion.quaternion));
      const rotDelta = 1 - quatDot;
      const fovDelta = Math.abs(camera.fov - cameraMotion.fov);
      if (posDeltaSq > CAMERA_MOTION_POS_EPS * CAMERA_MOTION_POS_EPS
        || rotDelta > CAMERA_MOTION_ROT_EPS
        || fovDelta > CAMERA_MOTION_FOV_EPS) {
        cameraMotion.lastMotionTime = now;
      }
      cameraMotion.position.copy(camera.position);
      cameraMotion.quaternion.copy(camera.quaternion);
      cameraMotion.fov = camera.fov;
    }
    const isIdle = now - cameraMotion.lastMotionTime > SURFACE_TEXTURE_IDLE_DELAY_MS;
    const activeKeys = activeKeysRef.current;
    const bodyMetricsById = bodyMetricsByIdRef.current;
    const bodyInfoById = bodyInfoByIdRef.current;
    activeKeys.clear();
    bodyMetricsById.clear();
    bodyInfoById.clear();

    const cameraFovRad = MathUtils.degToRad(camera.fov);
    const pixelRatio = (() => {
      try {
        return gl.getPixelRatio?.() ?? 1;
      } catch {
        return 1;
      }
    })();
    const renderWidthPx = size.width * pixelRatio;
    const renderHeightPx = size.height * pixelRatio;
    const pixelsPerWorldUnitAtZ1 = renderHeightPx / (2 * Math.tan(cameraFovRad / 2));

    let ultraBodyId: string | null = null;
    let ultraDiameter = 0;

    const recordBodyMetrics = (bodyId: string, canRender: boolean) => {
      if (!canRender) return;
      const worldPos = bodyWorldPositions[bodyId];
      const radius = bodyRadii[bodyId];
      if (!worldPos || typeof radius !== 'number') return;

      scratch.world.set(...worldPos);
      scratch.ndc.copy(scratch.world).project(camera);
      scratch.view.copy(scratch.world).applyMatrix4(camera.matrixWorldInverse);
      let z = -scratch.view.z;
      if (!Number.isFinite(z) || z <= 0) {
        z = camera.position.distanceTo(scratch.world);
        if (!Number.isFinite(z) || z <= 0) return;
      }

      const pixelRadius = (radius / z) * pixelsPerWorldUnitAtZ1;
      const screenMargin = 0.15;
      const ndcRadiusX = renderWidthPx > 0 ? (pixelRadius * 2) / renderWidthPx : 0;
      const ndcRadiusY = renderHeightPx > 0 ? (pixelRadius * 2) / renderHeightPx : 0;
      const isOnScreen = scratch.ndc.z > -1 && scratch.ndc.z < 1
        && Math.abs(scratch.ndc.x) <= 1 + screenMargin + ndcRadiusX
        && Math.abs(scratch.ndc.y) <= 1 + screenMargin + ndcRadiusY;

      const diameterPx = pixelRadius * 2;
      bodyMetricsById.set(bodyId, { diameterPx, isOnScreen });

      if (isOnScreen && diameterPx >= SURFACE_TEXTURE_ULTRA_DIAMETER_PX && diameterPx > ultraDiameter) {
        ultraDiameter = diameterPx;
        ultraBodyId = bodyId;
      }
    };

    planets.forEach((planet) => {
      const isGasGiant = planet.type === 'GasGiant' || planet.type === 'IceGiant';
      const isSolid = planet.isSolid ?? true;
      const hasAtmosphere = Boolean(planet.atmosphere && planet.atmosphere !== 'None');
      bodyInfoById.set(planet.id, {
        isSolid,
        isGasGiant,
        planetType: planet.type,
        hasAtmosphere,
        isMoon: false
      });
      const planetHasDescriptor = Boolean(planetSurfaceDescriptorsByBodyId?.[planet.id]);
      recordBodyMetrics(planet.id, isGasGiant || (isSolid && planetHasDescriptor));
      planet.moons.forEach((moon) => {
        const moonSolid = moon.isSolid ?? true;
        const moonHasAtmosphere = Boolean(moon.atmosphere && moon.atmosphere !== 'None');
        bodyInfoById.set(moon.id, {
          isSolid: moonSolid,
          isGasGiant: false,
          planetType: null,
          hasAtmosphere: moonHasAtmosphere,
          isMoon: true
        });
        const moonHasDescriptor = Boolean(planetSurfaceDescriptorsByBodyId?.[moon.id]);
        recordBodyMetrics(moon.id, moonSolid && moonHasDescriptor);
      });
    });

    const downThreshold = HIGH_DETAIL_GEOMETRY_DIAMETER_PX - HIGH_DETAIL_GEOMETRY_HYSTERESIS_PX;
    const prevCloseUpBodyId = closeUpBodyIdRef.current;
    let nextCloseUpBodyId: string | null = null;
    let nextCloseUpDiameter = 0;
    if (prevCloseUpBodyId) {
      const metrics = bodyMetricsById.get(prevCloseUpBodyId);
      if (metrics && metrics.diameterPx >= downThreshold && metrics.isOnScreen) {
        nextCloseUpBodyId = prevCloseUpBodyId;
        nextCloseUpDiameter = metrics.diameterPx;
      }
    }
    bodyMetricsById.forEach((metrics, bodyId) => {
      if (!metrics.isOnScreen) return;
      if (metrics.diameterPx < HIGH_DETAIL_GEOMETRY_DIAMETER_PX) return;
      if (metrics.diameterPx > nextCloseUpDiameter) {
        nextCloseUpDiameter = metrics.diameterPx;
        nextCloseUpBodyId = bodyId;
      }
    });
    const resolvedCloseUpBodyId = nextCloseUpBodyId;
    if (resolvedCloseUpBodyId !== closeUpBodyIdRef.current) {
      closeUpBodyIdRef.current = resolvedCloseUpBodyId;
      onCloseUpBodyIdChange?.(resolvedCloseUpBodyId);
    }

    const preferUltraBodyId = selectedBodyId ?? ultraBodyId;
    const shouldPreferUltra = (bodyId: string) => bodyId === preferUltraBodyId;

    const touchKey = (key: string) => {
      cacheLastUsedRef.current.set(key, now);
      activeKeys.add(key);
    };

    const updateBody = (bodyId: string) => {
      const bodyInfo = bodyInfoById.get(bodyId);
      if (!bodyInfo) return;
      const {
        isSolid,
        isGasGiant,
        planetType,
        hasAtmosphere,
        isMoon
      } = bodyInfo;
      const descriptor = planetSurfaceDescriptorsByBodyId?.[bodyId];
      if (!descriptor && !isGasGiant) return;
      if (!isSolid && !isGasGiant) return;

      const metrics = bodyMetricsById.get(bodyId);
      if (!metrics) return;
      const { diameterPx, isOnScreen } = metrics;
      const warmupUntil = warmupTargetsRef.current.get(bodyId);
      const isWarmup = typeof warmupUntil === 'number' && warmupUntil > now;
      const shouldRender = isOnScreen || isWarmup;
      if (diameterPx < 10) {
        desiredKeyByBodyIdRef.current.set(bodyId, null);
        const material = resolveMaterial(bodyId);
        if (material && material.userData.surfaceTextureKey) {
          clearTextureFromMaterial(material);
        }
        return;
      }

      const lastResolution = lastResolutionByBodyIdRef.current.get(bodyId) ?? null;
      const upshift = SURFACE_TEXTURE_UPSHIFT_DESKTOP;
      const downshift = SURFACE_TEXTURE_DOWNSHIFT_DESKTOP;
      const isFocusBody = bodyId === closeUpBodyIdRef.current;
      let resolution = shouldRender
        ? pickSurfaceTextureResolution(diameterPx, shouldPreferUltra(bodyId), lastResolution, upshift, downshift)
        : null;
      if (!resolution && isFocusBody && shouldRender) {
        resolution = lastResolution ?? SURFACE_TEXTURE_MIN_RESOLUTION;
      }
      if (resolution && isFocusBody && resolution.width > SURFACE_TEXTURE_BASELINE_RESOLUTION.width && (!isIdle || isWarmup)) {
        if (lastResolution && lastResolution.width > SURFACE_TEXTURE_BASELINE_RESOLUTION.width) {
          resolution = lastResolution;
        } else {
          resolution = SURFACE_TEXTURE_BASELINE_RESOLUTION;
        }
      }
      if (resolution && !isFocusBody && resolution.width > SURFACE_TEXTURE_MIN_RESOLUTION.width) {
        resolution = SURFACE_TEXTURE_MIN_RESOLUTION;
      }
      if (resolution) {
        lastResolutionByBodyIdRef.current.set(bodyId, resolution);
      } else {
        lastResolutionByBodyIdRef.current.delete(bodyId);
      }
      if (!resolution) {
        desiredKeyByBodyIdRef.current.set(bodyId, null);
        const material = resolveMaterial(bodyId);
        if (!isOnScreen && !isWarmup && material && material.userData.surfaceTextureKey) {
          clearTextureFromMaterial(material);
        }
        return;
      }

      const emissiveIntensity = !isGasGiant ? resolveCityLightsIntensity(diameterPx) : 0;
      const material = resolveMaterial(bodyId);
      if (material) {
        if (typeof material.userData.ownerTintStrength !== 'number') {
          material.userData.ownerTintStrength = OWNER_TINT_STRENGTH;
        }
        const ownerTint = ownerColorByBodyId[bodyId] ?? '#ffffff';
        if (material.userData.ownerTintColor !== ownerTint) {
          material.userData.ownerTintColor = ownerTint;
          const surfaceTint = typeof material.userData.surfaceTintColor === 'string'
            ? material.userData.surfaceTintColor
            : '#ffffff';
          const baseColor = typeof material.userData.baseColor === 'string'
            ? material.userData.baseColor
            : surfaceTint;
          applyOwnerTintColor(material, material.map ? surfaceTint : baseColor);
        }
        if (material.userData.surfaceEmissiveIntensity !== emissiveIntensity) {
          material.userData.surfaceEmissiveIntensity = emissiveIntensity;
          if (material.emissiveMap && material.emissiveIntensity !== emissiveIntensity) {
            material.emissiveIntensity = emissiveIntensity;
          }
        }
      }
      const activeKey = material?.userData.surfaceTextureKey;
      if (activeKey) {
        touchKey(activeKey);
      }

      const cloudShadow = !isGasGiant ? cloudShadowByBodyId.get(bodyId) ?? null : null;
      const shadowKey = cloudShadow
        ? [
            'shadow',
            cloudShadow.strength.toFixed(3),
            cloudShadow.threshold.toFixed(3),
            cloudShadow.softness.toFixed(3),
            cloudShadow.noiseScale.toFixed(2),
            cloudShadow.bandStrength.toFixed(3),
            cloudShadow.bandFrequency.toFixed(2),
            cloudShadow.bandOffset.toFixed(3),
            cloudShadow.seed.toString(10),
            cloudShadow.seed2.toString(10)
          ].join(':')
        : 'shadow:none';
      const hasHeavyMaps = Boolean(
        material?.normalMap || material?.aoMap || material?.displacementMap || material?.emissiveMap
      );
      const allowHeavyMaps = isFocusBody
        && !isWarmup
        && (isIdle || (hasHeavyMaps && lastResolution?.width === resolution.width));
      const wantsHeightMap = !isGasGiant
        && isOnScreen
        && resolution.width >= 512
        && allowHeavyMaps;
      const wantsEmissiveMap = !isGasGiant
        && isOnScreen
        && resolution.width >= SURFACE_TEXTURE_MIN_RESOLUTION.width
        && emissiveIntensity > 0
        && allowHeavyMaps;
      const textureSource = isGasGiant ? 'field' : (isFocusBody ? 'field' : 'tiles');
      const includeHeavyMaps = allowHeavyMaps;
      const textureOptionsForBody: SurfaceTextureOptions = {
        source: textureSource,
        includeNormalMap: includeHeavyMaps && resolution.width >= 512,
        includeAoMap: includeHeavyMaps && !isGasGiant && resolution.width >= 512,
        includeRoughnessMap: true,
        includeHeightMap: includeHeavyMaps && wantsHeightMap,
        includeEmissiveMap: includeHeavyMaps && wantsEmissiveMap
      };
      const optionsKey = buildTextureOptionsKey(textureOptionsForBody);
      const key = isGasGiant
        ? buildGasGiantTextureKey(bodyId, planetType, resolution, textureOptionsForBody)
        : `${buildTextureKey(bodyId, descriptor as PlanetSurfaceDescriptor, resolution)}|${shadowKey}|${optionsKey}`;
      desiredKeyByBodyIdRef.current.set(bodyId, key);
      touchKey(key);

      const cachedBundle = cacheRef.current.get(key) ?? null;
      if (material && cachedBundle) {
        applyTextureToMaterial(material, key, cachedBundle);
      }

      if (cachedBundle) return;
      if (isGasGiant) {
        const bundle = buildGasGiantBundle(bodyId, planetType, resolution, textureOptionsForBody);
        cacheRef.current.set(key, bundle);
        cacheLastUsedRef.current.set(key, performance.now());
        const desiredKey = desiredKeyByBodyIdRef.current.get(bodyId);
        if (desiredKey !== key) return;
        const mat = resolveMaterial(bodyId);
        if (!mat) return;
        applyTextureToMaterial(mat, key, bundle);
        return;
      }

      if (inFlightRef.current.has(key)) return;
      if (inFlightRef.current.size >= maxInflight) return;

      const state = requestStateRef.current;
      if (!state) return;
      const workerRequest = buildSurfaceMapWorkerRequest(state, bodyId, {
        hasAtmosphere,
        isMoon,
        planetType
      });
      if (!workerRequest) return;
      if (cloudShadow) {
        workerRequest.cloudShadow = cloudShadow;
      }
      if (textureOptionsForBody) {
        workerRequest.textureOptions = textureOptionsForBody;
      }
      const workers = workerPoolRef.current;
      if (!workers.length) return;
      const worker = workers[workerIndexRef.current % workers.length];
      workerIndexRef.current = (workerIndexRef.current + 1) % workers.length;

      const requestEpoch = requestEpochRef.current;
      inFlightRef.current.set(key, { bodyId, epoch: requestEpoch });
      worker.requestSurfaceTexture(workerRequest, resolution)
        .then((result: SurfaceTextureResult | null) => {
          inFlightRef.current.delete(key);
          if (!result) return;
          if (requestEpoch !== requestEpochRef.current) return;

          const colorTexture = createDataTexture(result.rgba, result.width, result.height, true);
          const normalTexture = result.normalRgba
            ? createDataTexture(result.normalRgba, result.width, result.height, false)
            : null;
          const aoTexture = result.aoRgba
            ? createDataTexture(result.aoRgba, result.width, result.height, false)
            : null;
          const roughnessTexture = result.roughnessRgba
            ? createDataTexture(result.roughnessRgba, result.width, result.height, false)
            : null;
          const heightTexture = result.heightRgba
            ? createDataTexture(result.heightRgba, result.width, result.height, false)
            : null;
          const emissiveTexture = result.emissiveRgba
            ? createDataTexture(result.emissiveRgba, result.width, result.height, true)
            : null;
          const bundle = {
            color: colorTexture,
            normal: normalTexture,
            ao: aoTexture,
            roughness: roughnessTexture,
            height: heightTexture,
            emissive: emissiveTexture
          };

          cacheRef.current.set(key, bundle);
          cacheLastUsedRef.current.set(key, performance.now());

          const desiredKey = desiredKeyByBodyIdRef.current.get(bodyId);
          if (desiredKey !== key) return;
          const mat = resolveMaterial(bodyId);
          if (!mat) return;
          applyTextureToMaterial(mat, key, bundle);
        })
        .catch(() => {
          inFlightRef.current.delete(key);
        });
    };

    const visibleEntries = Array.from(bodyMetricsById.entries())
      .filter(([, metrics]) => metrics.isOnScreen);
    // Manual stable sort to avoid in-place .sort() lint rule.
    for (let i = 1; i < visibleEntries.length; i += 1) {
      const entry = visibleEntries[i];
      let j = i - 1;
      while (j >= 0 && visibleEntries[j][1].diameterPx < entry[1].diameterPx) {
        visibleEntries[j + 1] = visibleEntries[j];
        j -= 1;
      }
      visibleEntries[j + 1] = entry;
    }
    const visibleBodies = visibleEntries.map(([bodyId]) => bodyId);

    visibleBodies.forEach((bodyId) => {
      const material = resolveMaterial(bodyId);
      const activeKey = material?.userData.surfaceTextureKey;
      if (activeKey) {
        touchKey(activeKey);
      }
    });

    const updateQueue: string[] = [];
    const queued = new Set<string>();
    const pushVisible = (bodyId: string | null) => {
      if (!bodyId) return;
      if (queued.has(bodyId)) return;
      const metrics = bodyMetricsById.get(bodyId);
      if (!metrics || !metrics.isOnScreen) return;
      queued.add(bodyId);
      updateQueue.push(bodyId);
    };
    const pushWarmup = (bodyId: string) => {
      if (queued.has(bodyId)) return;
      if (!bodyMetricsById.has(bodyId)) return;
      queued.add(bodyId);
      updateQueue.push(bodyId);
    };

    pushVisible(resolvedCloseUpBodyId);
    pushVisible(selectedBodyId);

    if (warmupTargetsRef.current.size) {
      const expired: string[] = [];
      warmupTargetsRef.current.forEach((expiresAt, bodyId) => {
        if (expiresAt <= now) {
          expired.push(bodyId);
          return;
        }
        pushWarmup(bodyId);
      });
      expired.forEach(bodyId => warmupTargetsRef.current.delete(bodyId));
    }

    const rotationStart = visibleBodies.length ? (updateCursorRef.current % visibleBodies.length) : 0;
    const rotatedBodies = visibleBodies.length
      ? visibleBodies.slice(rotationStart).concat(visibleBodies.slice(0, rotationStart))
      : [];
    rotatedBodies.forEach(bodyId => pushVisible(bodyId));

    let remainingUpdates = MAX_BODY_UPDATES_PER_FRAME;
    for (const bodyId of updateQueue) {
      if (remainingUpdates <= 0) break;
      updateBody(bodyId);
      remainingUpdates -= 1;
    }

    if (visibleBodies.length) {
      updateCursorRef.current = (rotationStart + MAX_BODY_UPDATES_PER_FRAME) % visibleBodies.length;
    }

    if (cacheRef.current.size <= maxCacheEntries) return;

    const keys = Array.from(cacheRef.current.keys());
    // Manual stable sort to avoid in-place .sort() lint rule.
    for (let i = 1; i < keys.length; i += 1) {
      const key = keys[i];
      const keyUsed = cacheLastUsedRef.current.get(key) ?? 0;
      let j = i - 1;
      while (j >= 0 && (cacheLastUsedRef.current.get(keys[j]) ?? 0) > keyUsed) {
        keys[j + 1] = keys[j];
        j -= 1;
      }
      keys[j + 1] = key;
    }

    for (const key of keys) {
      if (cacheRef.current.size <= maxCacheEntries) break;
      if (activeKeys.has(key)) continue;
      if (inFlightRef.current.has(key)) continue;
      const bundle = cacheRef.current.get(key);
      if (!bundle) continue;
      cacheRef.current.delete(key);
      cacheLastUsedRef.current.delete(key);
      disposeTextureBundle(bundle);
    }

    if (debugEnabled && onDebugUpdate) {
      const lastUpdate = lastDebugUpdateRef.current;
      if (now - lastUpdate > 250) {
        const activeBodies: SurfaceTextureDebugInfo['activeBodies'] = [];
        bodyMetricsById.forEach((metrics, bodyId) => {
          if (!metrics.isOnScreen) return;
          activeBodies.push({
            bodyId,
            diameterPx: metrics.diameterPx,
            resolution: lastResolutionByBodyIdRef.current.get(bodyId) ?? null,
            isOnScreen: metrics.isOnScreen
          });
        });
        for (let i = 1; i < activeBodies.length; i += 1) {
          const entry = activeBodies[i];
          let j = i - 1;
          while (j >= 0 && activeBodies[j].diameterPx < entry.diameterPx) {
            activeBodies[j + 1] = activeBodies[j];
            j -= 1;
          }
          activeBodies[j + 1] = entry;
        }
        onDebugUpdate({
          cacheSize: cacheRef.current.size,
          inflightSize: inFlightRef.current.size,
          activeBodies
        });
        lastDebugUpdateRef.current = now;
      }
    }
  });

  return null;
};
