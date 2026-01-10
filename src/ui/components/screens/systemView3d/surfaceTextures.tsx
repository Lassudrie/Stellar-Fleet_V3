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
import { ATMOSPHERE_STYLE, resolveAirMassIndex } from './atmosphere';
import { PLANET_TYPE_COLORS, SURFACE_DISPLACEMENT_BIAS, SURFACE_DISPLACEMENT_SCALE } from './config';
import { createSeededRandom, linearToSrgbByte, smoothstep } from './renderUtils';
import type { OrbitingPlanet } from './systemModel';

const SURFACE_TEXTURE_MIN_DIAMETER_PX = 120;
const SURFACE_TEXTURE_MED_DIAMETER_PX = 220;
const SURFACE_TEXTURE_HIGH_DIAMETER_PX = 420;
const SURFACE_TEXTURE_ULTRA_DIAMETER_PX = 820;
const SURFACE_TEXTURE_UPSHIFT = 1.18;
const SURFACE_TEXTURE_DOWNSHIFT = 0.84;
const SURFACE_TEXTURE_MAX_CACHE_ENTRIES = 12;
const SURFACE_TEXTURE_MAX_INFLIGHT = 2;
const SURFACE_MIPMAP_ANISOTROPY_DESKTOP = 8;
const SURFACE_MIPMAP_ANISOTROPY_MOBILE = 4;

type SurfaceTextureResolution = { width: number; height: number };

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
  lastResolution: SurfaceTextureResolution | null
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
    const upThreshold = SURFACE_TEXTURE_RESOLUTIONS[upIndex].minDiameter * SURFACE_TEXTURE_UPSHIFT;
    const downThreshold = SURFACE_TEXTURE_RESOLUTIONS[lastIndex].minDiameter * SURFACE_TEXTURE_DOWNSHIFT;
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
): { color: Uint8Array; roughness: Uint8Array } => {
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

      const roughNoise = Math.sin(uAngle * (lonFreq * 0.7) + lat * 1.7) * 0.05;
      const rough = MathUtils.clamp(roughBase + (0.5 - band) * roughVar + roughNoise, 0.2, 0.95);
      const roughByte = Math.round(rough * 255);
      roughness[idx] = roughByte;
      roughness[idx + 1] = roughByte;
      roughness[idx + 2] = roughByte;
      roughness[idx + 3] = 255;
    }
  }

  return { color, roughness };
};

export const SystemSurfaceTextureManager: React.FC<{
  starSystem: StarSystem;
  astroKey: string;
  planetSurfaceDescriptorsByBodyId?: Record<string, PlanetSurfaceDescriptor>;
  ownerKeyByBodyId: Record<string, string>;
  planets: OrbitingPlanet[];
  bodyWorldPositions: Record<string, [number, number, number]>;
  bodyRadii: Record<string, number>;
  selectedBodyId: string | null;
  hoveredBodyId: string | null;
  lowSpec: boolean;
  cloudShadowStrengthScale: number;
  resolveMaterial: (bodyId: string) => MeshStandardMaterial | null;
}> = ({
  starSystem,
  astroKey,
  planetSurfaceDescriptorsByBodyId,
  ownerKeyByBodyId,
  planets,
  bodyWorldPositions,
  bodyRadii,
  selectedBodyId,
  hoveredBodyId,
  lowSpec,
  cloudShadowStrengthScale,
  resolveMaterial
}) => {
  const { camera, gl, size } = useThree();
  const workerRef = useRef<SurfaceMapWorkerClient | null>(null);
  type SurfaceTextureBundle = {
    color: DataTexture;
    normal: DataTexture | null;
    ao: DataTexture | null;
    roughness: DataTexture | null;
    height: DataTexture | null;
  };
  const cacheRef = useRef<Map<string, SurfaceTextureBundle>>(new Map());
  const cacheLastUsedRef = useRef<Map<string, number>>(new Map());
  const inFlightRef = useRef<Map<string, { bodyId: string; epoch: number }>>(new Map());
  const desiredKeyByBodyIdRef = useRef<Map<string, string | null>>(new Map());
  const lastResolutionByBodyIdRef = useRef<Map<string, SurfaceTextureResolution>>(new Map());
  const requestStateRef = useRef<GameState | null>(null);
  const requestEpochRef = useRef(0);
  const planetsRef = useRef(planets);
  const maxCacheEntries = lowSpec ? 4 : SURFACE_TEXTURE_MAX_CACHE_ENTRIES;
  const maxInflight = lowSpec ? 1 : SURFACE_TEXTURE_MAX_INFLIGHT;
  const baseTextureOptions = useMemo<SurfaceTextureOptions | null>(() => (
    lowSpec
      ? {
        includeNormalMap: false,
        includeAoMap: false,
        includeRoughnessMap: false,
        includeHeightMap: false
      }
      : null
  ), [lowSpec]);
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
    const maxSurfaceAnisotropy = lowSpec ? SURFACE_MIPMAP_ANISOTROPY_MOBILE : SURFACE_MIPMAP_ANISOTROPY_DESKTOP;
    texture.minFilter = useMipmaps ? LinearMipmapLinearFilter : LinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = useMipmaps;
    texture.anisotropy = useMipmaps ? Math.min(maxSurfaceAnisotropy, Math.max(1, maxAnisotropy)) : 1;
    texture.flipY = true;
    texture.needsUpdate = true;
    return texture;
  }, [lowSpec, maxAnisotropy]);

  const cloudShadowByBodyId = useMemo(() => {
    const map = new Map<string, CloudShadowSettings>();
    if (cloudShadowStrengthScale <= 0 || lowSpec) return map;

    const addShadow = (
      body: { id: string; atmosphere?: AtmosphereType; airMassIndex?: number; pressureBar?: number; temperatureK?: number },
      isSolid: boolean
    ) => {
      if (!isSolid) return;
      const atmosphere = body.atmosphere;
      if (!atmosphere || atmosphere === 'None') return;

      const style = ATMOSPHERE_STYLE[atmosphere];
      const cloudStyle = style.clouds;
      if (!cloudStyle) return;

      const airMass = resolveAirMassIndex(body.airMassIndex, body.pressureBar, atmosphere);
      const temperatureK = typeof body.temperatureK === 'number' && Number.isFinite(body.temperatureK)
        ? body.temperatureK
        : (atmosphere === 'H2He' ? 140 : 288);

      let cloudiness = 0;
      switch (atmosphere) {
        case 'Earthlike': {
          const tempSuitability = MathUtils.clamp(1 - Math.abs(temperatureK - 288) / 170, 0, 1);
          cloudiness = MathUtils.clamp(0.15 + airMass * 0.75 * tempSuitability, 0, 1);
          break;
        }
        case 'CO2': {
          cloudiness = MathUtils.clamp(0.1 + airMass * 0.65, 0, 1);
          break;
        }
        case 'H2He': {
          cloudiness = MathUtils.clamp(0.6 + airMass * 0.4, 0, 1);
          break;
        }
        default:
          cloudiness = 0;
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
  }, [cloudShadowStrengthScale, lowSpec, planets]);

  useEffect(() => {
    requestStateRef.current = ({
      systems: [starSystem],
      planetSurfaceDescriptorsByBodyId
    } as unknown as GameState);
  }, [planetSurfaceDescriptorsByBodyId, starSystem]);

  useEffect(() => {
    planetsRef.current = planets;
  }, [planets]);

  const disposeTextureBundle = useCallback((bundle: SurfaceTextureBundle) => {
    bundle.color.dispose();
    bundle.normal?.dispose();
    bundle.ao?.dispose();
    bundle.roughness?.dispose();
    bundle.height?.dispose();
  }, []);

  useEffect(() => {
    workerRef.current = new SurfaceMapWorkerClient();
    return () => {
      workerRef.current?.dispose();
      workerRef.current = null;
      cacheRef.current.forEach(bundle => disposeTextureBundle(bundle));
      cacheRef.current.clear();
      cacheLastUsedRef.current.clear();
      inFlightRef.current.clear();
      desiredKeyByBodyIdRef.current.clear();
    };
  }, [disposeTextureBundle]);

  const buildTextureKey = useCallback((bodyId: string, descriptor: PlanetSurfaceDescriptor, resolution: SurfaceTextureResolution): string => {
    const config = descriptor.config;
    const ownerKey = ownerKeyByBodyId[bodyId] ?? '__neutral__';
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
      ownerKey,
      resolution.width,
      resolution.height
    ].join('|');
  }, [astroKey, ownerKeyByBodyId]);
  const buildTextureOptionsKey = useCallback((options: SurfaceTextureOptions | null): string => {
    const includeNormalMap = options?.includeNormalMap ?? true;
    const includeAoMap = options?.includeAoMap ?? true;
    const includeRoughnessMap = options?.includeRoughnessMap ?? true;
    const includeHeightMap = options?.includeHeightMap ?? false;
    return `maps:n${includeNormalMap ? 1 : 0}a${includeAoMap ? 1 : 0}r${includeRoughnessMap ? 1 : 0}h${includeHeightMap ? 1 : 0}`;
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
    return {
      color: colorTexture,
      normal: null,
      ao: null,
      roughness: roughnessTexture,
      height: null
    };
  }, [astroKey, createDataTexture]);

  const applyTextureToMaterial = useCallback((material: MeshStandardMaterial, key: string, bundle: SurfaceTextureBundle) => {
    let needsUpdate = false;
    if (material.map !== bundle.color) {
      material.map = bundle.color;
      const surfaceTint = typeof material.userData.surfaceTintColor === 'string'
        ? material.userData.surfaceTintColor
        : '#ffffff';
      material.color.set(surfaceTint);
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
    if (needsUpdate) {
      material.needsUpdate = true;
    }
    material.userData.surfaceTextureKey = key;
    material.userData.surfaceNormalTextureKey = nextNormal ? key : null;
    material.userData.surfaceAoTextureKey = nextAo ? key : null;
    material.userData.surfaceRoughnessTextureKey = nextRoughness ? key : null;
    material.userData.surfaceHeightTextureKey = nextHeight ? key : null;
  }, []);

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
      material.color.set(baseColor);
    }
    const baseRoughness = typeof material.userData.baseRoughness === 'number' ? material.userData.baseRoughness : null;
    if (typeof baseRoughness === 'number') {
      material.roughness = baseRoughness;
    }
    material.userData.surfaceTextureKey = null;
    material.userData.surfaceNormalTextureKey = null;
    material.userData.surfaceAoTextureKey = null;
    material.userData.surfaceRoughnessTextureKey = null;
    material.userData.surfaceHeightTextureKey = null;
  }, []);

  useEffect(() => {
    requestEpochRef.current += 1;
    cacheRef.current.forEach(bundle => disposeTextureBundle(bundle));
    cacheRef.current.clear();
    cacheLastUsedRef.current.clear();
    inFlightRef.current.clear();
    desiredKeyByBodyIdRef.current.clear();
    lastResolutionByBodyIdRef.current.clear();

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
  }, [astroKey, clearTextureFromMaterial, disposeTextureBundle, lowSpec, resolveMaterial]);

  useFrame(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    if (!planetSurfaceDescriptorsByBodyId) {
      const hasGasGiant = planets.some(planet => planet.type === 'GasGiant' || planet.type === 'IceGiant');
      if (!hasGasGiant) return;
    }

    camera.updateMatrixWorld();

    const now = performance.now();
    const activeKeys = new Set<string>();

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

    const shouldForceLowRes = (bodyId: string) => bodyId === selectedBodyId || bodyId === hoveredBodyId;
    const bodyMetricsById = new Map<string, { diameterPx: number; isOnScreen: boolean }>();
    const bodyInfoById = new Map<string, { isSolid: boolean; isGasGiant: boolean; planetType: PlanetType | null }>();
    let closeUpBodyId: string | null = null;
    let closeUpDiameter = 0;

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

      const diameterPx = isOnScreen ? pixelRadius * 2 : 0;
      bodyMetricsById.set(bodyId, { diameterPx, isOnScreen });

      if (isOnScreen && diameterPx >= SURFACE_TEXTURE_ULTRA_DIAMETER_PX && diameterPx > closeUpDiameter) {
        closeUpDiameter = diameterPx;
        closeUpBodyId = bodyId;
      }
    };

    planets.forEach((planet) => {
      const isGasGiant = planet.type === 'GasGiant' || planet.type === 'IceGiant';
      const isSolid = planet.isSolid ?? true;
      bodyInfoById.set(planet.id, { isSolid, isGasGiant, planetType: planet.type });
      const planetHasDescriptor = Boolean(planetSurfaceDescriptorsByBodyId?.[planet.id]);
      recordBodyMetrics(planet.id, isGasGiant || (isSolid && planetHasDescriptor));
      planet.moons.forEach((moon) => {
        const moonSolid = moon.isSolid ?? true;
        bodyInfoById.set(moon.id, { isSolid: moonSolid, isGasGiant: false, planetType: null });
        const moonHasDescriptor = Boolean(planetSurfaceDescriptorsByBodyId?.[moon.id]);
        recordBodyMetrics(moon.id, moonSolid && moonHasDescriptor);
      });
    });

    const preferUltraBodyId = selectedBodyId ?? closeUpBodyId;
    const shouldPreferUltra = (bodyId: string) => !lowSpec && bodyId === preferUltraBodyId;

    const touchKey = (key: string) => {
      cacheLastUsedRef.current.set(key, now);
      activeKeys.add(key);
    };

    const updateBody = (bodyId: string) => {
      const bodyInfo = bodyInfoById.get(bodyId);
      if (!bodyInfo) return;
      const { isSolid, isGasGiant, planetType } = bodyInfo;
      const descriptor = planetSurfaceDescriptorsByBodyId?.[bodyId];
      if (!descriptor && !isGasGiant) return;
      if (!isSolid && !isGasGiant) return;

      const metrics = bodyMetricsById.get(bodyId);
      if (!metrics) return;
      const { diameterPx, isOnScreen } = metrics;

      const lastResolution = lastResolutionByBodyIdRef.current.get(bodyId) ?? null;
      let resolution = isOnScreen
        ? pickSurfaceTextureResolution(diameterPx, shouldPreferUltra(bodyId), lastResolution)
        : null;
      if (!resolution && shouldForceLowRes(bodyId)) {
        resolution = lastResolution ?? SURFACE_TEXTURE_RESOLUTIONS[0];
      }
      if (lowSpec && resolution && resolution.width > 1024) {
        resolution = { width: 1024, height: 512 };
      }
      if (resolution) {
        lastResolutionByBodyIdRef.current.set(bodyId, resolution);
      } else {
        lastResolutionByBodyIdRef.current.delete(bodyId);
      }
      if (!resolution) {
        desiredKeyByBodyIdRef.current.set(bodyId, null);
        const material = resolveMaterial(bodyId);
        if (!isOnScreen && material && material.userData.surfaceTextureKey) {
          clearTextureFromMaterial(material);
        }
        return;
      }

      const material = resolveMaterial(bodyId);
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
      const wantsHeightMap = !lowSpec && !isGasGiant && isOnScreen && resolution.width >= 512;
      const textureOptionsForBody = wantsHeightMap ? { includeHeightMap: true } : baseTextureOptions;
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
      const workerRequest = buildSurfaceMapWorkerRequest(state, bodyId);
      if (!workerRequest) return;
      if (cloudShadow) {
        workerRequest.cloudShadow = cloudShadow;
      }
      if (textureOptionsForBody) {
        workerRequest.textureOptions = textureOptionsForBody;
      }
      if (lowSpec) {
        workerRequest.allowSync = false;
      }
      const worker = workerRef.current;
      if (!worker) return;

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
          const bundle = {
            color: colorTexture,
            normal: normalTexture,
            ao: aoTexture,
            roughness: roughnessTexture,
            height: heightTexture
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

    planets.forEach((planet) => {
      updateBody(planet.id);
      planet.moons.forEach(moon => updateBody(moon.id));
    });

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
  });

  return null;
};
