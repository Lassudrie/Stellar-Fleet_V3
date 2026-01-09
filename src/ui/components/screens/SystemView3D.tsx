import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Billboard, OrbitControls, Text } from '@react-three/drei';
import { Bloom, EffectComposer, SMAA, Vignette } from '@react-three/postprocessing';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import {
  AdditiveBlending,
  ACESFilmicToneMapping,
  BackSide,
  BufferAttribute,
  Camera,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  ConeGeometry,
  PCFSoftShadowMap,
  CylinderGeometry,
  DirectionalLight,
  DataTexture,
  Euler,
  FrontSide,
  Group,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Material,
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Mesh,
  NormalBlending,
  Object3D,
  PerspectiveCamera,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  ShadowMaterial,
  Spherical,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3
} from 'three';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import {
  AtmosphereType,
  FactionState,
  Fleet,
  GameState,
  MoonData,
  MoonType,
  PlanetData,
  PlanetType,
  PlanetBodyType,
  PlanetBody,
  PlanetSurfaceDescriptor,
  Station,
  StarData,
  StarOrbit,
  StarSystem,
  StarSystemAstro
} from '../../../shared/shared';
import { calculateFleetPower } from '../../../engine/world';
import { shortId, sorted } from '../../../shared/shared';
import { useI18n } from '../../i18n';
import { useFleetName } from '../../context/FleetNames';
import SystemBodyInfoPanel, { SystemBodyInfo } from '../ui/SystemBodyInfoPanel';
import SystemFleetInfoPanel from '../ui/SystemFleetInfoPanel';
import SystemStationInfoPanel from '../ui/SystemStationInfoPanel';
import {
  getSystemFleets,
  hashStringToAngle,
  hashStringToUnit,
  layoutTacticalRing,
  makeObjectId,
  parseObjectId,
  type TacticalRingConfig,
  type SystemObjectId
} from './systemViewLayout';
import { SurfaceMapWorkerClient, buildSurfaceMapWorkerRequest, type CloudShadowSettings, type SurfaceTextureResult } from '../../workers';

interface SystemView3DProps {
  starSystem: StarSystem;
  astro?: StarSystemAstro;
  fleets?: Fleet[];
  stations?: Station[];
  factions?: FactionState[];
  playerFactionId?: string;
  planetSurfaceDescriptorsByBodyId?: GameState['planetSurfaceDescriptorsByBodyId'];
  day?: number;
  selectedFleetId?: string | null;
  onSelectFleet?: (fleetId: string | null) => void;
  onInspectFleet?: (fleetId: string) => void;
  initialCameraState?: SystemCameraState;
  onCameraStateChange?: (state: SystemCameraState) => void;
  scaleFactor?: number;
  showBodyLabels?: boolean;
  onOpenSurfaceView?: (bodyId: string) => void;
}

const KM_PER_AU = 149_597_870.7;
const EARTH_RADIUS_KM = 6_371;
const SOLAR_RADIUS_KM = 695_700;
const KM_TO_SCENE_SCALE = 1 / 10_000_000;
const RADIUS_VISIBILITY_BONUS = 25;
const MIN_PLANET_RADIUS = 0.12;
const MIN_STAR_RADIUS = 0.5;
const ORBIT_THICKNESS = 0.012;
const DEFAULT_ORBIT_INNER_KM = 55_000_000;
const DEFAULT_ORBIT_STEP_KM = 35_000_000;
const STAR_TEXTURE_SIZE = 256;
const STARFIELD_TEXTURE_SIZE = 1024;
const STARFIELD_STAR_DENSITY = 0.0011;
const STARFIELD_NEBULA_LAYERS = 4;
const STARFIELD_EDGE_WRAP = 0.02;
const STARFIELD_BASE_COLOR = '#04060c';
const BODY_SPIN_SPEED_MIN = 0.0035;
const BODY_SPIN_SPEED_MAX = 0.011;
const CLOUD_SPIN_MULTIPLIER_MIN = 1.2;
const CLOUD_SPIN_MULTIPLIER_MAX = 1.6;
const CLOUD_NOISE_SPEED_MIN = 0.015;
const CLOUD_NOISE_SPEED_MAX = 0.045;
const LENS_FLARE_TEXTURE_SIZE = 128;
const LENS_FLARE_BASE_STRENGTH = 0.55;
const LENS_FLARE_CENTER_FADE_START = 0.08;
const LENS_FLARE_CENTER_FADE_END = 0.55;
const LENS_FLARE_INTENSITY_POWER = 2.4;
const LENS_FLARE_STAR_DIAMETER_MIN_PX = 8;
const LENS_FLARE_STAR_DIAMETER_FULL_PX = 48;
const LENS_FLARE_STAR_DIAMETER_FADE_OUT_START_PX = 380;
const LENS_FLARE_STAR_DIAMETER_FADE_OUT_END_PX = 720;
const LENS_FLARE_BASE_SIZE_MULTIPLIER = 2.0;
const LENS_FLARE_SIZE_MIN_PX = 18;
const LENS_FLARE_SIZE_MAX_PX = 220;
const STAR_TINT_STRENGTH = 0.18;
const STAR_FALLBACK_TINT_STRENGTH = 0.08;
const STAR_SURFACE_TINT_STRENGTH = 0.2;
const MIN_STAR_TEMPERATURE_K = 1000;
const MAX_STAR_TEMPERATURE_K = 40000;
const DAYS_PER_YEAR = 365.25;
const MIN_PLANET_ORBIT_INCLINATION_DEG = 0.35;
const MAX_PLANET_ORBIT_INCLINATION_DEG = 10;
const MIN_MOON_ORBIT_INCLINATION_DEG = 0.25;
const MAX_MOON_ORBIT_INCLINATION_DEG = 14;
const MAX_DPR_MOBILE = 1.25;
const MAX_DPR_DESKTOP = 2;
const SYSTEM_VIEW_CAMERA_MAX_DISTANCE_FACTOR = 5.5;
const SYSTEM_VIEW_CAMERA_MIN_DISTANCE_RADIUS_FACTOR = 1.06;

const PLANET_TYPE_COLORS: Record<PlanetType, string> = {
  Terrestrial: '#cbd5e1',
  SubNeptune: '#9ca3af',
  IceGiant: '#7dd3fc',
  GasGiant: '#fcd34d',
  Dwarf: '#e5e7eb'
};

const MOON_TYPE_COLORS: Record<MoonType, string> = {
  Regular: '#cbd5e1',
  Icy: '#e0f2fe',
  Volcanic: '#fb923c',
  Eden: '#86efac',
  Irregular: '#a5b4fc'
};

const SURFACE_TEXTURE_MIN_DIAMETER_PX = 120;
const SURFACE_TEXTURE_MED_DIAMETER_PX = 220;
const SURFACE_TEXTURE_HIGH_DIAMETER_PX = 420;
const SURFACE_TEXTURE_ULTRA_DIAMETER_PX = 820;
const SURFACE_NORMAL_SCALE = 0.85;
const SURFACE_AO_INTENSITY = 0.6;
const SURFACE_TEXTURE_MAX_CACHE_ENTRIES = 12;
const SURFACE_TEXTURE_MAX_INFLIGHT = 2;
const DAY_NIGHT_TERMINATOR_SOFTNESS = 0.22;
const DAY_NIGHT_NIGHT_MIN = 0.12;

type SurfaceTextureResolution = { width: number; height: number };

const pickSurfaceTextureResolution = (diameterPx: number, preferUltra: boolean): SurfaceTextureResolution | null => {
  if (!Number.isFinite(diameterPx) || diameterPx < SURFACE_TEXTURE_MIN_DIAMETER_PX) return null;
  if (preferUltra && diameterPx >= SURFACE_TEXTURE_ULTRA_DIAMETER_PX) return { width: 2048, height: 1024 };
  if (diameterPx >= SURFACE_TEXTURE_HIGH_DIAMETER_PX) return { width: 1024, height: 512 };
  if (diameterPx >= SURFACE_TEXTURE_MED_DIAMETER_PX) return { width: 512, height: 256 };
  return { width: 256, height: 128 };
};

const applyDayNightTerminator = (material: MeshStandardMaterial) => {
  if (material.userData.dayNightTerminatorApplied) return;
  material.userData.dayNightTerminatorApplied = true;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNightMin = { value: DAY_NIGHT_NIGHT_MIN };
    shader.uniforms.uTerminatorSoftness = { value: DAY_NIGHT_TERMINATOR_SOFTNESS };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;`
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 sfWorldPosition = modelMatrix * vec4(transformed, 1.0);
vWorldPosition = sfWorldPosition.xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
uniform float uNightMin;
uniform float uTerminatorSoftness;`
      )
      .replace(
        '#include <opaque_fragment>',
        `float sunDistance = length(vWorldPosition);
vec3 sunDir = sunDistance > 0.000001 ? (-vWorldPosition / sunDistance) : vec3(0.0, 0.0, 1.0);
float nDotL = dot(normalize(vWorldNormal), sunDir);
float terminator = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, nDotL);
float lightFactor = mix(uNightMin, 1.0, terminator);
outgoingLight *= lightFactor;
#include <opaque_fragment>`
      );
  };

  material.customProgramCacheKey = () => 'sf_day_night_terminator_v1';
  material.needsUpdate = true;
};

type OrbitingMoon = {
  id: string;
  radius: number;
  orbitRadius: number;
  orbitAngle: number;
  orbitInclinationDeg: number;
  orbitAscendingNodeDeg: number;
  type: MoonType;
  isSolid?: boolean;
  atmosphere?: AtmosphereType;
  airMassIndex?: number;
  pressureBar?: number;
  temperatureK?: number;
  gravityG?: number;
};

type OrbitingPlanet = {
  id: string;
  radius: number;
  orbitRadius: number;
  orbitAngle: number;
  orbitInclinationDeg: number;
  orbitAscendingNodeDeg: number;
  type: PlanetType;
  isSolid?: boolean;
  atmosphere?: AtmosphereType;
  airMassIndex?: number;
  pressureBar?: number;
  temperatureK?: number;
  gravityG?: number;
  moons: OrbitingMoon[];
};

type OrbitingStar = {
  id: string;
  data: StarData;
  radius: number;
  radiusKm: number;
  tintColor: string;
  surfaceTintColor: string;
  seedKey: string;
  position: [number, number, number];
};

type PlanetSource = (PlanetData & {
  id?: string;
  radiusKm?: number;
  semiMajorAxisKm?: number;
  planetType?: PlanetType;
  name?: string;
  habitabilityScore?: number;
  isSolid?: boolean;
}) | {
  id?: string;
  class?: string;
  size?: number;
  moons?: MoonData[];
  radiusKm?: number;
  semiMajorAxisKm?: number;
  orbitInclinationDeg?: number;
  orbitAscendingNodeDeg?: number;
  axialTiltDeg?: number;
  planetType?: PlanetType;
  name?: string;
  habitabilityScore?: number;
  isSolid?: boolean;
};

type MoonSource = MoonData & {
  radiusKm?: number;
  moonType?: MoonType;
  orbitDistanceKm?: number;
  habitabilityScore?: number;
  id?: string;
  name?: string;
  isSolid?: boolean;
};

type UseMemoDisposableDeps = React.DependencyList;

type CelestialBodyType = PlanetBodyType | 'star';

type BodyLabelTarget = {
  id: string;
  name: string;
  position: [number, number, number];
  radius: number;
  kind: 'planet' | 'moon';
  parent?: {
    position: [number, number, number];
    radius: number;
  };
};

type CameraSphericalState = {
  theta: number;
  phi: number;
  radius: number;
};

const useDisposableMemo = <T extends { dispose: () => void }>(
  factory: () => T,
  deps: UseMemoDisposableDeps
): T => {
  const resource = useMemo(factory, deps);
  useEffect(() => {
    return () => {
      resource.dispose();
    };
  }, [resource]);
  return resource;
};

const computeOrbitalPeriodDays = (semiMajorAxisAu: number, massSun: number): number => {
  const safeA = Math.max(semiMajorAxisAu, 0.01);
  const safeMass = Math.max(massSun, 0.1);
  const periodYears = Math.sqrt((safeA * safeA * safeA) / safeMass);
  return Math.max(periodYears * DAYS_PER_YEAR, 1);
};

const computeOrbitAngle = (baseAngle: number, periodDays: number, day: number): number => {
  if (!Number.isFinite(periodDays) || periodDays <= 0) return baseAngle;
  return MathUtils.euclideanModulo(baseAngle + (day * Math.PI * 2) / periodDays, Math.PI * 2);
};

const computeInclinedOrbitPosition = (
  radius: number,
  angle: number,
  inclinationDeg: number,
  ascendingNodeDeg: number
): [number, number, number] => {
  const inclination = MathUtils.degToRad(inclinationDeg);
  const ascendingNode = MathUtils.degToRad(ascendingNodeDeg);
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  const yInclined = z * Math.sin(inclination);
  const zInclined = z * Math.cos(inclination);
  const cosNode = Math.cos(ascendingNode);
  const sinNode = Math.sin(ascendingNode);
  return [
    x * cosNode - zInclined * sinNode,
    yInclined,
    x * sinNode + zInclined * cosNode
  ];
};

const createFallbackStarOrbit = (seedKey: string, index: number, primaryMassSun: number): StarOrbit => {
  const baseAu = 0.4 + index * 0.6;
  const periodDays = computeOrbitalPeriodDays(baseAu, primaryMassSun);
  return {
    semiMajorAxisAu: baseAu,
    periodDays,
    phaseDeg: hashStringToUnit(`${seedKey}-phase`) * 360,
    inclinationDeg: hashStringToUnit(`${seedKey}-inclination`) * 12,
    ascendingNodeDeg: hashStringToUnit(`${seedKey}-node`) * 360
  };
};

const SPECTRAL_TINTS: Record<string, string> = {
  O: '#9bb0ff',
  B: '#aabfff',
  A: '#cad7ff',
  F: '#f8f7ff',
  G: '#fff1d6',
  K: '#ffd2a1',
  M: '#ffcc6f'
};

const getSpectralTint = (spectralType: string | undefined, fallback?: string): string => {
  const key = spectralType?.trim().charAt(0).toUpperCase();
  const tint = key ? SPECTRAL_TINTS[key] : undefined;
  const base = new Color('#ffffff');
  if (tint) {
    return base.clone().lerp(new Color(tint), STAR_TINT_STRENGTH).getStyle();
  }
  if (fallback) {
    return base.clone().lerp(new Color(fallback), STAR_FALLBACK_TINT_STRENGTH).getStyle();
  }
  return base.getStyle();
};

const temperatureToColor = (temperatureK: number | undefined): Color | null => {
  if (!Number.isFinite(temperatureK)) return null;
  const clampedK = MathUtils.clamp(temperatureK, MIN_STAR_TEMPERATURE_K, MAX_STAR_TEMPERATURE_K);
  const temp = clampedK / 100;
  let red = 255;
  let green = 0;
  let blue = 255;

  if (temp <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temp) - 161.1195681661;
    blue = temp <= 19 ? 0 : 138.5177312231 * Math.log(temp - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
    green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
    blue = 255;
  }

  const clampChannel = (value: number) => MathUtils.clamp(value, 0, 255) / 255;
  return new Color(clampChannel(red), clampChannel(green), clampChannel(blue));
};

const getSurfaceTintFromTemperature = (temperatureK: number | undefined, fallback: string): string => {
  const tempColor = temperatureToColor(temperatureK);
  if (!tempColor) {
    return fallback;
  }
  return new Color('#ffffff').lerp(tempColor, STAR_SURFACE_TINT_STRENGTH).getStyle();
};

const createSeededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

const toRgbaString = (color: Color, alpha: number): string => {
  const r = Math.round(MathUtils.clamp(color.r, 0, 1) * 255);
  const g = Math.round(MathUtils.clamp(color.g, 0, 1) * 255);
  const b = Math.round(MathUtils.clamp(color.b, 0, 1) * 255);
  const a = MathUtils.clamp(alpha, 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const linearToSrgb = (value: number): number => {
  if (value <= 0.0031308) return 12.92 * value;
  return 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
};

const linearToSrgbByte = (value: number): number =>
  Math.round(MathUtils.clamp(linearToSrgb(value), 0, 1) * 255);

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
      const dy = v - vortexV;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < vortexRadius) {
        const swirl = Math.sin((dist / vortexRadius) * Math.PI * vortexTwist + uAngle * 2.3);
        band += swirl * (1 - dist / vortexRadius) * vortexStrength;
      }

      band = MathUtils.clamp(0.5 + (band - 0.5) * (1 + bandContrast * detailFactor), 0, 1);
      const highlight = MathUtils.clamp((band - 0.65) * 1.2, 0, 0.3);

      let r = MathUtils.lerp(dark.r, light.r, band);
      let g = MathUtils.lerp(dark.g, light.g, band);
      let b = MathUtils.lerp(dark.b, light.b, band);

      if (highlight > 0) {
        r = MathUtils.lerp(r, accent.r, highlight);
        g = MathUtils.lerp(g, accent.g, highlight);
        b = MathUtils.lerp(b, accent.b, highlight);
      }

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

const createStarSurfaceTexture = (surfaceTintColor: string, seed: number): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = STAR_TEXTURE_SIZE;
  canvas.height = STAR_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const base = new Color('#ffffff');
  const tint = new Color(surfaceTintColor).lerp(base, 0.6);
  const highlight = base.clone().lerp(tint, 0.25);
  const shadow = base.clone().lerp(tint, 0.2).multiplyScalar(0.9);

  context.fillStyle = base.getStyle();
  context.fillRect(0, 0, STAR_TEXTURE_SIZE, STAR_TEXTURE_SIZE);

  const gradient = context.createRadialGradient(
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.12,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.65
  );
  gradient.addColorStop(0, highlight.getStyle());
  gradient.addColorStop(1, shadow.getStyle());
  context.globalAlpha = 0.25;
  context.fillStyle = gradient;
  context.fillRect(0, 0, STAR_TEXTURE_SIZE, STAR_TEXTURE_SIZE);
  context.globalAlpha = 1;

  const rand = createSeededRandom(seed);
  const brightBlobs = 140;
  const darkBlobs = 180;

  for (let i = 0; i < brightBlobs; i += 1) {
    const radius = STAR_TEXTURE_SIZE * (0.04 + rand() * 0.12);
    const x = rand() * STAR_TEXTURE_SIZE;
    const y = rand() * STAR_TEXTURE_SIZE;
    const tintSpot = base.clone().lerp(tint, 0.15 + rand() * 0.45);
    context.globalAlpha = 0.08 + rand() * 0.18;
    context.fillStyle = tintSpot.getStyle();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  for (let i = 0; i < darkBlobs; i += 1) {
    const radius = STAR_TEXTURE_SIZE * (0.02 + rand() * 0.07);
    const x = rand() * STAR_TEXTURE_SIZE;
    const y = rand() * STAR_TEXTURE_SIZE;
    const shade = base.clone().lerp(tint, 0.35).multiplyScalar(0.6 + rand() * 0.25);
    context.globalAlpha = 0.1 + rand() * 0.2;
    context.fillStyle = shade.getStyle();
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  context.globalAlpha = 1;
  texture.needsUpdate = true;
  return texture;
};

const createStarfieldTexture = (seedKey: string, tintColor: string): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = STARFIELD_TEXTURE_SIZE;
  canvas.height = STARFIELD_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const size = STARFIELD_TEXTURE_SIZE;
  const seed = Math.floor(hashStringToUnit(seedKey) * 0xffffffff);
  const rand = createSeededRandom(seed);
  const base = new Color(STARFIELD_BASE_COLOR);
  const tint = new Color(tintColor).lerp(new Color('#0b1020'), 0.7);

  const gradient = context.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, base.clone().lerp(tint, 0.2).getStyle());
  gradient.addColorStop(0.55, base.getStyle());
  gradient.addColorStop(1, base.clone().lerp(tint, 0.35).getStyle());
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  context.globalCompositeOperation = 'screen';
  for (let i = 0; i < STARFIELD_NEBULA_LAYERS; i += 1) {
    const radius = size * (0.18 + rand() * 0.32);
    const x = rand() * size;
    const y = rand() * size;
    const strength = 0.04 + rand() * 0.07;
    const nebula = base.clone().lerp(tint, 0.35 + rand() * 0.45);
    const cloud = context.createRadialGradient(x, y, 0, x, y, radius);
    cloud.addColorStop(0, toRgbaString(nebula, strength));
    cloud.addColorStop(1, toRgbaString(nebula, 0));
    context.fillStyle = cloud;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  context.globalCompositeOperation = 'source-over';

  const starCount = Math.round(size * size * STARFIELD_STAR_DENSITY);
  const wrapMargin = size * STARFIELD_EDGE_WRAP;
  const baseStar = new Color('#ffffff');

  const drawStar = (x: number, y: number, radius: number, color: string) => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  };

  for (let i = 0; i < starCount; i += 1) {
    const x = rand() * size;
    const y = rand() * size;
    const isBright = rand() > 0.88;
    const radius = isBright ? 1 + rand() * 1.6 : 0.45 + rand() * 0.8;
    const alpha = isBright ? 0.55 + rand() * 0.3 : 0.15 + rand() * 0.35;
    const starColor = baseStar.clone().lerp(tint, rand() * 0.25);
    const color = toRgbaString(starColor, alpha);

    drawStar(x, y, radius, color);

    if (x < wrapMargin) drawStar(x + size, y, radius, color);
    if (x > size - wrapMargin) drawStar(x - size, y, radius, color);
    if (y < wrapMargin) drawStar(x, y + size, radius, color);
    if (y > size - wrapMargin) drawStar(x, y - size, radius, color);
    if (x < wrapMargin && y < wrapMargin) drawStar(x + size, y + size, radius, color);
    if (x < wrapMargin && y > size - wrapMargin) drawStar(x + size, y - size, radius, color);
    if (x > size - wrapMargin && y < wrapMargin) drawStar(x - size, y + size, radius, color);
    if (x > size - wrapMargin && y > size - wrapMargin) drawStar(x - size, y - size, radius, color);
  }

  texture.needsUpdate = true;
  return texture;
};

const createStarGlowTexture = (tintColor: string): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = STAR_TEXTURE_SIZE;
  canvas.height = STAR_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const base = new Color('#ffffff');
  const tint = new Color(tintColor).lerp(base, 0.55);
  const inner = base.clone().lerp(tint, 0.3);
  const outer = base.clone().lerp(tint, 0.4).multiplyScalar(0.55);
  const gradient = context.createRadialGradient(
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.06,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5,
    STAR_TEXTURE_SIZE * 0.5
  );
  gradient.addColorStop(0, toRgbaString(inner, 0.95));
  gradient.addColorStop(0.35, toRgbaString(base, 0.6));
  gradient.addColorStop(0.7, toRgbaString(outer, 0.25));
  gradient.addColorStop(1, toRgbaString(outer, 0));
  context.fillStyle = gradient;
  context.fillRect(0, 0, STAR_TEXTURE_SIZE, STAR_TEXTURE_SIZE);
  texture.needsUpdate = true;
  return texture;
};

const createLensFlareHaloTexture = (): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = LENS_FLARE_TEXTURE_SIZE;
  canvas.height = LENS_FLARE_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const center = LENS_FLARE_TEXTURE_SIZE * 0.5;
  const gradient = context.createRadialGradient(center, center, LENS_FLARE_TEXTURE_SIZE * 0.04, center, center, center);
  gradient.addColorStop(0, 'rgba(255, 255, 255, 0.75)');
  gradient.addColorStop(0.2, 'rgba(255, 255, 255, 0.28)');
  gradient.addColorStop(0.55, 'rgba(255, 255, 255, 0.1)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

  context.fillStyle = gradient;
  context.fillRect(0, 0, LENS_FLARE_TEXTURE_SIZE, LENS_FLARE_TEXTURE_SIZE);

  texture.needsUpdate = true;
  return texture;
};

const createLensFlareRingTexture = (): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = LENS_FLARE_TEXTURE_SIZE;
  canvas.height = LENS_FLARE_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const center = LENS_FLARE_TEXTURE_SIZE * 0.5;
  context.translate(center, center);
  context.globalCompositeOperation = 'lighter';

  context.strokeStyle = 'rgba(255, 255, 255, 0.38)';
  context.lineWidth = LENS_FLARE_TEXTURE_SIZE * 0.08;
  context.beginPath();
  context.arc(0, 0, LENS_FLARE_TEXTURE_SIZE * 0.22, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  context.lineWidth = LENS_FLARE_TEXTURE_SIZE * 0.028;
  context.beginPath();
  context.arc(0, 0, LENS_FLARE_TEXTURE_SIZE * 0.36, 0, Math.PI * 2);
  context.stroke();

  const haze = context.createRadialGradient(0, 0, 0, 0, 0, LENS_FLARE_TEXTURE_SIZE * 0.5);
  haze.addColorStop(0, 'rgba(255, 255, 255, 0)');
  haze.addColorStop(0.5, 'rgba(255, 255, 255, 0.06)');
  haze.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = haze;
  context.beginPath();
  context.arc(0, 0, LENS_FLARE_TEXTURE_SIZE * 0.5, 0, Math.PI * 2);
  context.fill();

  texture.needsUpdate = true;
  return texture;
};

const createLensFlareSparkTexture = (): CanvasTexture => {
  const canvas = document.createElement('canvas');
  canvas.width = LENS_FLARE_TEXTURE_SIZE;
  canvas.height = LENS_FLARE_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  if (!context) {
    return texture;
  }

  const center = LENS_FLARE_TEXTURE_SIZE * 0.5;
  const bloom = context.createRadialGradient(center, center, 0, center, center, center);
  bloom.addColorStop(0, 'rgba(255, 255, 255, 0.65)');
  bloom.addColorStop(0.18, 'rgba(255, 255, 255, 0.18)');
  bloom.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.fillStyle = bloom;
  context.fillRect(0, 0, LENS_FLARE_TEXTURE_SIZE, LENS_FLARE_TEXTURE_SIZE);

  context.globalCompositeOperation = 'lighter';
  context.fillStyle = 'rgba(255, 255, 255, 0.14)';
  const streakThickness = LENS_FLARE_TEXTURE_SIZE * 0.035;
  context.fillRect(center - streakThickness * 0.5, 0, streakThickness, LENS_FLARE_TEXTURE_SIZE);
  context.fillRect(0, center - streakThickness * 0.5, LENS_FLARE_TEXTURE_SIZE, streakThickness);

  texture.needsUpdate = true;
  return texture;
};

const MIN_POLAR_ANGLE = 0.15;
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;

const getPlanetRadiusKm = (planet: PlanetSource): number => {
  if (typeof planet.radiusKm === 'number') {
    return Math.max(planet.radiusKm, 0.1);
  }
  if ('radiusEarth' in planet && typeof planet.radiusEarth === 'number') {
    return Math.max(planet.radiusEarth, 0.1) * EARTH_RADIUS_KM;
  }
  if ('size' in planet && typeof planet.size === 'number') {
    return Math.max(planet.size, 0.1) * EARTH_RADIUS_KM;
  }
  return EARTH_RADIUS_KM;
};

const getPlanetType = (planet: PlanetSource): PlanetType => {
  if (planet.planetType) return planet.planetType;
  if ('type' in planet) return planet.type as PlanetType;
  const planetClass = 'class' in planet ? planet.class : undefined;
  if (planetClass === 'gas_giant') return 'GasGiant';
  if (planetClass === 'ice_giant') return 'IceGiant';
  return 'Terrestrial';
};

const getSemiMajorAxisKm = (planet: PlanetSource, index: number): number => {
  if (typeof planet.semiMajorAxisKm === 'number') {
    return planet.semiMajorAxisKm;
  }
  if ('semiMajorAxisAu' in planet && typeof planet.semiMajorAxisAu === 'number') {
    return planet.semiMajorAxisAu * KM_PER_AU;
  }
  return DEFAULT_ORBIT_INNER_KM + index * DEFAULT_ORBIT_STEP_KM;
};

const getPlanetOrbitInclinationDeg = (planetId: string): number => {
  const seed = hashStringToUnit(`${planetId}-inclination`);
  const eased = Math.pow(seed, 1.35);
  return MathUtils.lerp(MIN_PLANET_ORBIT_INCLINATION_DEG, MAX_PLANET_ORBIT_INCLINATION_DEG, eased);
};

const getPlanetOrbitAscendingNodeDeg = (planetId: string): number =>
  hashStringToUnit(`${planetId}-node`) * 360;

const getMoonOrbitInclinationDeg = (moonId: string): number => {
  const seed = hashStringToUnit(`${moonId}-inclination`);
  const eased = Math.pow(seed, 1.25);
  return MathUtils.lerp(MIN_MOON_ORBIT_INCLINATION_DEG, MAX_MOON_ORBIT_INCLINATION_DEG, eased);
};

const getMoonOrbitAscendingNodeDeg = (moonId: string): number =>
  hashStringToUnit(`${moonId}-node`) * 360;

const getMoonRadiusKm = (moon: MoonSource): number => {
  if (typeof moon.radiusKm === 'number') {
    return Math.max(moon.radiusKm, 0.01);
  }
  return Math.max(moon.radiusEarth, 0.05) * EARTH_RADIUS_KM;
};

const getMoonType = (moon: MoonSource): MoonType => moon.moonType ?? moon.type;

const getMoonOrbitKm = (moon: MoonSource, planetRadiusKm: number): number => {
  if (typeof moon.orbitDistanceKm === 'number') {
    return moon.orbitDistanceKm;
  }
  return moon.orbitDistanceRp * planetRadiusKm;
};

const clampPhi = (phi: number): number => MathUtils.clamp(phi, MIN_POLAR_ANGLE, MAX_POLAR_ANGLE);

const sphericalFromOffset = (offset: Vector3): CameraSphericalState => {
  const spherical = new Spherical().setFromVector3(offset);
  return {
    theta: spherical.theta,
    phi: clampPhi(spherical.phi),
    radius: Math.max(spherical.radius, 0.001)
  };
};

const deriveSphericalState = (
  state: SystemCameraState | undefined,
  anchoredTarget: [number, number, number],
  fallbackPosition: [number, number, number]
): CameraSphericalState => {
  if (state?.theta !== undefined && state?.phi !== undefined && state?.radius !== undefined) {
    return {
      theta: state.theta,
      phi: clampPhi(state.phi),
      radius: Math.max(state.radius, 0.001)
    };
  }

  const anchorTargetVec = new Vector3(...anchoredTarget);
  const positionVec = state?.position ? new Vector3(...state.position) : new Vector3(...fallbackPosition);
  const offset = positionVec.sub(anchorTargetVec);
  return sphericalFromOffset(offset);
};

const positionFromSpherical = (state: CameraSphericalState, target: [number, number, number]): [number, number, number] => {
  const targetVec = new Vector3(...target);
  const spherical = new Spherical(state.radius, clampPhi(state.phi), state.theta);
  const positionVec = new Vector3().setFromSpherical(spherical).add(targetVec);
  return [positionVec.x, positionVec.y, positionVec.z];
};

const buildPlanetModel = (
  planet: PlanetSource,
  index: number,
  _total: number,
  sceneScale: number,
  minPlanetRadius: number,
  minMoonRadius: number,
  orbitMassSun: number,
  day: number
): OrbitingPlanet => {
  const radiusKm = getPlanetRadiusKm(planet);
  const semiMajorAxisKm = getSemiMajorAxisKm(planet, index);
  const planetId = planet.id ?? `planet-${index + 1}`;
  const baseAngle = hashStringToAngle(planetId);
  const orbitPeriodDays = computeOrbitalPeriodDays(semiMajorAxisKm / KM_PER_AU, orbitMassSun);
  const orbitAngle = computeOrbitAngle(baseAngle, orbitPeriodDays, day);
  const orbitInclinationDeg = typeof planet.orbitInclinationDeg === 'number'
    ? planet.orbitInclinationDeg
    : getPlanetOrbitInclinationDeg(planetId);
  const orbitAscendingNodeDeg = typeof planet.orbitAscendingNodeDeg === 'number'
    ? planet.orbitAscendingNodeDeg
    : getPlanetOrbitAscendingNodeDeg(planetId);
  const orbitRadius = semiMajorAxisKm * sceneScale;
  const radius = Math.max(radiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minPlanetRadius);
  const planetType = getPlanetType(planet);
  const isSolid = (planet as { isSolid?: boolean }).isSolid ?? true;
  const planetData = planet as Partial<PlanetData>;
  const atmosphere = planetData.atmosphere;
  const airMassIndex = planetData.airMassIndex;
  const pressureBar = planetData.pressureBar;
  const temperatureK = planetData.temperatureK;
  const gravityG = planetData.gravityG;

  const moons = (planet.moons ?? []).map((moon, moonIndex) => {
    const moonRadiusKm = getMoonRadiusKm(moon as MoonSource);
    const moonOrbitKm = getMoonOrbitKm(moon as MoonSource, radiusKm);
    const moonOrbitRadius = moonOrbitKm * sceneScale;
    const moonAngle = (moonIndex / Math.max(planet.moons?.length ?? 1, 1)) * Math.PI * 2 + Math.PI / 4;
    const moonId = (moon as MoonSource).id ?? `${planetId}-moon-${moonIndex + 1}`;
    const moonInclinationDeg = typeof (moon as MoonSource).orbitInclinationDeg === 'number'
      ? (moon as MoonSource).orbitInclinationDeg
      : getMoonOrbitInclinationDeg(moonId);
    const moonAscendingNodeDeg = typeof (moon as MoonSource).orbitAscendingNodeDeg === 'number'
      ? (moon as MoonSource).orbitAscendingNodeDeg
      : getMoonOrbitAscendingNodeDeg(moonId);
    const moonData = moon as Partial<MoonData>;
    return {
      id: moonId,
      radius: Math.max(moonRadiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minMoonRadius),
      orbitRadius: moonOrbitRadius,
      orbitAngle: moonAngle,
      orbitInclinationDeg: moonInclinationDeg,
      orbitAscendingNodeDeg: moonAscendingNodeDeg,
      type: getMoonType(moon as MoonSource),
      isSolid: (moon as MoonSource).isSolid,
      atmosphere: (moon as MoonSource).atmosphere,
      airMassIndex: moonData.airMassIndex,
      pressureBar: moonData.pressureBar,
      temperatureK: moonData.temperatureK,
      gravityG: moonData.gravityG
    };
  });

  return {
    id: planetId,
    radius,
    orbitRadius,
    orbitAngle,
    orbitInclinationDeg,
    orbitAscendingNodeDeg,
    type: planetType,
    isSolid,
    atmosphere,
    airMassIndex,
    pressureBar,
    temperatureK,
    gravityG,
    moons
  };
};

const applyPlanetOrbitSpacing = (
  planets: OrbitingPlanet[],
  starRadius: number,
  planetOrbitClearance: number
): OrbitingPlanet[] => {
  const computePlanetFootprintRadius = (planet: OrbitingPlanet): number => {
    const moonExtent = planet.moons.reduce((max, moon) => {
      return Math.max(max, moon.orbitRadius + moon.radius);
    }, 0);
    return Math.max(planet.radius, moonExtent);
  };

  let lastOrbitRadius = starRadius;
  let lastFootprintRadius = 0;

  return planets.map((planet, index) => {
    const footprintRadius = computePlanetFootprintRadius(planet);
    const minimumDistanceFromStar = starRadius + footprintRadius + planetOrbitClearance;
    const minimumDistanceFromPrevious = index === 0
      ? minimumDistanceFromStar
      : lastOrbitRadius + lastFootprintRadius + footprintRadius + planetOrbitClearance;
    const adjustedOrbitRadius = Math.max(planet.orbitRadius, minimumDistanceFromPrevious);
    lastOrbitRadius = adjustedOrbitRadius;
    lastFootprintRadius = footprintRadius;
    return { ...planet, orbitRadius: adjustedOrbitRadius };
  });
};

const applyMoonOrbitSpacing = (
  moons: OrbitingMoon[],
  planetRadius: number,
  moonOrbitClearance: number
): OrbitingMoon[] => {
  let lastOrbitRadius = planetRadius;
  let lastMoonRadius = 0;

  return moons.map((moon, index) => {
    const minimumDistanceFromPlanet = planetRadius + moon.radius + moonOrbitClearance;
    const minimumDistanceFromPrevious = index === 0
      ? minimumDistanceFromPlanet
      : lastOrbitRadius + lastMoonRadius + moon.radius + moonOrbitClearance;
    const adjustedOrbitRadius = Math.max(moon.orbitRadius, minimumDistanceFromPrevious);
    lastOrbitRadius = adjustedOrbitRadius;
    lastMoonRadius = moon.radius;
    return { ...moon, orbitRadius: adjustedOrbitRadius };
  });
};

const SystemRoot: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <group name="SystemRoot">
    {children}
  </group>
);

type SystemStarfieldProps = {
  radius: number;
  seedKey: string;
  tintColor: string;
};

const SystemStarfield: React.FC<SystemStarfieldProps> = ({ radius, seedKey, tintColor }) => {
  const meshRef = useRef<Mesh>(null);
  const { camera } = useThree();
  const texture = useMemo(() => createStarfieldTexture(seedKey, tintColor), [seedKey, tintColor]);

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.position.copy(camera.position);
    }
  });

  useEffect(() => () => {
    texture.dispose();
  }, [texture]);

  return (
    <mesh ref={meshRef} frustumCulled={false} renderOrder={-20} raycast={() => null}>
      <sphereGeometry args={[radius, 48, 32]} />
      <meshBasicMaterial map={texture} side={BackSide} depthWrite={false} toneMapped={false} />
    </mesh>
  );
};

type SystemRimLightProps = {
  intensity: number;
  color: string;
  distance: number;
  target: [number, number, number];
};

const SystemRimLight: React.FC<SystemRimLightProps> = ({ intensity, color, distance, target }) => {
  const lightRef = useRef<DirectionalLight>(null);
  const targetObject = useMemo(() => new Object3D(), []);
  const { camera } = useThree();
  const targetVec = useMemo(() => new Vector3(), []);
  const viewDir = useMemo(() => new Vector3(), []);
  const rightDir = useMemo(() => new Vector3(), []);
  const upDir = useMemo(() => new Vector3(), []);

  useEffect(() => {
    if (lightRef.current) {
      lightRef.current.target = targetObject;
    }
  }, [targetObject]);

  useFrame(() => {
    const light = lightRef.current;
    if (!light) return;
    targetVec.set(target[0], target[1], target[2]);
    viewDir.copy(targetVec).sub(camera.position).normalize();
    rightDir.crossVectors(viewDir, camera.up).normalize();
    upDir.copy(camera.up).normalize();
    light.position
      .copy(targetVec)
      .addScaledVector(viewDir, distance)
      .addScaledVector(rightDir, distance * 0.08)
      .addScaledVector(upDir, distance * 0.04);
    targetObject.position.copy(targetVec);
    targetObject.updateMatrixWorld();
  });

  return (
    <>
      <directionalLight ref={lightRef} intensity={intensity} color={color} castShadow={false} />
      <primitive object={targetObject} raycast={() => null} />
    </>
  );
};

type FleetRingBaseOptions = {
  starRadius: number;
  focusDistanceFloor: number;
  planets: OrbitingPlanet[];
  safetyMargin: number;
  minimumOrbitClearance: number;
};

const computeFleetRingBaseRadius = ({
  starRadius,
  focusDistanceFloor,
  planets,
  safetyMargin,
  minimumOrbitClearance
}: FleetRingBaseOptions): number => {
  const minimumRadius = Math.max(starRadius + safetyMargin, focusDistanceFloor * 1.5);

  if (!planets.length) {
    return minimumRadius;
  }

  const closestPlanet = planets.reduce(
    (currentClosest, planet) => (planet.orbitRadius < currentClosest.orbitRadius ? planet : currentClosest),
    planets[0]
  );
  const innerOrbitLimit = closestPlanet.orbitRadius - closestPlanet.radius - minimumOrbitClearance;

  if (innerOrbitLimit >= minimumRadius) {
    return innerOrbitLimit;
  }

  const outerOrbitLimit = closestPlanet.orbitRadius + closestPlanet.radius + minimumOrbitClearance;
  return Math.max(outerOrbitLimit, minimumRadius);
};

interface StarMeshProps {
  radius: number;
  tintColor: string;
  surfaceTintColor: string;
  geometry: SphereGeometry;
  seedKey: string;
  enableLensFlare?: boolean;
  lensFlareStrength?: number;
  onDoubleClick?: (event: ThreeEvent<MouseEvent | PointerEvent>) => void;
  onHover?: () => void;
  onBlur?: () => void;
  onSelect?: () => void;
}

const StarMesh: React.FC<StarMeshProps> = ({
  radius,
  tintColor,
  surfaceTintColor,
  geometry,
  seedKey,
  enableLensFlare = true,
  lensFlareStrength = LENS_FLARE_BASE_STRENGTH,
  onDoubleClick,
  onHover,
  onBlur,
  onSelect
}) => {
  const seed = useMemo(
    () => Math.max(1, Math.floor(hashStringToUnit(seedKey) * 0xffffffff)),
    [seedKey]
  );
  const surfaceTexture = useDisposableMemo(
    () => createStarSurfaceTexture(surfaceTintColor, seed),
    [seed, surfaceTintColor]
  );
  const glowTexture = useDisposableMemo(
    () => createStarGlowTexture(tintColor),
    [tintColor]
  );
  const coreMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({
      color: '#ffffff',
      map: surfaceTexture,
      toneMapped: false
    }),
    [surfaceTexture]
  );
  const innerGlowMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({
      color: new Color('#ffffff').lerp(new Color(tintColor), 0.25),
      map: glowTexture,
      transparent: true,
      opacity: 0.5,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    }),
    [glowTexture, tintColor]
  );
  const outerGlowMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({
      color: new Color('#ffffff').lerp(new Color(tintColor), 0.2),
      map: glowTexture,
      transparent: true,
      opacity: 0.2,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    }),
    [glowTexture, tintColor]
  );
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;

  const scale = useMemo<[number, number, number]>(() => [radius, radius, radius], [radius]);
  const innerGlowScale = useMemo<[number, number, number]>(
    () => [radius * 1.15, radius * 1.15, radius * 1.15],
    [radius]
  );
  const outerGlowScale = useMemo<[number, number, number]>(
    () => [radius * 1.45, radius * 1.45, radius * 1.45],
    [radius]
  );
  const groupRef = useRef<Group | null>(null);
  const coreRef = useRef<Mesh | null>(null);
  const lensFlareState = useMemo(() => {
    if (!enableLensFlare || lensFlareStrength <= 0) return null;

    const lensflare = new Lensflare();
    lensflare.raycast = () => null;

    const haloTexture = createLensFlareHaloTexture();
    const ghostTexture = createLensFlareHaloTexture();
    const ringTexture = createLensFlareRingTexture();
    const sparkTexture = createLensFlareSparkTexture();

    const base = new Color('#ffffff');
    const tint = new Color(tintColor);
    const haloBaseColor = base.clone().lerp(tint, 0.5);
    const ringBaseColor = base.clone().lerp(tint, 0.35);
    const ghostBaseColor = base.clone().lerp(tint, 0.25);
    const sparkBaseColor = base.clone();

    const halo = new LensflareElement(haloTexture, 256, 0, haloBaseColor.clone());
    const ring = new LensflareElement(ringTexture, 180, 0.08, ringBaseColor.clone());
    const ghost = new LensflareElement(ghostTexture, 96, 0.62, ghostBaseColor.clone());
    const spark = new LensflareElement(sparkTexture, 54, 0.88, sparkBaseColor.clone());

    lensflare.addElement(halo);
    lensflare.addElement(ring);
    lensflare.addElement(ghost);
    lensflare.addElement(spark);

    return {
      lensflare,
      elements: [halo, ring, ghost, spark],
      baseColors: [haloBaseColor, ringBaseColor, ghostBaseColor, sparkBaseColor],
      sizeScales: [1, 0.75, 0.42, 0.22],
      intensityScales: [1, 0.85, 0.65, 0.5],
      smoothed: {
        intensity: 0,
        baseSizePx: LENS_FLARE_SIZE_MIN_PX
      },
      scratch: {
        starWorld: new Vector3(),
        lensWorld: new Vector3(),
        lensLocal: new Vector3(),
        projected: new Vector3(),
        toCamera: new Vector3()
      }
    };
  }, [enableLensFlare, lensFlareStrength, tintColor]);

  useEffect(() => {
    return () => {
      lensFlareState?.lensflare.dispose();
    };
  }, [lensFlareState]);

  useFrame((state, delta) => {
    if (!coreRef.current) return;
    coreRef.current.rotation.y += delta * 0.08;
    coreRef.current.rotation.z += delta * 0.02;

    const group = groupRef.current;
    const lensflare = lensFlareState?.lensflare ?? null;
    if (!group || !lensflare || !lensFlareState) return;

    const { scratch, elements, baseColors, sizeScales, intensityScales, smoothed } = lensFlareState;
    group.getWorldPosition(scratch.starWorld);
    scratch.toCamera.copy(state.camera.position).sub(scratch.starWorld);
    const distanceToCamera = scratch.toCamera.length();
    if (!Number.isFinite(distanceToCamera) || distanceToCamera < 0.001) {
      smoothed.intensity = MathUtils.damp(smoothed.intensity, 0, 10, delta);
      lensflare.visible = false;
      return;
    }

    const viewportHeightPx = state.size.height * state.gl.getPixelRatio();
    const fovRad = (state.camera as PerspectiveCamera).isPerspectiveCamera
      ? MathUtils.degToRad((state.camera as PerspectiveCamera).fov)
      : MathUtils.degToRad(55);
    const starDiameterPx = (radius / distanceToCamera) * (viewportHeightPx / Math.tan(fovRad * 0.5));
    const targetBaseSizePx = MathUtils.clamp(
      starDiameterPx * LENS_FLARE_BASE_SIZE_MULTIPLIER,
      LENS_FLARE_SIZE_MIN_PX,
      LENS_FLARE_SIZE_MAX_PX
    );

    scratch.toCamera.divideScalar(distanceToCamera);
    scratch.lensWorld.copy(scratch.starWorld).addScaledVector(scratch.toCamera, radius * 1.02);
    scratch.lensLocal.copy(scratch.lensWorld);
    group.worldToLocal(scratch.lensLocal);
    lensflare.position.copy(scratch.lensLocal);

    scratch.projected.copy(scratch.lensWorld).project(state.camera);
    const onScreen = scratch.projected.z > -1
      && scratch.projected.z < 1
      && Math.abs(scratch.projected.x) <= 1.15
      && Math.abs(scratch.projected.y) <= 1.15;

    const centerDist = Math.sqrt(scratch.projected.x * scratch.projected.x + scratch.projected.y * scratch.projected.y);
    const centerFactor = 1 - MathUtils.smoothstep(centerDist, LENS_FLARE_CENTER_FADE_START, LENS_FLARE_CENTER_FADE_END);
    const sizeFactor = MathUtils.smoothstep(starDiameterPx, LENS_FLARE_STAR_DIAMETER_MIN_PX, LENS_FLARE_STAR_DIAMETER_FULL_PX);
    const closeFactor = 1 - MathUtils.smoothstep(
      starDiameterPx,
      LENS_FLARE_STAR_DIAMETER_FADE_OUT_START_PX,
      LENS_FLARE_STAR_DIAMETER_FADE_OUT_END_PX
    );
    const targetIntensity = onScreen
      ? MathUtils.clamp(Math.pow(centerFactor, LENS_FLARE_INTENSITY_POWER) * sizeFactor * closeFactor * lensFlareStrength, 0, 1)
      : 0;

    smoothed.intensity = MathUtils.damp(smoothed.intensity, targetIntensity, 12, delta);
    smoothed.baseSizePx = MathUtils.damp(smoothed.baseSizePx, targetBaseSizePx, 12, delta);

    const shouldShow = onScreen && smoothed.intensity > 0.01;
    lensflare.visible = shouldShow;
    if (!shouldShow) return;

    const baseSizePx = smoothed.baseSizePx;

    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      element.size = baseSizePx * sizeScales[index];
      element.color.copy(baseColors[index]).multiplyScalar(smoothed.intensity * intensityScales[index]);
    }
  });

  return (
    <group ref={groupRef}>
      <mesh
        ref={coreRef}
        geometry={geometry}
        material={coreMaterial}
        scale={scale}
        onDoubleClick={onDoubleClick}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onDoubleClick?.(event);
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          onHover?.();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          onBlur?.();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onSelect?.();
        }}
        frustumCulled
      />
      <mesh
        geometry={geometry}
        material={innerGlowMaterial}
        scale={innerGlowScale}
        raycast={() => null}
        renderOrder={2}
        frustumCulled
      />
      <mesh
        geometry={geometry}
        material={outerGlowMaterial}
        scale={outerGlowScale}
        raycast={() => null}
        renderOrder={3}
        frustumCulled
      />
      {lensFlareState?.lensflare && (
        <primitive object={lensFlareState.lensflare} dispose={null} />
      )}
    </group>
  );
};

interface MoonOrbitGroupProps {
  moon: OrbitingMoon;
  orbitMaterial: MeshBasicMaterial;
  orbitShadowMaterial: ShadowMaterial;
  moonGeometry: SphereGeometry;
  moonMaterial: MeshStandardMaterial;
  resolveAtmosphereBundle: (body: OrbitingPlanet | OrbitingMoon) => AtmosphereLayerBundle | null;
  orbitThickness: number;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string) => void;
}

const MoonOrbitGroup: React.FC<MoonOrbitGroupProps & { onFocus: (bodyId: string) => void }> = ({
  moon,
  orbitMaterial,
  orbitShadowMaterial,
  moonGeometry,
  moonMaterial,
  resolveAtmosphereBundle,
  orbitThickness,
  onFocus,
  onHover,
  onBlur,
  onSelect
}) => {
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const hitboxMaterial = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    []
  );
  useEffect(() => () => hitboxMaterial.dispose(), [hitboxMaterial]);
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(moon.orbitRadius - orbitThickness, 0.0025), moon.orbitRadius + orbitThickness, 96),
    [moon.orbitRadius, orbitThickness]
  );
  const orbitRotation = useMemo(() => {
    const inclination = MathUtils.degToRad(moon.orbitInclinationDeg);
    const ascendingNode = MathUtils.degToRad(moon.orbitAscendingNodeDeg);
    return new Euler(-Math.PI / 2 - inclination, -ascendingNode, 0, 'YXZ');
  }, [moon.orbitAscendingNodeDeg, moon.orbitInclinationDeg]);
  const moonPosition = useMemo<[number, number, number]>(
    () => computeInclinedOrbitPosition(
      moon.orbitRadius,
      moon.orbitAngle,
      moon.orbitInclinationDeg,
      moon.orbitAscendingNodeDeg
    ),
    [moon.orbitAngle, moon.orbitAscendingNodeDeg, moon.orbitInclinationDeg, moon.orbitRadius]
  );
  const moonHitboxScale = useMemo<[number, number, number]>(
    () => [moon.radius * 2, moon.radius * 2, moon.radius * 2],
    [moon.radius]
  );
  const moonScale = useMemo<[number, number, number]>(() => [moon.radius, moon.radius, moon.radius], [moon.radius]);
  const atmosphereBundle = moon.atmosphere && moon.atmosphere !== 'None'
    ? resolveAtmosphereBundle(moon)
    : null;
  const spinSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${moon.id}-spin`);
    return MathUtils.lerp(BODY_SPIN_SPEED_MIN, BODY_SPIN_SPEED_MAX, seed);
  }, [moon.id]);
  const cloudSpinSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${moon.id}-cloud-spin`);
    const multiplier = MathUtils.lerp(CLOUD_SPIN_MULTIPLIER_MIN, CLOUD_SPIN_MULTIPLIER_MAX, seed);
    return spinSpeed * multiplier;
  }, [moon.id, spinSpeed]);
  const cloudNoiseSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${moon.id}-cloud-noise`);
    return MathUtils.lerp(CLOUD_NOISE_SPEED_MIN, CLOUD_NOISE_SPEED_MAX, seed);
  }, [moon.id]);
  const spinGroupRef = useRef<Group>(null);

  useFrame((_, delta) => {
    if (spinGroupRef.current) {
      spinGroupRef.current.rotation.y += delta * spinSpeed;
    }
  });

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} frustumCulled />
      <mesh
        geometry={orbitGeometry}
        material={orbitShadowMaterial}
        rotation={orbitRotation}
        castShadow={false}
        receiveShadow
        frustumCulled
        raycast={() => null}
        renderOrder={1}
      />
      <group position={moonPosition}>
        <group ref={spinGroupRef}>
          <mesh
            geometry={moonGeometry}
            material={hitboxMaterial}
            scale={moonHitboxScale}
            castShadow={false}
            receiveShadow={false}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocus(moon.id);
            }}
            onPointerDown={(event: ThreeEvent<PointerEvent>) => {
              if (event.pointerType !== 'touch') return;
              const now = performance.now();
              if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
                lastTouchRef.current = 0;
                event.stopPropagation();
                event.nativeEvent.preventDefault();
                onFocus(moon.id);
              } else {
                lastTouchRef.current = now;
              }
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHover(moon.id);
            }}
            onPointerOut={(event) => {
              event.stopPropagation();
              onBlur(moon.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(moon.id);
            }}
            frustumCulled
          />
          <mesh
            geometry={moonGeometry}
            material={moonMaterial}
            scale={moonScale}
            castShadow
            receiveShadow
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocus(moon.id);
            }}
            onPointerDown={(event: ThreeEvent<PointerEvent>) => {
              if (event.pointerType !== 'touch') return;
              const now = performance.now();
              if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
                lastTouchRef.current = 0;
                event.stopPropagation();
                event.nativeEvent.preventDefault();
                onFocus(moon.id);
              } else {
                lastTouchRef.current = now;
              }
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHover(moon.id);
            }}
            onPointerOut={(event) => {
              event.stopPropagation();
              onBlur(moon.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(moon.id);
            }}
            frustumCulled
          />
          {atmosphereBundle && (
            <AtmosphereStack
              geometry={moonGeometry}
              radius={moon.radius}
              bundle={atmosphereBundle}
              cloudSpinSpeed={cloudSpinSpeed}
              cloudNoiseSpeed={cloudNoiseSpeed}
            />
          )}
        </group>
      </group>
    </group>
  );
};

interface PlanetOrbitGroupProps {
  planet: OrbitingPlanet;
  orbitMaterial: MeshBasicMaterial;
  orbitShadowMaterial: ShadowMaterial;
  planetGeometry: SphereGeometry;
  moonGeometry: SphereGeometry;
  planetMaterial: MeshStandardMaterial;
  resolveMoonMaterial: (moon: OrbitingMoon) => MeshStandardMaterial;
  resolveAtmosphereBundle: (body: OrbitingPlanet | OrbitingMoon) => AtmosphereLayerBundle | null;
  orbitThickness: number;
  onFocus: (bodyId: string) => void;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string) => void;
}

const PlanetOrbitGroup: React.FC<PlanetOrbitGroupProps> = ({
  planet,
  orbitMaterial,
  orbitShadowMaterial,
  planetGeometry,
  moonGeometry,
  planetMaterial,
  resolveMoonMaterial,
  resolveAtmosphereBundle,
  orbitThickness,
  onFocus,
  onHover,
  onBlur,
  onSelect
}) => {
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const hitboxMaterial = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    []
  );
  useEffect(() => () => hitboxMaterial.dispose(), [hitboxMaterial]);
  const orbitGeometry = useDisposableMemo(
    () => new RingGeometry(Math.max(planet.orbitRadius - orbitThickness, 0.01), planet.orbitRadius + orbitThickness, 128),
    [orbitThickness, planet.orbitRadius]
  );
  const orbitRotation = useMemo(() => {
    const inclination = MathUtils.degToRad(planet.orbitInclinationDeg);
    const ascendingNode = MathUtils.degToRad(planet.orbitAscendingNodeDeg);
    return new Euler(-Math.PI / 2 - inclination, -ascendingNode, 0, 'YXZ');
  }, [planet.orbitAscendingNodeDeg, planet.orbitInclinationDeg]);
  const planetPosition = useMemo<[number, number, number]>(
    () => computeInclinedOrbitPosition(
      planet.orbitRadius,
      planet.orbitAngle,
      planet.orbitInclinationDeg,
      planet.orbitAscendingNodeDeg
    ),
    [planet.orbitAngle, planet.orbitAscendingNodeDeg, planet.orbitInclinationDeg, planet.orbitRadius]
  );
  const planetScale = useMemo<[number, number, number]>(
    () => [planet.radius, planet.radius, planet.radius],
    [planet.radius]
  );
  const planetHitboxScale = useMemo<[number, number, number]>(
    () => [planet.radius * 1.5, planet.radius * 1.5, planet.radius * 1.5],
    [planet.radius]
  );
  const atmosphereBundle = planet.atmosphere && planet.atmosphere !== 'None'
    ? resolveAtmosphereBundle(planet)
    : null;
  const spinSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${planet.id}-spin`);
    return MathUtils.lerp(BODY_SPIN_SPEED_MIN, BODY_SPIN_SPEED_MAX, seed);
  }, [planet.id]);
  const cloudSpinSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${planet.id}-cloud-spin`);
    const multiplier = MathUtils.lerp(CLOUD_SPIN_MULTIPLIER_MIN, CLOUD_SPIN_MULTIPLIER_MAX, seed);
    return spinSpeed * multiplier;
  }, [planet.id, spinSpeed]);
  const cloudNoiseSpeed = useMemo(() => {
    const seed = hashStringToUnit(`${planet.id}-cloud-noise`);
    return MathUtils.lerp(CLOUD_NOISE_SPEED_MIN, CLOUD_NOISE_SPEED_MAX, seed);
  }, [planet.id]);
  const spinGroupRef = useRef<Group>(null);

  useFrame((_, delta) => {
    if (spinGroupRef.current) {
      spinGroupRef.current.rotation.y += delta * spinSpeed;
    }
  });

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} frustumCulled />
      <mesh
        geometry={orbitGeometry}
        material={orbitShadowMaterial}
        rotation={orbitRotation}
        castShadow={false}
        receiveShadow
        frustumCulled
        raycast={() => null}
        renderOrder={1}
      />
      <group position={planetPosition}>
        <group ref={spinGroupRef}>
          <mesh
            geometry={planetGeometry}
            material={hitboxMaterial}
            scale={planetHitboxScale}
            castShadow={false}
            receiveShadow={false}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocus(planet.id);
            }}
            onPointerDown={(event: ThreeEvent<PointerEvent>) => {
              if (event.pointerType !== 'touch') return;
              const now = performance.now();
              if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
                lastTouchRef.current = 0;
                event.stopPropagation();
                event.nativeEvent.preventDefault();
                onFocus(planet.id);
              } else {
                lastTouchRef.current = now;
              }
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHover(planet.id);
            }}
            onPointerOut={(event) => {
              event.stopPropagation();
              onBlur(planet.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(planet.id);
            }}
            frustumCulled
          />
          <mesh
            geometry={planetGeometry}
            material={planetMaterial}
            scale={planetScale}
            castShadow
            receiveShadow
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocus(planet.id);
            }}
            onPointerDown={(event: ThreeEvent<PointerEvent>) => {
              if (event.pointerType !== 'touch') return;
              const now = performance.now();
              if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
                lastTouchRef.current = 0;
                event.stopPropagation();
                event.nativeEvent.preventDefault();
                onFocus(planet.id);
              } else {
                lastTouchRef.current = now;
              }
            }}
            onPointerOver={(event) => {
              event.stopPropagation();
              onHover(planet.id);
            }}
            onPointerOut={(event) => {
              event.stopPropagation();
              onBlur(planet.id);
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(planet.id);
            }}
            frustumCulled
          />
          {atmosphereBundle && (
            <AtmosphereStack
              geometry={planetGeometry}
              radius={planet.radius}
              bundle={atmosphereBundle}
              cloudSpinSpeed={cloudSpinSpeed}
              cloudNoiseSpeed={cloudNoiseSpeed}
            />
          )}
        </group>
        {planet.moons.map(moon => (
          <MoonOrbitGroup
            key={moon.id}
            moon={moon}
            orbitMaterial={orbitMaterial}
            orbitShadowMaterial={orbitShadowMaterial}
            moonGeometry={moonGeometry}
            moonMaterial={resolveMoonMaterial(moon)}
            resolveAtmosphereBundle={resolveAtmosphereBundle}
            orbitThickness={orbitThickness}
            onFocus={onFocus}
            onHover={onHover}
            onBlur={onBlur}
            onSelect={onSelect}
          />
        ))}
      </group>
    </group>
  );
};

interface SystemCelestialLayerProps {
  stars: OrbitingStar[];
  starGeometry: SphereGeometry;
  planets: OrbitingPlanet[];
  orbitMaterial: MeshBasicMaterial;
  orbitShadowMaterial: ShadowMaterial;
  planetGeometry: SphereGeometry;
  moonGeometry: SphereGeometry;
  resolvePlanetMaterial: (planet: OrbitingPlanet) => MeshStandardMaterial;
  resolveMoonMaterial: (moon: OrbitingMoon) => MeshStandardMaterial;
  resolveAtmosphereBundle: (body: OrbitingPlanet | OrbitingMoon) => AtmosphereLayerBundle | null;
  orbitThickness: number;
  onFocusBody: (bodyId: string) => void;
  onHoverBody: (bodyId: string) => void;
  onBlurBody: (bodyId: string) => void;
  onSelectBody: (bodyId: string) => void;
}

const SystemCelestialLayer: React.FC<SystemCelestialLayerProps> = ({
  stars,
  starGeometry,
  planets,
  orbitMaterial,
  orbitShadowMaterial,
  planetGeometry,
  moonGeometry,
  resolvePlanetMaterial,
  resolveMoonMaterial,
  resolveAtmosphereBundle,
  orbitThickness,
  onFocusBody,
  onHoverBody,
  onBlurBody,
  onSelectBody
}) => {
  return (
    <group name="SystemCelestialLayer">
      {stars.map((star) => (
        <group key={star.id} position={star.position}>
          <StarMesh
            radius={star.radius}
            tintColor={star.tintColor}
            surfaceTintColor={star.surfaceTintColor}
            geometry={starGeometry}
            seedKey={star.seedKey}
            enableLensFlare={star.data.role === 'primary'}
            onDoubleClick={(event) => {
              event.stopPropagation();
              onFocusBody(star.id);
            }}
            onHover={() => onHoverBody(star.id)}
            onBlur={() => onBlurBody(star.id)}
            onSelect={() => onSelectBody(star.id)}
          />
        </group>
      ))}
      {planets.map(planet => (
        <PlanetOrbitGroup
          key={planet.id}
          planet={planet}
          orbitMaterial={orbitMaterial}
          orbitShadowMaterial={orbitShadowMaterial}
          planetGeometry={planetGeometry}
          moonGeometry={moonGeometry}
          planetMaterial={resolvePlanetMaterial(planet)}
          resolveMoonMaterial={resolveMoonMaterial}
          resolveAtmosphereBundle={resolveAtmosphereBundle}
          orbitThickness={orbitThickness}
          onFocus={onFocusBody}
          onHover={onHoverBody}
          onBlur={onBlurBody}
          onSelect={onSelectBody}
        />
      ))}
    </group>
  );
};

type AtmosphereLayerBundle = {
  lower: { material: ShaderMaterial; scale: number };
  haze: { material: ShaderMaterial; scale: number };
  clouds?: { material: ShaderMaterial; scale: number };
};

type CloudLayerStyle = {
  color: string;
  shadowColor: string;
  baseAltitude: number;
  noiseScale: number;
  threshold: number;
  softness: number;
  opacity: number;
  rimPower: number;
  rimStrength: number;
  bandStrength: number;
  bandFrequency: number;
};

type AtmosphereLayerStyle = {
  rayleighColor: string;
  mieColor: string;
  sunsetColor: string;
  baseThickness: number;
  lower: {
    intensity: number;
    density: number;
    rimPower: number;
    miePower: number;
    mieStrength: number;
    sunsetStrength: number;
    nightMin: number;
  };
  haze: {
    intensity: number;
    density: number;
    rimPower: number;
    miePower: number;
    mieStrength: number;
    sunsetStrength: number;
    nightMin: number;
    thicknessMultiplier: number;
  };
  clouds?: CloudLayerStyle;
};

const ATMOSPHERE_STYLE: Record<Exclude<AtmosphereType, 'None'>, AtmosphereLayerStyle> = {
  Thin: {
    rayleighColor: '#a5f3fc',
    mieColor: '#ffffff',
    sunsetColor: '#ffd7aa',
    baseThickness: 0.02,
    lower: {
      intensity: 0.32,
      density: 0.75,
      rimPower: 2.6,
      miePower: 10,
      mieStrength: 0.18,
      sunsetStrength: 0.55,
      nightMin: 0.08
    },
    haze: {
      intensity: 0.16,
      density: 0.5,
      rimPower: 3.2,
      miePower: 9,
      mieStrength: 0.12,
      sunsetStrength: 0.45,
      nightMin: 0.06,
      thicknessMultiplier: 1.85
    }
  },
  Earthlike: {
    rayleighColor: '#38bdf8',
    mieColor: '#f8fafc',
    sunsetColor: '#ffb36b',
    baseThickness: 0.035,
    lower: {
      intensity: 0.4,
      density: 0.9,
      rimPower: 2.45,
      miePower: 11,
      mieStrength: 0.26,
      sunsetStrength: 0.9,
      nightMin: 0.09
    },
    haze: {
      intensity: 0.2,
      density: 0.6,
      rimPower: 3.15,
      miePower: 10,
      mieStrength: 0.18,
      sunsetStrength: 0.75,
      nightMin: 0.07,
      thicknessMultiplier: 1.9
    },
    clouds: {
      color: '#f8fafc',
      shadowColor: '#64748b',
      baseAltitude: 0.006,
      noiseScale: 4.2,
      threshold: 0.58,
      softness: 0.08,
      opacity: 0.34,
      rimPower: 2.2,
      rimStrength: 0.28,
      bandStrength: 0,
      bandFrequency: 0
    }
  },
  CO2: {
    rayleighColor: '#fb923c',
    mieColor: '#fff7ed',
    sunsetColor: '#ff6b3d',
    baseThickness: 0.048,
    lower: {
      intensity: 0.45,
      density: 1.0,
      rimPower: 2.35,
      miePower: 11,
      mieStrength: 0.22,
      sunsetStrength: 1.05,
      nightMin: 0.1
    },
    haze: {
      intensity: 0.24,
      density: 0.7,
      rimPower: 3.05,
      miePower: 10,
      mieStrength: 0.16,
      sunsetStrength: 0.9,
      nightMin: 0.08,
      thicknessMultiplier: 1.95
    },
    clouds: {
      color: '#fff7ed',
      shadowColor: '#a16207',
      baseAltitude: 0.008,
      noiseScale: 3.8,
      threshold: 0.62,
      softness: 0.09,
      opacity: 0.28,
      rimPower: 2.15,
      rimStrength: 0.22,
      bandStrength: 0,
      bandFrequency: 0
    }
  },
  H2He: {
    rayleighColor: '#a78bfa',
    mieColor: '#f5f3ff',
    sunsetColor: '#fbcfe8',
    baseThickness: 0.09,
    lower: {
      intensity: 0.6,
      density: 1.15,
      rimPower: 2.15,
      miePower: 9,
      mieStrength: 0.35,
      sunsetStrength: 0.5,
      nightMin: 0.12
    },
    haze: {
      intensity: 0.32,
      density: 0.9,
      rimPower: 2.8,
      miePower: 8,
      mieStrength: 0.28,
      sunsetStrength: 0.35,
      nightMin: 0.1,
      thicknessMultiplier: 2.05
    },
    clouds: {
      color: '#f5f3ff',
      shadowColor: '#7c3aed',
      baseAltitude: 0.014,
      noiseScale: 7.2,
      threshold: 0.5,
      softness: 0.1,
      opacity: 0.45,
      rimPower: 2.0,
      rimStrength: 0.2,
      bandStrength: 0.85,
      bandFrequency: 18
    }
  }
};

const fallbackAirMassIndex = (atmosphere: AtmosphereType): number => {
  switch (atmosphere) {
    case 'Thin':
      return 0.25;
    case 'Earthlike':
      return 0.6;
    case 'CO2':
      return 0.8;
    case 'H2He':
      return 1.0;
    default:
      return 0;
  }
};

const resolveAirMassIndex = (airMassIndex: number | undefined, pressureBar: number | undefined, atmosphere: AtmosphereType): number => {
  if (typeof airMassIndex === 'number' && Number.isFinite(airMassIndex)) {
    return MathUtils.clamp(airMassIndex, 0, 1);
  }

  if (typeof pressureBar === 'number' && Number.isFinite(pressureBar)) {
    const pressure = MathUtils.clamp(pressureBar, 0.01, 50);
    const normalized = (Math.log10(pressure) + 1) / 2;
    return MathUtils.clamp(normalized, 0, 1);
  }

  return fallbackAirMassIndex(atmosphere);
};

const createAtmosphereLayerMaterial = (params: {
  sunColor: Color;
  rayleighColor: string;
  mieColor: string;
  sunsetColor: string;
  intensity: number;
  density: number;
  rimPower: number;
  miePower: number;
  mieStrength: number;
  sunsetStrength: number;
  nightMin: number;
}): ShaderMaterial => {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: BackSide,
    uniforms: {
      uSunColor: { value: params.sunColor },
      uRayleighColor: { value: new Color(params.rayleighColor) },
      uMieColor: { value: new Color(params.mieColor) },
      uSunsetColor: { value: new Color(params.sunsetColor) },
      uIntensity: { value: params.intensity },
      uDensity: { value: params.density },
      uRimPower: { value: params.rimPower },
      uMiePower: { value: params.miePower },
      uMieStrength: { value: params.mieStrength },
      uSunsetStrength: { value: params.sunsetStrength },
      uNightMin: { value: params.nightMin },
      uTerminatorSoftness: { value: DAY_NIGHT_TERMINATOR_SOFTNESS }
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunColor;
      uniform vec3 uRayleighColor;
      uniform vec3 uMieColor;
      uniform vec3 uSunsetColor;
      uniform float uIntensity;
      uniform float uDensity;
      uniform float uRimPower;
      uniform float uMiePower;
      uniform float uMieStrength;
      uniform float uSunsetStrength;
      uniform float uNightMin;
      uniform float uTerminatorSoftness;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;

      void main() {
        vec3 N = normalize(vWorldNormal);
        #ifdef FLIP_SIDED
          N = -N;
        #endif
        vec3 V = normalize(cameraPosition - vWorldPosition);

        float sunDistance = length(vWorldPosition);
        vec3 L = sunDistance > 0.000001 ? (-vWorldPosition / sunDistance) : vec3(0.0, 0.0, 1.0);

        float mu = dot(N, L);
        float day = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, mu);
        float daylight = mix(uNightMin, 1.0, day);

        float nv = clamp(dot(N, V), 0.0, 1.0);
        float opticalDepth = clamp(1.0 - nv, 0.0, 1.0);
        float density = 1.0 - exp(-uDensity * opticalDepth * 2.2);
        float limb = pow(opticalDepth, uRimPower);
        float depth = limb * density;

        float cosTheta = clamp(dot(V, L), -1.0, 1.0);
        float rayleighPhase = 0.75 * (1.0 + cosTheta * cosTheta);
        float g = clamp(0.2 + uMiePower * 0.04, 0.35, 0.8);
        float g2 = g * g;
        float miePhase = (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 0.0001), 1.5);
        miePhase *= 0.35;
        float rayleigh = depth * rayleighPhase;
        float mie = miePhase * depth * uMieStrength;

        float terminatorBand = 1.0 - smoothstep(0.0, uTerminatorSoftness * 2.5, abs(mu));
        float twilight = terminatorBand * (0.35 + 0.65 * rayleighPhase);
        float sunset = twilight * depth * uSunsetStrength;

        float scatter = rayleigh + mie + sunset;
        if (scatter <= 0.00001) discard;

        vec3 scatterColor = (uRayleighColor * rayleigh + uMieColor * mie + uSunsetColor * sunset) / max(scatter, 0.0001);
        float alpha = clamp(scatter * uIntensity * daylight, 0.0, 1.0);
        vec3 color = uSunColor * scatterColor;

        gl_FragColor = vec4(color, alpha);
      }
    `,
    toneMapped: false
  });
};

const createCloudLayerMaterial = (params: {
  sunColor: Color;
  cloudColor: string;
  shadowColor: string;
  opacity: number;
  threshold: number;
  softness: number;
  noiseScale: number;
  seed: number;
  seed2: number;
  bandStrength: number;
  bandFrequency: number;
  bandOffset: number;
  rimPower: number;
  rimStrength: number;
  nightMin: number;
}): ShaderMaterial => {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    side: FrontSide,
    uniforms: {
      uSunColor: { value: params.sunColor },
      uCloudColor: { value: new Color(params.cloudColor) },
      uShadowColor: { value: new Color(params.shadowColor) },
      uOpacity: { value: params.opacity },
      uThreshold: { value: params.threshold },
      uSoftness: { value: params.softness },
      uNoiseScale: { value: params.noiseScale },
      uSeed: { value: params.seed },
      uSeed2: { value: params.seed2 },
      uBandStrength: { value: params.bandStrength },
      uBandFrequency: { value: params.bandFrequency },
      uBandOffset: { value: params.bandOffset },
      uRimPower: { value: params.rimPower },
      uRimStrength: { value: params.rimStrength },
      uNightMin: { value: params.nightMin },
      uTerminatorSoftness: { value: DAY_NIGHT_TERMINATOR_SOFTNESS },
      uTime: { value: 0 }
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunColor;
      uniform vec3 uCloudColor;
      uniform vec3 uShadowColor;
      uniform float uOpacity;
      uniform float uThreshold;
      uniform float uSoftness;
      uniform float uNoiseScale;
      uniform float uSeed;
      uniform float uSeed2;
      uniform float uBandStrength;
      uniform float uBandFrequency;
      uniform float uBandOffset;
      uniform float uRimPower;
      uniform float uRimStrength;
      uniform float uNightMin;
      uniform float uTerminatorSoftness;
      uniform float uTime;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;

      float hash(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
      }

      float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);

        float n000 = hash(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash(i + vec3(1.0, 1.0, 1.0));

        float nx00 = mix(n000, n100, u.x);
        float nx10 = mix(n010, n110, u.x);
        float nx01 = mix(n001, n101, u.x);
        float nx11 = mix(n011, n111, u.x);
        float nxy0 = mix(nx00, nx10, u.y);
        float nxy1 = mix(nx01, nx11, u.y);
        return mix(nxy0, nxy1, u.z);
      }

      float fbm(vec3 p) {
        float value = 0.0;
        float amplitude = 0.55;
        for (int i = 0; i < 4; i += 1) {
          value += amplitude * noise(p);
          p = p * 2.02 + vec3(19.1, 7.7, 13.5);
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPosition);

        float sunDistance = length(vWorldPosition);
        vec3 L = sunDistance > 0.000001 ? (-vWorldPosition / sunDistance) : vec3(0.0, 0.0, 1.0);

        float mu = dot(N, L);
        float day = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, mu);
        float daylight = mix(uNightMin, 1.0, day);

        vec3 seedVec = vec3(uSeed * 11.0, uSeed2 * 17.0, uSeed * 23.0);
        vec3 drift = vec3(uTime * 0.08, uTime * 0.04, uTime * 0.06);
        float n1 = fbm(N * uNoiseScale + seedVec + drift);
        float n2 = fbm(N * (uNoiseScale * 1.9) + vec3(uSeed2 * 31.0, uSeed * 37.0, uSeed2 * 41.0) + drift * 1.4);
        float field = mix(n1, n2, 0.35);

        float stripe = 0.5 + 0.5 * sin((N.y + uBandOffset + uTime * 0.02) * uBandFrequency);
        float band = smoothstep(0.25, 0.78, stripe);
        field *= mix(1.0, band, clamp(uBandStrength, 0.0, 1.0));

        float alpha = smoothstep(uThreshold, uThreshold + uSoftness, field) * uOpacity;
        if (alpha <= 0.001) discard;

        float diffuse = clamp(mu * 0.75 + 0.25, 0.0, 1.0);
        float nv = clamp(dot(N, V), 0.0, 1.0);
        float rim = pow(1.0 - nv, uRimPower) * uRimStrength;

        vec3 base = mix(uShadowColor, uCloudColor, diffuse);
        base = mix(base, uCloudColor, rim);
        vec3 color = base * uSunColor * daylight;

        gl_FragColor = vec4(color, alpha);
      }
    `
  });
};

const AtmosphereStack: React.FC<{
  geometry: SphereGeometry;
  radius: number;
  bundle: AtmosphereLayerBundle;
  cloudSpinSpeed?: number;
  cloudNoiseSpeed?: number;
}> = ({ geometry, radius, bundle, cloudSpinSpeed, cloudNoiseSpeed }) => {
  const cloudRadius = bundle.clouds ? radius * bundle.clouds.scale : 0;
  const lowerRadius = radius * bundle.lower.scale;
  const hazeRadius = radius * bundle.haze.scale;
  const cloudMeshRef = useRef<Mesh>(null);
  const cloudTimeRef = useRef(0);

  useEffect(() => {
    cloudTimeRef.current = 0;
    if (bundle.clouds?.material.uniforms.uTime) {
      bundle.clouds.material.uniforms.uTime.value = 0;
    }
  }, [bundle.clouds?.material]);

  useFrame((_, delta) => {
    if (!bundle.clouds) return;
    if (cloudMeshRef.current && typeof cloudSpinSpeed === 'number') {
      cloudMeshRef.current.rotation.y += delta * cloudSpinSpeed;
    }
    if (bundle.clouds.material.uniforms.uTime) {
      const speed = cloudNoiseSpeed ?? CLOUD_NOISE_SPEED_MIN;
      cloudTimeRef.current += delta * speed;
      bundle.clouds.material.uniforms.uTime.value = cloudTimeRef.current;
    }
  });

  return (
    <group raycast={() => null}>
      {bundle.clouds && (
        <mesh
          geometry={geometry}
          material={bundle.clouds.material}
          scale={[cloudRadius, cloudRadius, cloudRadius]}
          castShadow={false}
          receiveShadow={false}
          frustumCulled
          raycast={() => null}
          renderOrder={3.5}
          ref={cloudMeshRef}
        />
      )}
      <mesh
        geometry={geometry}
        material={bundle.lower.material}
        scale={[lowerRadius, lowerRadius, lowerRadius]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled
        raycast={() => null}
        renderOrder={4}
      />
      <mesh
        geometry={geometry}
        material={bundle.haze.material}
        scale={[hazeRadius, hazeRadius, hazeRadius]}
        castShadow={false}
        receiveShadow={false}
        frustumCulled
        raycast={() => null}
        renderOrder={5}
      />
    </group>
  );
};

const SystemSurfaceTextureManager: React.FC<{
  starSystem: StarSystem;
  astroKey: string;
  planetSurfaceDescriptorsByBodyId?: Record<string, PlanetSurfaceDescriptor>;
  ownerKeyByBodyId: Record<string, string>;
  planets: OrbitingPlanet[];
  bodyWorldPositions: Record<string, [number, number, number]>;
  bodyRadii: Record<string, number>;
  selectedBodyId: string | null;
  hoveredBodyId: string | null;
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
  };
  const cacheRef = useRef<Map<string, SurfaceTextureBundle>>(new Map());
  const cacheLastUsedRef = useRef<Map<string, number>>(new Map());
  const inFlightRef = useRef<Map<string, { bodyId: string }>>(new Map());
  const desiredKeyByBodyIdRef = useRef<Map<string, string | null>>(new Map());
  const requestStateRef = useRef<GameState | null>(null);
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
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(16, Math.max(1, maxAnisotropy));
    texture.flipY = true;
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
  }, [cloudShadowStrengthScale, planets]);

  useEffect(() => {
    requestStateRef.current = ({
      systems: [starSystem],
      planetSurfaceDescriptorsByBodyId
    } as unknown as GameState);
  }, [planetSurfaceDescriptorsByBodyId, starSystem]);

  const disposeTextureBundle = useCallback((bundle: SurfaceTextureBundle) => {
    bundle.color.dispose();
    bundle.normal?.dispose();
    bundle.ao?.dispose();
    bundle.roughness?.dispose();
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

  const buildGasGiantTextureKey = useCallback((bodyId: string, resolution: SurfaceTextureResolution): string => (
    ['gas', bodyId, astroKey, resolution.width, resolution.height].join('|')
  ), [astroKey]);

  const buildGasGiantBundle = useCallback((
    bodyId: string,
    planetType: PlanetType | null,
    resolution: SurfaceTextureResolution
  ): SurfaceTextureBundle => {
    const baseColor = planetType ? PLANET_TYPE_COLORS[planetType] : '#cbd5e1';
    const isIceGiant = planetType === 'IceGiant';
    const seedKey = `${bodyId}|${astroKey}|${resolution.width}x${resolution.height}`;
    const data = createGasGiantTextureData(seedKey, baseColor, resolution.width, resolution.height, isIceGiant);
    const colorTexture = createDataTexture(data.color, resolution.width, resolution.height, true);
    const roughnessTexture = createDataTexture(data.roughness, resolution.width, resolution.height, false);
    return {
      color: colorTexture,
      normal: null,
      ao: null,
      roughness: roughnessTexture
    };
  }, [astroKey, createDataTexture]);

  const applyTextureToMaterial = useCallback((material: MeshStandardMaterial, key: string, bundle: SurfaceTextureBundle) => {
    let needsUpdate = false;
    if (material.map !== bundle.color) {
      material.map = bundle.color;
      material.color.set('#ffffff');
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
    const baseRoughness = typeof material.userData.baseRoughness === 'number'
      ? material.userData.baseRoughness
      : material.roughness;
    if (nextRoughness) {
      material.roughness = 1;
    } else if (material.roughness !== baseRoughness) {
      material.roughness = baseRoughness;
    }
    if (needsUpdate) {
      material.needsUpdate = true;
    }
    material.userData.surfaceTextureKey = key;
    material.userData.surfaceNormalTextureKey = nextNormal ? key : null;
    material.userData.surfaceAoTextureKey = nextAo ? key : null;
    material.userData.surfaceRoughnessTextureKey = nextRoughness ? key : null;
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
  }, []);

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
    const shouldPreferUltra = (bodyId: string) => bodyId === preferUltraBodyId;

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

      let resolution = pickSurfaceTextureResolution(diameterPx, shouldPreferUltra(bodyId));
      if (!resolution && isOnScreen) {
        resolution = { width: 256, height: 128 };
      }
      if (!resolution && shouldForceLowRes(bodyId)) {
        resolution = { width: 256, height: 128 };
      }
      if (!resolution) {
        desiredKeyByBodyIdRef.current.set(bodyId, null);
        const material = resolveMaterial(bodyId);
        if (material && material.userData.surfaceTextureKey) {
          clearTextureFromMaterial(material);
        }
        return;
      }

      const cloudShadow = !isGasGiant ? cloudShadowByBodyId.get(bodyId) ?? null : null;
      const shadowKey = cloudShadow
        ? `shadow:${cloudShadow.strength.toFixed(3)}:${cloudShadow.threshold.toFixed(3)}:${cloudShadow.noiseScale.toFixed(2)}`
        : 'shadow:none';
      const key = isGasGiant
        ? buildGasGiantTextureKey(bodyId, resolution)
        : `${buildTextureKey(bodyId, descriptor as PlanetSurfaceDescriptor, resolution)}|${shadowKey}`;
      desiredKeyByBodyIdRef.current.set(bodyId, key);
      touchKey(key);

      const cachedBundle = cacheRef.current.get(key) ?? null;
      const material = resolveMaterial(bodyId);
      if (material && cachedBundle) {
        applyTextureToMaterial(material, key, cachedBundle);
      }

      if (cachedBundle) return;
      if (isGasGiant) {
        const bundle = buildGasGiantBundle(bodyId, planetType, resolution);
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
      if (inFlightRef.current.size >= SURFACE_TEXTURE_MAX_INFLIGHT) return;

      const state = requestStateRef.current;
      if (!state) return;
      const workerRequest = buildSurfaceMapWorkerRequest(state, bodyId);
      if (!workerRequest) return;
      if (cloudShadow) {
        workerRequest.cloudShadow = cloudShadow;
      }
      const worker = workerRef.current;
      if (!worker) return;

      inFlightRef.current.set(key, { bodyId });
      worker.requestSurfaceTexture(workerRequest, resolution)
        .then((result: SurfaceTextureResult | null) => {
          inFlightRef.current.delete(key);
          if (!result) return;

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
          const bundle = { color: colorTexture, normal: normalTexture, ao: aoTexture, roughness: roughnessTexture };

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

    if (cacheRef.current.size <= SURFACE_TEXTURE_MAX_CACHE_ENTRIES) return;

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
      if (cacheRef.current.size <= SURFACE_TEXTURE_MAX_CACHE_ENTRIES) break;
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

type BodyLabelEvaluation = {
  visible: boolean;
  scale: number;
  opacity: number;
};

type LabelComputationScratch = {
  worldPosition: Vector3;
  projectedPosition: Vector3;
  parentWorldPosition: Vector3;
  parentProjectedPosition: Vector3;
};

const createBodyLabelState = (
  target: BodyLabelTarget,
  camera: Camera,
  baseScale: number,
  labelOffset: number,
  scratch: LabelComputationScratch
): BodyLabelEvaluation => {
  const { worldPosition, projectedPosition, parentWorldPosition, parentProjectedPosition } = scratch;
  worldPosition.set(...target.position);
  worldPosition.y += labelOffset;
  projectedPosition.copy(worldPosition).project(camera);

  const isOnScreen = projectedPosition.z > -1 && projectedPosition.z < 1
    && Math.abs(projectedPosition.x) <= 1.02
    && Math.abs(projectedPosition.y) <= 1.02;

  if (!isOnScreen) {
    return {
      visible: false,
      scale: 1,
      opacity: 0
    };
  }

  const distance = camera.position.distanceTo(worldPosition);
  const targetMinScale = baseScale * 0.32;
  const targetMaxScale = baseScale * (target.kind === 'planet' ? 1.6 : 1.25);
  const angularScale = MathUtils.clamp((target.radius * 8) / Math.max(distance, 0.001), targetMinScale, targetMaxScale);
  const fadeStart = Math.max(target.radius * (target.kind === 'planet' ? 28 : 22), baseScale * 5);
  const fadeEnd = fadeStart * 1.9;
  const distanceFade = MathUtils.clamp(1 - (distance - fadeStart) / (fadeEnd - fadeStart), 0, 1);
  const minOpacity = target.kind === 'planet' ? 0.35 : 0.18;
  const maxOpacity = target.kind === 'planet' ? 1 : 0.88;
  let opacity = MathUtils.lerp(minOpacity, maxOpacity, distanceFade);

  if (target.parent) {
    parentWorldPosition.set(...target.parent.position);
    parentWorldPosition.y += Math.max(target.parent.radius * 1.2, baseScale * 0.2);
    parentProjectedPosition.copy(parentWorldPosition).project(camera);
    const screenDistance = projectedPosition.distanceTo(parentProjectedPosition);
    const overlapThreshold = 0.18;
    const overlapFactor = MathUtils.clamp(screenDistance / overlapThreshold, 0, 1);
    opacity *= MathUtils.lerp(0.35, 1, overlapFactor);
  }

  return {
    visible: true,
    scale: angularScale,
    opacity
  };
};

const LABEL_RENDER_ORDER = 10;

const applyMaterialOpacity = (material: Material | Material[], opacity: number) => {
  const materials = Array.isArray(material) ? material : [material];
  materials.forEach((mat) => {
    mat.opacity = opacity;
    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.toneMapped = false;
  });
};

interface BodyLabelProps {
  target: BodyLabelTarget;
  baseScale: number;
  color?: string;
}

const BodyLabel: React.FC<BodyLabelProps> = ({ target, baseScale, color = '#ffffff' }) => {
  const { camera } = useThree();
  const groupRef = useRef<Group | null>(null);
  const textRef = useRef<Mesh | null>(null);
  const scratch = useMemo<LabelComputationScratch>(() => ({
    worldPosition: new Vector3(),
    projectedPosition: new Vector3(),
    parentWorldPosition: new Vector3(),
    parentProjectedPosition: new Vector3()
  }), []);
  const labelOffset = useMemo(
    () => Math.max(target.radius * 1.25, baseScale * 0.22),
    [baseScale, target.radius]
  );
  const fontSize = useMemo(
    () => MathUtils.clamp(target.radius * 0.7, baseScale * 0.32, baseScale * 1.25),
    [baseScale, target.radius]
  );

  useFrame(() => {
    const group = groupRef.current;
    const text = textRef.current;
    if (!group || !text) return;

    const { visible, scale, opacity } = createBodyLabelState(target, camera, baseScale, labelOffset, scratch);
    group.visible = visible;
    if (!visible) return;

    group.scale.setScalar(scale);
    applyMaterialOpacity(text.material, opacity);
  });

  return (
    <group ref={groupRef} position={target.position}>
      <Billboard position={[0, labelOffset, 0]} frustumCulled={false}>
        <Text
          ref={textRef}
          renderOrder={LABEL_RENDER_ORDER}
          fontSize={fontSize}
          color={color}
          outlineWidth={fontSize * 0.16}
          outlineColor="#0f172a"
          outlineOpacity={0.85}
          maxWidth={14}
          anchorX="center"
          anchorY="bottom"
        >
          {target.name}
        </Text>
      </Billboard>
    </group>
  );
};

interface SystemBodyLabelsProps {
  labels: BodyLabelTarget[];
  baseScale: number;
}

const SystemBodyLabels: React.FC<SystemBodyLabelsProps> = ({ labels, baseScale }) => {
  if (!labels.length) return null;
  return (
    <group name="SystemBodyLabels">
      {labels.map((label) => (
        <BodyLabel key={label.id} target={label} baseScale={baseScale} />
      ))}
    </group>
  );
};

interface SystemFleetMeshProps {
  fleet: Fleet;
  color: string;
  scale: number;
  geometry: ConeGeometry;
  ringGeometry: RingGeometry;
  isSelected: boolean;
  isHovered: boolean;
  showLabel: boolean;
  onHover: () => void;
  onBlur: () => void;
  onInteract: (
    event: ThreeEvent<MouseEvent | PointerEvent>,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => void;
}

const SystemFleetMesh: React.FC<SystemFleetMeshProps> = ({
  fleet,
  color,
  scale,
  geometry,
  ringGeometry,
  isSelected,
  isHovered,
  showLabel,
  onHover,
  onBlur,
  onInteract
}) => {
  const getFleetName = useFleetName();
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const chevronRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);
  const resolvePointerType = (event: any) => event?.pointerType || event?.nativeEvent?.pointerType || '';
  const emissiveIntensity = isSelected ? 0.75 : isHovered ? 0.55 : 0.35;
  const emphasisScale = isSelected ? 1.1 : isHovered ? 1.04 : 1;
  const verticalEmphasis = isSelected ? scale * 0.2 : isHovered ? scale * 0.08 : 0;
  const baseScale: [number, number, number] = useMemo(() => [scale, scale, scale], [scale]);
  const labelText = showLabel ? `${getFleetName(fleet.id)} [${fleet.ships.length}]` : '';

  return (
    <group position={[0, verticalEmphasis, 0]} scale={[emphasisScale, emphasisScale, emphasisScale]}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onInteract(event, { isDouble: false, pointerType: resolvePointerType(event) });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
        }}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
          onHover();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'auto';
          onBlur();
        }}
      >
        <sphereGeometry args={[1.6, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh
        geometry={geometry}
        rotation={chevronRotation}
        scale={baseScale}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.4}
          metalness={0.6}
        />
      </mesh>
      {isSelected && (
        <mesh
          geometry={ringGeometry}
          rotation={chevronRotation}
          scale={[scale * 1.1, scale * 1.1, scale * 1.1]}
        >
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
      )}
      {showLabel && (
        <Billboard position={[0, scale * 2.5, 0]}>
          <Text
            fontSize={scale * 1.1}
            color={color}
            outlineWidth={scale * 0.1}
            outlineColor="#000000"
            fontWeight="bold"
          >
            {labelText}
          </Text>
        </Billboard>
      )}
    </group>
  );
};

interface SystemFleetShipsProps {
  fleet: Fleet;
  scale: number;
  color: string;
  visible: boolean;
}

const SystemFleetShips: React.FC<SystemFleetShipsProps> = ({ fleet, scale, color, visible }) => {
  const meshRef = useRef<InstancedMesh>(null);
  const temp = useMemo(() => new Object3D(), []);
  const shipGeometry = useDisposableMemo(() => new ConeGeometry(0.35, 0.8, 6), []);
  const shipMaterial = useDisposableMemo(
    () => new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, roughness: 0.5, metalness: 0.4 }),
    [color]
  );

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const total = fleet.ships.length;
    if (total === 0) return;
    const formationRadius = scale * 1.6;
    const shipScale = scale * 0.35;
    const yOffset = scale * 0.18;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < total; i += 1) {
      const t = (i + 0.5) / total;
      const radius = formationRadius * Math.sqrt(t);
      const angle = i * goldenAngle;
      temp.position.set(Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius);
      temp.rotation.set(-Math.PI / 2, 0, angle);
      temp.scale.set(shipScale, shipScale, shipScale);
      temp.updateMatrix();
      meshRef.current.setMatrixAt(i, temp.matrix);
    }
    meshRef.current.count = total;
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [fleet.ships.length, scale, temp]);

  if (!visible || fleet.ships.length === 0) return null;

  return (
    <instancedMesh ref={meshRef} args={[shipGeometry, shipMaterial, fleet.ships.length]} />
  );
};

interface SystemStationMeshProps {
  station: Station;
  color: string;
  scale: number;
  geometry: TorusGeometry;
  coreGeometry: CylinderGeometry;
  ringGeometry: RingGeometry;
  isSelected: boolean;
  isHovered: boolean;
  showLabel: boolean;
  onHover: () => void;
  onBlur: () => void;
  onInteract: (
    event: ThreeEvent<MouseEvent | PointerEvent>,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => void;
}

const SystemStationMesh: React.FC<SystemStationMeshProps> = ({
  station,
  color,
  scale,
  geometry,
  coreGeometry,
  ringGeometry,
  isSelected,
  isHovered,
  showLabel,
  onHover,
  onBlur,
  onInteract
}) => {
  const { t } = useI18n();
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const emissiveIntensity = isSelected ? 0.65 : isHovered ? 0.45 : 0.25;
  const labelText = station.name ?? t('systemView.stationInfo.unnamedStation', { code: shortId(station.id) });
  const resolvePointerType = (event: any) => event?.pointerType || event?.nativeEvent?.pointerType || '';

  return (
    <group>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onInteract(event, { isDouble: false, pointerType: resolvePointerType(event) });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
        }}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
          onHover();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'auto';
          onBlur();
        }}
      >
        <sphereGeometry args={[1.3, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh
        geometry={geometry}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[scale, scale, scale]}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.5}
          metalness={0.5}
        />
      </mesh>
      <mesh
        geometry={coreGeometry}
        scale={[scale * 0.6, scale * 0.9, scale * 0.6]}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.6}
          metalness={0.3}
        />
      </mesh>
      {isSelected && (
        <mesh
          geometry={ringGeometry}
          rotation={[-Math.PI / 2, 0, 0]}
          scale={[scale * 1.15, scale * 1.15, scale * 1.15]}
        >
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
      )}
      {showLabel && (
        <Billboard position={[0, scale * 2.4, 0]}>
          <Text
            fontSize={scale * 1.05}
            color={color}
            outlineWidth={scale * 0.1}
            outlineColor="#000000"
            fontWeight="bold"
          >
            {labelText}
          </Text>
        </Billboard>
      )}
    </group>
  );
};

interface SystemEntitiesLayerProps {
  starBodyId: string;
  fleets: Fleet[];
  stations: Station[];
  day: number;
  starRadius: number;
  bodyWorldPositions: Record<string, [number, number, number]>;
  bodyRadii: Record<string, number>;
  clampedScale: number;
  selectedFleetId: string | null;
  selectedObjectId: SystemObjectId | null;
  hoveredObjectId: SystemObjectId | null;
  fleetIconScale: number;
  fleetLayoutConfig: TacticalRingConfig;
  getFactionColor: (id: string) => string;
  onHoverObject: (objectId: SystemObjectId) => void;
  onBlurObject: (objectId: SystemObjectId) => void;
  onSelectObject: (objectId: SystemObjectId) => void;
  onFocusPoint: (position: [number, number, number], radius: number) => void;
}

const SystemEntitiesLayer: React.FC<SystemEntitiesLayerProps> = ({
  starBodyId,
  fleets,
  stations,
  day,
  starRadius,
  bodyWorldPositions,
  bodyRadii,
  clampedScale,
  selectedFleetId,
  selectedObjectId,
  hoveredObjectId,
  fleetIconScale,
  fleetLayoutConfig,
  getFactionColor,
  onHoverObject,
  onBlurObject,
  onSelectObject,
  onFocusPoint
}) => {
  const fleetGeometry = useDisposableMemo(() => new ConeGeometry(0.5, 1.2, 6), []);
  const stationGeometry = useDisposableMemo(() => new TorusGeometry(0.6, 0.18, 10, 24), []);
  const stationCoreGeometry = useDisposableMemo(() => new CylinderGeometry(0.35, 0.35, 0.8, 10), []);
  const selectionRingGeometry = useDisposableMemo(() => new RingGeometry(0.9, 1.15, 32), []);

  const fleetLayouts = useMemo(() => layoutTacticalRing(fleets, {
    ...fleetLayoutConfig
  }, day), [day, fleetLayoutConfig, fleets]);

  const stationLayouts = useMemo(() => {
    const orderedStations = sorted(stations, (a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
    const slotCapacity = 8;
    const stationScale = 0.55 * clampedScale;
    const stationSpacing = Math.max(stationScale * 2.6, clampedScale * 0.9);
    const stationYOffset = stationScale * 0.3;

    return orderedStations.map((station, index) => {
      const anchorId = station.anchorBodyId ?? starBodyId;
      const anchorPosition = bodyWorldPositions[anchorId] ?? bodyWorldPositions[starBodyId] ?? [0, 0, 0];
      const anchorRadius = bodyRadii[anchorId] ?? starRadius;
      const baseRadius = Math.max(anchorRadius * 2.6, stationScale * 2.4);
      const slotIndex = typeof station.slotIndex === 'number' ? station.slotIndex : index;
      const ringIndex = typeof station.slotIndex === 'number'
        ? Math.floor(slotIndex / slotCapacity)
        : 0;
      const angle = typeof station.slotIndex === 'number'
        ? ((slotIndex % slotCapacity) / slotCapacity) * Math.PI * 2
        : hashStringToAngle(station.id);
      const radius = baseRadius + ringIndex * stationSpacing;
      const position: [number, number, number] = [
        anchorPosition[0] + Math.cos(angle) * radius,
        anchorPosition[1] + stationYOffset,
        anchorPosition[2] + Math.sin(angle) * radius
      ];
      return {
        station,
        position,
        scale: stationScale
      };
    });
  }, [bodyRadii, bodyWorldPositions, clampedScale, starBodyId, starRadius, stations]);

  return (
    <group name="SystemEntitiesLayer">
      {fleetLayouts.map(({ entity: fleet, position, angle }) => {
        const objectId = makeObjectId('fleet', fleet.id);
        const isHovered = hoveredObjectId === objectId;
        const isSelected = selectedFleetId === fleet.id || selectedObjectId === objectId;
        const showLabel = isHovered || isSelected;
        const color = getFactionColor(fleet.factionId);
        const shouldShowShips = isSelected;

        return (
          <group key={fleet.id} position={position} rotation={[0, angle, 0]}>
            <SystemFleetMesh
              fleet={fleet}
              color={color}
              scale={fleetIconScale}
              geometry={fleetGeometry}
              ringGeometry={selectionRingGeometry}
              isSelected={isSelected}
              isHovered={isHovered}
              showLabel={showLabel}
              onHover={() => onHoverObject(objectId)}
              onBlur={() => onBlurObject(objectId)}
              onInteract={(_, options) => {
                onSelectObject(objectId);
                if (options?.isDouble) {
                  onFocusPoint(position, fleetIconScale * 6);
                }
              }}
            />
            <SystemFleetShips
              fleet={fleet}
              scale={fleetIconScale}
              color={color}
              visible={shouldShowShips}
            />
          </group>
        );
      })}
      {stationLayouts.map(({ station, position, scale }) => {
        const objectId = makeObjectId('station', station.id);
        const isHovered = hoveredObjectId === objectId;
        const isSelected = selectedObjectId === objectId;
        const showLabel = isHovered || isSelected;
        const color = getFactionColor(station.factionId);

        return (
          <group key={station.id} position={position}>
            <SystemStationMesh
              station={station}
              color={color}
              scale={scale}
              geometry={stationGeometry}
              coreGeometry={stationCoreGeometry}
              ringGeometry={selectionRingGeometry}
              isSelected={isSelected}
              isHovered={isHovered}
              showLabel={showLabel}
              onHover={() => onHoverObject(objectId)}
              onBlur={() => onBlurObject(objectId)}
              onInteract={(_, options) => {
                onSelectObject(objectId);
                if (options?.isDouble) {
                  onFocusPoint(position, scale * 6);
                }
              }}
            />
          </group>
        );
      })}
    </group>
  );
};

export type SystemCameraState = {
  theta: number;
  phi: number;
  radius: number;
  anchoredBodyId?: string;
  position?: [number, number, number];
  target?: [number, number, number];
};

type FocusRequest = {
  target: Vector3;
  distance: number;
};

const SystemCamera: React.FC<{
  maxDistance: number;
  minDistance: number;
  focusRequest: React.MutableRefObject<FocusRequest | null>;
  initialSpherical: CameraSphericalState;
  onCameraStateChange?: (state: SystemCameraState) => void;
  lastCameraStateRef: React.MutableRefObject<SystemCameraState>;
  anchoredTarget: [number, number, number];
  anchoredBodyId?: string;
  rotateSpeed: number;
  zoomSpeed: number;
  cameraNear: number;
  cameraFar: number;
}> = ({
  maxDistance,
  minDistance,
  focusRequest,
  initialSpherical,
  onCameraStateChange,
  lastCameraStateRef,
  anchoredTarget,
  anchoredBodyId,
  rotateSpeed,
  zoomSpeed,
  cameraNear,
  cameraFar
}) => {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();
  const initialPosition = useMemo<[number, number, number]>(() => positionFromSpherical(initialSpherical, anchoredTarget), [
    anchoredTarget,
    initialSpherical.phi,
    initialSpherical.radius,
    initialSpherical.theta
  ]);
  const targetRef = useRef<Vector3>(new Vector3(...anchoredTarget));
  const desiredTargetRef = useRef<Vector3>(targetRef.current.clone());
  const initialDistance = useMemo(() => {
    const distance = Math.max(initialSpherical.radius, minDistance);
    const fallbackDistance = maxDistance * 0.6;
    return Math.max(distance || fallbackDistance, minDistance);
  }, [initialSpherical.radius, maxDistance, minDistance]);
  const desiredDistanceRef = useRef<number>(initialDistance);
  const isUserInteractingRef = useRef(false);
  const workingVector = useMemo(() => new Vector3(), []);
  const hasInitializedRef = useRef(false);
  const syncDesiredDistanceFromControls = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const distance = controls.object.position.distanceTo(controls.target);
    desiredDistanceRef.current = MathUtils.clamp(distance, minDistance, maxDistance);
  }, [maxDistance, minDistance]);

  useEffect(() => {
    camera.near = cameraNear;
    camera.far = cameraFar;
    camera.updateProjectionMatrix();
  }, [camera, cameraFar, cameraNear]);

  useLayoutEffect(() => {
    if (hasInitializedRef.current) return;
    camera.position.set(...initialPosition);
    targetRef.current.set(...anchoredTarget);
    desiredTargetRef.current.copy(targetRef.current);
    desiredDistanceRef.current = MathUtils.clamp(initialDistance, minDistance, maxDistance);
    controlsRef.current?.target.copy(targetRef.current);
    controlsRef.current?.update();
    lastCameraStateRef.current = {
      ...sphericalFromOffset(workingVector.copy(camera.position).sub(targetRef.current)),
      anchoredBodyId
    };
    hasInitializedRef.current = true;
  }, [
    anchoredBodyId,
    anchoredTarget,
    camera,
    initialDistance,
    initialPosition,
    lastCameraStateRef,
    maxDistance,
    minDistance,
    workingVector
  ]);

  useEffect(() => {
    return () => {
      if (onCameraStateChange) {
        onCameraStateChange(lastCameraStateRef.current);
      }
    };
  }, [lastCameraStateRef, onCameraStateChange]);

  useEffect(() => {
    desiredTargetRef.current.set(...anchoredTarget);
  }, [anchoredTarget]);

  useEffect(() => {
    desiredDistanceRef.current = MathUtils.clamp(desiredDistanceRef.current, minDistance, maxDistance);
  }, [maxDistance, minDistance]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    const pendingFocus = focusRequest.current;
    if (pendingFocus) {
      desiredTargetRef.current.copy(pendingFocus.target);
      desiredDistanceRef.current = MathUtils.clamp(pendingFocus.distance, minDistance, maxDistance);
      focusRequest.current = null;
    }

    const lerpAlpha = 1 - Math.exp(-6 * delta);
    targetRef.current.lerp(desiredTargetRef.current, lerpAlpha);

    const currentDirection = workingVector.copy(camera.position).sub(targetRef.current);
    const currentDistance = currentDirection.length();
    const nextDistance = MathUtils.damp(currentDistance, desiredDistanceRef.current, 8, delta);
    const clampedDistance = MathUtils.clamp(nextDistance, minDistance, maxDistance);

    const nextPosition = currentDirection.setLength(clampedDistance).add(targetRef.current);
    camera.position.copy(nextPosition);
    controls.target.copy(targetRef.current);
    controls.update();

    lastCameraStateRef.current = {
      ...sphericalFromOffset(workingVector.copy(camera.position).sub(targetRef.current)),
      anchoredBodyId
    };
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.2}
      enablePan={false}
      minDistance={minDistance}
      minPolarAngle={MIN_POLAR_ANGLE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      maxDistance={maxDistance}
      rotateSpeed={rotateSpeed}
      zoomSpeed={zoomSpeed}
      onStart={() => {
        isUserInteractingRef.current = true;
      }}
      onEnd={() => {
        isUserInteractingRef.current = false;
        syncDesiredDistanceFromControls();
      }}
      onChange={() => {
        if (isUserInteractingRef.current) {
          syncDesiredDistanceFromControls();
        }
      }}
    />
  );
};

const SystemView3D: React.FC<SystemView3DProps> = ({
  starSystem,
  astro,
  fleets = [],
  stations = [],
  factions = [],
  planetSurfaceDescriptorsByBodyId,
  day = 0,
  selectedFleetId = null,
  onSelectFleet,
  onInspectFleet,
  initialCameraState,
  onCameraStateChange,
  scaleFactor = 1,
  showBodyLabels = true,
  onOpenSurfaceView
}) => {
  const { t } = useI18n();
  const getFleetName = useFleetName();
  const clampedScale = Math.max(scaleFactor, 0.1);
  const sceneScale = KM_TO_SCENE_SCALE * clampedScale;
  const orbitThickness = ORBIT_THICKNESS * clampedScale;
  const minPlanetRadius = MIN_PLANET_RADIUS * clampedScale;
  const minMoonRadius = minPlanetRadius / 3;
  const minStarRadius = MIN_STAR_RADIUS * clampedScale;
  // Visual padding to keep planets and the star clearly separated; tune to adjust orbit spacing.
  const planetOrbitClearance = Math.max(minPlanetRadius * 2, clampedScale * 0.75);
  const moonOrbitClearance = Math.max(minMoonRadius * 2, clampedScale * 0.35);
  const focusDistanceFloor = 2.5 * clampedScale;
  const baseCameraDistance = 12 * clampedScale;
  const defaultCameraPosition = useMemo<[number, number, number]>(
    () => [0, 6 * clampedScale, 12 * clampedScale],
    [clampedScale]
  );
  const starModels = useMemo<OrbitingStar[]>(() => {
    const fallbackStar: StarData = {
      role: 'primary',
      spectralType: astro?.primarySpectralType ?? 'G',
      massSun: 1,
      radiusSun: 1,
      luminositySun: 1,
      teffK: 5800
    };
    const sourceStars = astro?.stars?.length ? astro.stars : [fallbackStar];
    const primaryMassSun = Math.max(sourceStars[0]?.massSun ?? 1, 0.1);

    return sourceStars.map((star, index) => {
      const isPrimary = index === 0;
      const starId = isPrimary
        ? `${starSystem.id}-star-primary`
        : `${starSystem.id}-star-companion-${index}`;
      const radiusKm = Math.max((star.radiusSun ?? 1) * SOLAR_RADIUS_KM, 1);
      const radius = Math.max(radiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minStarRadius);
      const spectralType = star.spectralType ?? astro?.primarySpectralType;
      const tintColor = getSpectralTint(spectralType, starSystem.color || '#ffffff');
      const surfaceTintColor = getSurfaceTintFromTemperature(star.teffK, tintColor);
      const seedKey = `${starSystem.id}-star-${index + 1}`;
      let position: [number, number, number] = [0, 0, 0];
      if (!isPrimary) {
        const orbit = star.orbit ?? createFallbackStarOrbit(seedKey, index, primaryMassSun);
        const orbitAngle = computeOrbitAngle(MathUtils.degToRad(orbit.phaseDeg), orbit.periodDays, day);
        const orbitRadius = orbit.semiMajorAxisAu * KM_PER_AU * sceneScale;
        position = computeInclinedOrbitPosition(orbitRadius, orbitAngle, orbit.inclinationDeg, orbit.ascendingNodeDeg);
      }

      return {
        id: starId,
        data: star,
        radius,
        radiusKm,
        tintColor,
        surfaceTintColor,
        seedKey,
        position
      };
    });
  }, [astro?.primarySpectralType, astro?.stars, day, minStarRadius, sceneScale, starSystem.color, starSystem.id]);
  const primaryStar = starModels[0];
  const starBodyId = primaryStar?.id ?? `${starSystem.id}-star-primary`;
  const starRadius = primaryStar?.radius ?? minStarRadius;
  const starTintColor = primaryStar?.tintColor ?? getSpectralTint(astro?.primarySpectralType, starSystem.color || '#ffffff');
  const orbitMassSun = Math.max(primaryStar?.data.massSun ?? 1, 0.1);
  const astroKey = useMemo(() => {
    if (!astro) return 'no-astro';
    return `${astro.seed}|${astro.starCount}|${astro.planets.length}`;
  }, [astro]);
  const planetBodies = useMemo(
    () => starSystem.planets.filter(body => body.bodyType === 'planet'),
    [starSystem.planets]
  );
  const ownerKeyByBodyId = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    starSystem.planets.forEach(body => {
      out[body.id] = body.ownerFactionId ?? '__neutral__';
    });
    return out;
  }, [starSystem.planets]);
  const moonBodiesByPlanetIndex = useMemo(() => {
    const buckets: PlanetBody[][] = [];
    let planetIndex = -1;
    starSystem.planets.forEach((body) => {
      if (body.bodyType === 'planet') {
        planetIndex += 1;
        return;
      }
      if (body.bodyType === 'moon' && planetIndex >= 0) {
        buckets[planetIndex] = buckets[planetIndex] ?? [];
        buckets[planetIndex].push(body);
      }
    });
    return buckets.map(bucket => sorted(bucket, (a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' })));
  }, [starSystem.planets]);
  const sourcePlanets = useMemo<PlanetSource[]>(() => {
    if (astro?.planets?.length) {
      return astro.planets.map((planet, index) => {
        const linkedBody = planetBodies[index];
        const fallbackPlanetId = `planet-${starSystem.id}-${index + 1}`;
        const planetId = linkedBody?.id ?? (planet as { id?: string }).id ?? fallbackPlanetId;
        const moonBodies = moonBodiesByPlanetIndex[index] ?? [];
        const moons: MoonSource[] = (planet.moons ?? []).map((moon, moonIndex) => ({
          ...moon,
          id: moonBodies[moonIndex]?.id ?? `moon-${starSystem.id}-${index + 1}-${moonIndex + 1}`,
          name: (moon as MoonSource).name ?? moonBodies[moonIndex]?.name,
          isSolid: moonBodies[moonIndex]?.isSolid ?? true
        }));
        return {
          ...planet,
          id: planetId,
          name: linkedBody?.name,
          planetType: planet.type,
          habitabilityScore: (planet as { habitabilityScore?: number }).habitabilityScore,
          isSolid: linkedBody?.isSolid ?? true,
          moons
        };
      });
    }

    if (planetBodies.length) {
      return planetBodies.map((planetBody) => ({
        id: planetBody.id,
        class: planetBody.class,
        size: planetBody.size,
        name: planetBody.name,
        planetType: getPlanetType(planetBody as PlanetSource),
        habitabilityScore: (planetBody as { habitabilityScore?: number }).habitabilityScore,
        isSolid: planetBody.isSolid,
        moons: []
      }));
    }

    return Array.from({ length: 3 }, (_, idx) => ({
      id: `placeholder-${idx + 1}`,
      planetType: 'Terrestrial' as PlanetType,
      moons: []
    }));
  }, [astro?.planets, moonBodiesByPlanetIndex, planetBodies, starSystem.id]);

  const planets = useMemo<OrbitingPlanet[]>(() => {
    const rawPlanets = sourcePlanets.map((planet, index) => buildPlanetModel(
      planet,
      index,
      sourcePlanets.length,
      sceneScale,
      minPlanetRadius,
      minMoonRadius,
      orbitMassSun,
      day
    ));
    const planetsWithSpacedMoons = rawPlanets.map(planet => ({
      ...planet,
      moons: applyMoonOrbitSpacing(planet.moons, planet.radius, moonOrbitClearance)
    }));
    return applyPlanetOrbitSpacing(planetsWithSpacedMoons, starRadius, planetOrbitClearance);
  }, [
    day,
    minMoonRadius,
    minPlanetRadius,
    moonOrbitClearance,
    orbitMassSun,
    planetOrbitClearance,
    sceneScale,
    sourcePlanets,
    starRadius
  ]);

  const orbitMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({ color: '#334155', transparent: true, opacity: 0.8 }),
    []
  );
  const orbitShadowMaterial = useDisposableMemo(() => {
    const material = new ShadowMaterial();
    material.opacity = 0.32;
    material.transparent = true;
    material.depthWrite = false;
    return material;
  }, []);

  const planetMaterialMap = useMemo<Record<PlanetType, MeshStandardMaterial>>(() => {
    const materials = Object.entries(PLANET_TYPE_COLORS).reduce((acc, [type, color]) => {
      acc[type as PlanetType] = new MeshStandardMaterial({
        color,
        roughness: 0.55,
        metalness: 0.2
      });
      return acc;
    }, {} as Record<PlanetType, MeshStandardMaterial>);
    return materials;
  }, []);

  const moonMaterialMap = useMemo<Record<MoonType, MeshStandardMaterial>>(() => {
    const materials = Object.entries(MOON_TYPE_COLORS).reduce((acc, [type, color]) => {
      acc[type as MoonType] = new MeshStandardMaterial({
        color,
        roughness: 0.6,
        metalness: 0.15
      });
      return acc;
    }, {} as Record<MoonType, MeshStandardMaterial>);
    return materials;
  }, []);

  useEffect(() => {
    return () => {
      Object.values(planetMaterialMap).forEach(material => material.dispose());
      Object.values(moonMaterialMap).forEach(material => material.dispose());
    };
  }, [moonMaterialMap, planetMaterialMap]);

  type AtmosphereBundleCacheEntry = AtmosphereLayerBundle & { key: string };

  const sunColorRef = useRef<Color>(new Color('#ffffff'));
  const atmosphereBundleByBodyIdRef = useRef<Map<string, AtmosphereBundleCacheEntry>>(new Map());
  const disposeAtmosphereBundle = useCallback((bundle: AtmosphereLayerBundle) => {
    bundle.lower.material.dispose();
    bundle.haze.material.dispose();
    bundle.clouds?.material.dispose();
  }, []);
  const clearAtmosphereCache = useCallback(() => {
    atmosphereBundleByBodyIdRef.current.forEach(entry => disposeAtmosphereBundle(entry));
    atmosphereBundleByBodyIdRef.current.clear();
  }, [disposeAtmosphereBundle]);
  useEffect(() => () => clearAtmosphereCache(), [clearAtmosphereCache]);
  useEffect(() => {
    clearAtmosphereCache();
  }, [astroKey, clearAtmosphereCache]);

  const resolveAtmosphereBundle = useCallback((body: OrbitingPlanet | OrbitingMoon): AtmosphereLayerBundle | null => {
    const atmosphere = body.atmosphere;
    if (!atmosphere || atmosphere === 'None') return null;
    const isGasGiant = body.type === 'GasGiant' || body.type === 'IceGiant';

    const style = ATMOSPHERE_STYLE[atmosphere];
    const airMass = resolveAirMassIndex(body.airMassIndex, body.pressureBar, atmosphere);
    const temperatureK = typeof body.temperatureK === 'number' && Number.isFinite(body.temperatureK)
      ? body.temperatureK
      : (atmosphere === 'H2He' ? 140 : 288);

    let cloudsKey = 'cloud:none';
    let clouds: AtmosphereLayerBundle['clouds'] = undefined;
    const cloudStyle = style.clouds;
    if (cloudStyle) {
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

      if (isGasGiant) {
        cloudiness = MathUtils.clamp(cloudiness + 0.18, 0, 1);
      }

      if (cloudiness > 0.08) {
        const seed = hashStringToUnit(`${body.id}|cloud_seed`);
        const seed2 = hashStringToUnit(`${body.id}|cloud_seed2`);
        const bandOffset = hashStringToUnit(`${body.id}|cloud_band_offset`) * Math.PI * 2;

        const threshold = MathUtils.clamp(
          cloudStyle.threshold - cloudiness * 0.14 - (isGasGiant ? 0.06 : 0),
          0.18,
          0.9
        );
        const opacity = MathUtils.clamp(
          cloudStyle.opacity * MathUtils.lerp(0.65, 1.05, cloudiness) * (isGasGiant ? 1.25 : 1),
          0,
          0.98
        );
        const altitude = cloudStyle.baseAltitude * MathUtils.lerp(0.85, 1.25, airMass) * (isGasGiant ? 1.6 : 1);
        const cloudScale = 1 + altitude;
        cloudsKey = `cloud:${cloudScale.toFixed(4)}:${threshold.toFixed(3)}:${opacity.toFixed(3)}`;

        clouds = {
          material: createCloudLayerMaterial({
            sunColor: sunColorRef.current,
            cloudColor: cloudStyle.color,
            shadowColor: cloudStyle.shadowColor,
            opacity,
            threshold,
            softness: cloudStyle.softness,
            noiseScale: cloudStyle.noiseScale,
            seed,
            seed2,
            bandStrength: cloudStyle.bandStrength,
            bandFrequency: cloudStyle.bandFrequency,
            bandOffset,
            rimPower: cloudStyle.rimPower,
            rimStrength: cloudStyle.rimStrength,
            nightMin: MathUtils.clamp(0.06 + airMass * 0.04, 0.06, 0.13)
          }),
          scale: cloudScale
        };
      }
    }

    const cacheKey = `${atmosphere}|${airMass.toFixed(3)}|${cloudsKey}`;

    const existing = atmosphereBundleByBodyIdRef.current.get(body.id);
    if (existing && existing.key === cacheKey) return existing;
    if (existing) {
      disposeAtmosphereBundle(existing);
      atmosphereBundleByBodyIdRef.current.delete(body.id);
    }

    const thickness = style.baseThickness * MathUtils.lerp(0.55, 1.25, airMass);
    const intensityFactor = MathUtils.lerp(0.65, 1.0, airMass);
    const densityFactor = MathUtils.lerp(0.55, 1.0, airMass);

    const bundle: AtmosphereBundleCacheEntry = {
      key: cacheKey,
      lower: {
        material: createAtmosphereLayerMaterial({
          sunColor: sunColorRef.current,
          rayleighColor: style.rayleighColor,
          mieColor: style.mieColor,
          sunsetColor: style.sunsetColor,
          intensity: style.lower.intensity * intensityFactor,
          density: style.lower.density * densityFactor,
          rimPower: style.lower.rimPower,
          miePower: style.lower.miePower,
          mieStrength: style.lower.mieStrength,
          sunsetStrength: style.lower.sunsetStrength,
          nightMin: style.lower.nightMin
        }),
        scale: 1 + thickness
      },
      haze: {
        material: createAtmosphereLayerMaterial({
          sunColor: sunColorRef.current,
          rayleighColor: style.rayleighColor,
          mieColor: style.mieColor,
          sunsetColor: style.sunsetColor,
          intensity: style.haze.intensity * intensityFactor,
          density: style.haze.density * densityFactor,
          rimPower: style.haze.rimPower,
          miePower: style.haze.miePower,
          mieStrength: style.haze.mieStrength,
          sunsetStrength: style.haze.sunsetStrength,
          nightMin: style.haze.nightMin
        }),
        scale: 1 + thickness * style.haze.thicknessMultiplier
      }
    };

    if (clouds) {
      bundle.clouds = clouds;
    }

    atmosphereBundleByBodyIdRef.current.set(body.id, bundle);
    return bundle;
  }, [disposeAtmosphereBundle]);

  const bodyMaterialByIdRef = useRef<Map<string, MeshStandardMaterial>>(new Map());
  useEffect(() => () => {
    bodyMaterialByIdRef.current.forEach(material => material.dispose());
    bodyMaterialByIdRef.current.clear();
  }, []);

  const resolvePlanetMaterial = useCallback((planet: OrbitingPlanet): MeshStandardMaterial => {
    const base = planetMaterialMap[planet.type];
    const baseColor = PLANET_TYPE_COLORS[planet.type];
    const existing = bodyMaterialByIdRef.current.get(planet.id);
    if (existing) return existing;
    const material = base.clone();
    material.normalScale = new Vector2(SURFACE_NORMAL_SCALE, SURFACE_NORMAL_SCALE);
    material.aoMapIntensity = SURFACE_AO_INTENSITY;
    material.userData.baseColor = baseColor;
    material.userData.baseRoughness = material.roughness;
    material.userData.surfaceTextureKey = null;
    material.color.set(baseColor);
    applyDayNightTerminator(material);
    bodyMaterialByIdRef.current.set(planet.id, material);
    return material;
  }, [planetMaterialMap]);

  const resolveMoonMaterial = useCallback((moon: OrbitingMoon): MeshStandardMaterial => {
    const base = moonMaterialMap[moon.type];
    const baseColor = MOON_TYPE_COLORS[moon.type];
    const existing = bodyMaterialByIdRef.current.get(moon.id);
    if (existing) return existing;
    const material = base.clone();
    material.normalScale = new Vector2(SURFACE_NORMAL_SCALE, SURFACE_NORMAL_SCALE);
    material.aoMapIntensity = SURFACE_AO_INTENSITY;
    material.userData.baseColor = baseColor;
    material.userData.baseRoughness = material.roughness;
    material.userData.surfaceTextureKey = null;
    material.color.set(baseColor);
    applyDayNightTerminator(material);
    bodyMaterialByIdRef.current.set(moon.id, material);
    return material;
  }, [moonMaterialMap]);

  const resolveBodyMaterial = useCallback((bodyId: string): MeshStandardMaterial | null => {
    return bodyMaterialByIdRef.current.get(bodyId) ?? null;
  }, []);

  const starGeometry = useDisposableMemo(() => new SphereGeometry(1, 64, 64), []);
  const planetGeometry = useDisposableMemo(() => {
    const geometry = new SphereGeometry(1, 48, 48);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, []);
  const moonGeometry = useDisposableMemo(() => {
    const geometry = new SphereGeometry(1, 32, 32);
    geometry.setAttribute('uv2', new BufferAttribute(geometry.attributes.uv.array, 2));
    return geometry;
  }, []);

  const bodyWorldPositions = useMemo<Record<string, [number, number, number]>>(() => {
    const positions: Record<string, [number, number, number]> = {};

    starModels.forEach((star) => {
      positions[star.id] = star.position;
    });

    planets.forEach((planet) => {
      const planetPosition = computeInclinedOrbitPosition(
        planet.orbitRadius,
        planet.orbitAngle,
        planet.orbitInclinationDeg,
        planet.orbitAscendingNodeDeg
      );
      positions[planet.id] = planetPosition;

      planet.moons.forEach((moon) => {
        const moonOffset = computeInclinedOrbitPosition(
          moon.orbitRadius,
          moon.orbitAngle,
          moon.orbitInclinationDeg,
          moon.orbitAscendingNodeDeg
        );
        positions[moon.id] = [
          planetPosition[0] + moonOffset[0],
          planetPosition[1] + moonOffset[1],
          planetPosition[2] + moonOffset[2]
        ];
      });
    });

    return positions;
  }, [planets, starModels]);
  const bodyRadii = useMemo<Record<string, number>>(() => {
    const radii: Record<string, number> = {};

    starModels.forEach((star) => {
      radii[star.id] = star.radius;
    });

    planets.forEach((planet) => {
      radii[planet.id] = planet.radius;
      planet.moons.forEach((moon) => {
        radii[moon.id] = moon.radius;
      });
    });

    return radii;
  }, [planets, starModels]);
  const resolvedAnchoredBodyId = useMemo(() => {
    if (initialCameraState?.anchoredBodyId && bodyWorldPositions[initialCameraState.anchoredBodyId]) {
      return initialCameraState.anchoredBodyId;
    }
    return starBodyId;
  }, [bodyWorldPositions, initialCameraState?.anchoredBodyId, starBodyId]);
  const [anchoredBodyId, setAnchoredBodyId] = useState<string | undefined>(resolvedAnchoredBodyId);
  const bodyInfoMap = useMemo<Record<string, SystemBodyInfo>>(() => {
    const map: Record<string, SystemBodyInfo> = {};
    const hasMultipleStars = starModels.length > 1;
    starModels.forEach((star, index) => {
      const suffix = String.fromCharCode(65 + index);
      const starName = hasMultipleStars
        ? t('systemView.bodyInfo.starNameWithSuffix', { system: starSystem.name, suffix })
        : t('systemView.bodyInfo.starName', { system: starSystem.name });
      map[star.id] = {
        id: star.id,
        name: starName,
        bodyType: 'star' as CelestialBodyType,
        bodySubType: star.data.spectralType ?? astro?.primarySpectralType,
        radiusKm: star.radiusKm,
        isSolid: false
      };
    });

    sourcePlanets.forEach((planet, index) => {
      const fallbackPlanetId = `planet-${starSystem.id}-${index + 1}`;
      const planetId = planet.id ?? fallbackPlanetId;
      const planetName = planet.name ?? t('systemView.bodyInfo.unnamedPlanet', { index: index + 1 });
      const planetType = getPlanetType(planet);
      const surfaceBodyId = planet.id ?? planetId;
      map[planetId] = {
        id: planetId,
        name: planetName,
        bodyType: 'planet',
        bodySubType: planetType,
        radiusKm: getPlanetRadiusKm(planet),
        atmosphere: (planet as PlanetData).atmosphere,
        habitabilityScore: (planet as { habitabilityScore?: number }).habitabilityScore,
        isSolid: (planet as { isSolid?: boolean }).isSolid ?? true,
        surfaceBodyId
      };

      const moons = (planet.moons ?? []) as MoonSource[];
      moons.forEach((moon, moonIndex) => {
        const moonId = moon.id ?? `moon-${starSystem.id}-${index + 1}-${moonIndex + 1}`;
        const moonName = moon.name ?? t('moon.name', { index: moonIndex + 1 });
        map[moonId] = {
          id: moonId,
          name: moonName,
          bodyType: 'moon',
          bodySubType: getMoonType(moon),
          radiusKm: getMoonRadiusKm(moon),
          atmosphere: moon.atmosphere,
          habitabilityScore: (moon as { habitabilityScore?: number }).habitabilityScore,
          isSolid: moon.isSolid ?? true,
          surfaceBodyId: moon.id ?? moonId
        };
      });
    });

    return map;
  }, [astro?.primarySpectralType, sourcePlanets, starModels, starSystem.id, starSystem.name, t]);
  const systemFleets = useMemo(() => getSystemFleets(starSystem, fleets), [fleets, starSystem]);
  const systemStations = useMemo(
    () => stations.filter((station) => station.systemId === starSystem.id),
    [stations, starSystem.id]
  );
  const fleetById = useMemo(() => new Map(systemFleets.map((fleet) => [fleet.id, fleet])), [systemFleets]);
  const stationById = useMemo(() => new Map(systemStations.map((station) => [station.id, station])), [systemStations]);
  const factionById = useMemo(() => new Map(factions.map((faction) => [faction.id, faction])), [factions]);

  const [hoveredObjectId, setHoveredObjectId] = useState<SystemObjectId | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<SystemObjectId | null>(null);

  useEffect(() => {
    if (selectedFleetId && fleetById.has(selectedFleetId)) {
      setSelectedObjectId(makeObjectId('fleet', selectedFleetId));
    }
  }, [fleetById, selectedFleetId]);
  useEffect(() => {
    if (!selectedFleetId) {
      const parsed = parseObjectId(selectedObjectId);
      if (parsed?.kind === 'fleet') {
        setSelectedObjectId(null);
      }
    }
  }, [selectedFleetId, selectedObjectId]);

  const selectedBodyId = useMemo(() => {
    const parsed = parseObjectId(selectedObjectId);
    return parsed?.kind === 'body' ? parsed.id : null;
  }, [selectedObjectId]);
  const hoveredBodyId = useMemo(() => {
    const parsed = parseObjectId(hoveredObjectId);
    return parsed?.kind === 'body' ? parsed.id : null;
  }, [hoveredObjectId]);

  const displayedObject = useMemo(
    () => parseObjectId(selectedObjectId ?? hoveredObjectId),
    [hoveredObjectId, selectedObjectId]
  );
  const displayedBody = displayedObject?.kind === 'body' ? bodyInfoMap[displayedObject.id] : undefined;
  const displayedFleet = displayedObject?.kind === 'fleet' ? fleetById.get(displayedObject.id) : undefined;
  const displayedStation = displayedObject?.kind === 'station' ? stationById.get(displayedObject.id) : undefined;
  const displayedFleetName = displayedFleet ? getFleetName(displayedFleet.id) : '';
  const displayedFleetFaction = displayedFleet ? factionById.get(displayedFleet.factionId) : undefined;
  const displayedStationFaction = displayedStation ? factionById.get(displayedStation.factionId) : undefined;
  const displayedFleetPower = displayedFleet ? calculateFleetPower(displayedFleet) : undefined;
  const displayedStationName = displayedStation
    ? (displayedStation.name ?? t('systemView.stationInfo.unnamedStation', { code: shortId(displayedStation.id) }))
    : '';
  const isSelectionActive = Boolean(selectedObjectId);

  const handleHoverBody = useCallback((bodyId: string) => {
    setHoveredObjectId(makeObjectId('body', bodyId));
  }, []);
  const handleBlurBody = useCallback((bodyId: string) => {
    const objectId = makeObjectId('body', bodyId);
    setHoveredObjectId(prev => (prev === objectId ? null : prev));
  }, []);
  const handleSelectBody = useCallback((bodyId: string) => {
    setSelectedObjectId(makeObjectId('body', bodyId));
    onSelectFleet?.(null);
  }, [onSelectFleet]);
  const handleHoverObject = useCallback((objectId: SystemObjectId) => {
    setHoveredObjectId(objectId);
  }, []);
  const handleBlurObject = useCallback((objectId: SystemObjectId) => {
    setHoveredObjectId(prev => (prev === objectId ? null : prev));
  }, []);
  const handleSelectObject = useCallback((objectId: SystemObjectId) => {
    setSelectedObjectId(objectId);
    const parsed = parseObjectId(objectId);
    if (parsed?.kind === 'fleet') {
      onSelectFleet?.(parsed.id);
    } else {
      onSelectFleet?.(null);
    }
  }, [onSelectFleet]);
  const getFactionColor = useCallback(
    (id: string) => factionById.get(id)?.color ?? '#94a3b8',
    [factionById]
  );
  const clearSelection = useCallback(() => {
    setSelectedObjectId(null);
    onSelectFleet?.(null);
  }, [onSelectFleet]);
  useEffect(() => {
    setHoveredObjectId(null);
    setSelectedObjectId(null);
  }, [starSystem.id]);
  const fleetIconScale = 0.45 * clampedScale;
  const eclipticEpsilon = Math.max(fleetIconScale * 0.02, clampedScale * 0.01);
  const fleetRingSpacing = Math.max(fleetIconScale * 4, clampedScale * 1.1);
  const fleetSafetyMargin = Math.max(fleetIconScale * 2.6, clampedScale * 1.1);
  const fleetOrbitClearance = Math.max(fleetRingSpacing * 0.45, fleetIconScale * 2.2, clampedScale * 0.9);
  const fleetRingBase = useMemo(
    () => computeFleetRingBaseRadius({
      starRadius,
      focusDistanceFloor,
      planets,
      safetyMargin: fleetSafetyMargin,
      minimumOrbitClearance: fleetOrbitClearance
    }),
    [focusDistanceFloor, fleetOrbitClearance, fleetSafetyMargin, planets, starRadius]
  );
  const fleetLayoutConfig = useMemo<TacticalRingConfig>(() => ({
    baseRadius: fleetRingBase,
    ringSpacing: fleetRingSpacing,
    maxPerRing: 12,
    yOffset: eclipticEpsilon,
    rotationSpeed: 0.12
  }), [eclipticEpsilon, fleetRingBase, fleetRingSpacing]);
  const stationIconScale = 0.55 * clampedScale;
  const fleetLayoutsForFocus = useMemo(
    () => layoutTacticalRing(systemFleets, fleetLayoutConfig, day),
    [day, fleetLayoutConfig, systemFleets]
  );
  const fleetPositionById = useMemo(
    () => new Map(fleetLayoutsForFocus.map(layout => [layout.entity.id, layout.position])),
    [fleetLayoutsForFocus]
  );
  const stationPositionById = useMemo(() => {
    const orderedStations = sorted(systemStations, (a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
    const slotCapacity = 8;
    const stationSpacing = Math.max(stationIconScale * 2.6, clampedScale * 0.9);
    const stationYOffset = stationIconScale * 0.3;

    return new Map(
      orderedStations.map((station, index) => {
        const anchorId = station.anchorBodyId ?? starBodyId;
        const anchorPosition = bodyWorldPositions[anchorId] ?? bodyWorldPositions[starBodyId] ?? [0, 0, 0];
        const anchorRadius = bodyRadii[anchorId] ?? starRadius;
        const baseRadius = Math.max(anchorRadius * 2.6, stationIconScale * 2.4);
        const slotIndex = typeof station.slotIndex === 'number' ? station.slotIndex : index;
        const ringIndex = typeof station.slotIndex === 'number'
          ? Math.floor(slotIndex / slotCapacity)
          : 0;
        const angle = typeof station.slotIndex === 'number'
          ? ((slotIndex % slotCapacity) / slotCapacity) * Math.PI * 2
          : hashStringToAngle(station.id);
        const radius = baseRadius + ringIndex * stationSpacing;
        const position: [number, number, number] = [
          anchorPosition[0] + Math.cos(angle) * radius,
          anchorPosition[1] + stationYOffset,
          anchorPosition[2] + Math.sin(angle) * radius
        ];
        return [station.id, position] as const;
      })
    );
  }, [bodyRadii, bodyWorldPositions, clampedScale, starBodyId, starRadius, stationIconScale, systemStations]);
  const maxOrbitRadius = useMemo(() => {
    const starExtent = starModels.reduce((max, star) => {
      const [x, y, z] = star.position;
      const distance = Math.sqrt(x * x + y * y + z * z);
      return Math.max(max, distance + star.radius);
    }, starRadius);

    return planets.reduce((max, planet) => {
      const planetExtent = planet.orbitRadius + planet.radius;
      const moonExtent = planet.moons.reduce(
        (moonMax, moon) => Math.max(moonMax, planet.orbitRadius + moon.orbitRadius + moon.radius),
        planetExtent
      );
      return Math.max(max, moonExtent);
    }, starExtent);
  }, [planets, starModels, starRadius]);
  const cameraMaxDistance = Math.max(maxOrbitRadius * SYSTEM_VIEW_CAMERA_MAX_DISTANCE_FACTOR, baseCameraDistance);
  const ambientLightIntensity = MathUtils.clamp(0.12 + clampedScale * 0.03, 0.1, 0.22);
  const hemisphereLightIntensity = MathUtils.clamp(0.18 + clampedScale * 0.04, 0.16, 0.32);
  const starLightDistance = Math.max(maxOrbitRadius * 8, starRadius * 60);
  const starLightIntensity = MathUtils.clamp(MathUtils.clamp(3.5 + starRadius * 1.6, 3.5, 14) * 35, 45, 260);
  const ambientLightColor = useMemo(
    () => new Color(starTintColor).lerp(new Color('#0b1020'), 0.7).getStyle(),
    [starTintColor]
  );
  const hemisphereSkyColor = useMemo(
    () => new Color('#ffffff').lerp(new Color(starTintColor), 0.2).getStyle(),
    [starTintColor]
  );
  const hemisphereGroundColor = useMemo(
    () => new Color('#0b1020').getStyle(),
    []
  );
  const starLightColor = useMemo(
    () => new Color('#ffffff').lerp(new Color(starTintColor), 0.2).getStyle(),
    [starTintColor]
  );
  useEffect(() => {
    sunColorRef.current.set(starLightColor);
  }, [starLightColor]);
  const starIdSet = useMemo(() => new Set(starModels.map(star => star.id)), [starModels]);
  const cameraZoomConstraints = useMemo(() => {
    const anchorId = anchoredBodyId ?? starBodyId;
    const anchoredRadius = bodyRadii[anchorId];
    const effectiveRadius = typeof anchoredRadius === 'number' ? anchoredRadius : focusDistanceFloor;
    const isStarAnchor = starIdSet.has(anchorId);
    const minRadiusDistance = effectiveRadius * SYSTEM_VIEW_CAMERA_MIN_DISTANCE_RADIUS_FACTOR;
    const minDistance = isStarAnchor ? Math.max(focusDistanceFloor, minRadiusDistance) : minRadiusDistance;
    return {
      minDistance,
      effectiveRadius,
      surfaceClearance: Math.max(minDistance - effectiveRadius, 0.0001 * clampedScale),
      isStarAnchor
    };
  }, [anchoredBodyId, bodyRadii, clampedScale, focusDistanceFloor, starBodyId, starIdSet]);
  const cameraMinDistance = cameraZoomConstraints.minDistance;
  const rotateSpeed = MathUtils.clamp(1 / clampedScale, 0.35, 2.5);
  const zoomSpeed = MathUtils.clamp(1 / clampedScale, 0.4, 3);
  const cameraFar = cameraMaxDistance + maxOrbitRadius * 2.5;
  const cameraNear = cameraZoomConstraints.isStarAnchor
    ? Math.max(0.05, Math.min(cameraMinDistance * 0.25, cameraFar / 2000))
    : Math.max(0.001 * clampedScale, Math.min(cameraZoomConstraints.surfaceClearance * 0.5, cameraFar / 20000));
  const starfieldRadius = Math.max(cameraFar * 0.9, maxOrbitRadius * 4);
  const focusRequestRef = useRef<FocusRequest | null>(null);
  const anchoredTarget = useMemo<[number, number, number]>(() => {
    return bodyWorldPositions[anchoredBodyId ?? ''] ?? bodyWorldPositions[starBodyId] ?? [0, 0, 0];
  }, [anchoredBodyId, bodyWorldPositions, starBodyId]);
  const cameraInitialSpherical = useMemo<CameraSphericalState>(() => (
    deriveSphericalState(initialCameraState, anchoredTarget, defaultCameraPosition)
  ), [anchoredTarget, defaultCameraPosition, initialCameraState]);
  const lastCameraStateRef = useRef<SystemCameraState>({
    ...cameraInitialSpherical,
    anchoredBodyId: anchoredBodyId ?? starBodyId
  });
  useEffect(() => {
    lastCameraStateRef.current = {
      ...cameraInitialSpherical,
      anchoredBodyId: anchoredBodyId ?? starBodyId
    };
  }, [anchoredBodyId, cameraInitialSpherical, starBodyId]);
  useEffect(() => {
    setAnchoredBodyId(resolvedAnchoredBodyId ?? starBodyId);
  }, [resolvedAnchoredBodyId, starBodyId]);
  const bodyLabels = useMemo<BodyLabelTarget[]>(() => {
    const labels: BodyLabelTarget[] = [];

    planets.forEach((planet) => {
      const planetPosition = bodyWorldPositions[planet.id];
      const planetRadius = bodyRadii[planet.id];
      if (planetPosition && planetRadius) {
        labels.push({
          id: planet.id,
          name: bodyInfoMap[planet.id]?.name ?? planet.id,
          position: planetPosition,
          radius: planetRadius,
          kind: 'planet'
        });
      }
      planet.moons.forEach((moon) => {
        const moonPosition = bodyWorldPositions[moon.id];
        const moonRadius = bodyRadii[moon.id];
        if (moonPosition && moonRadius && planetPosition && planetRadius) {
          labels.push({
            id: moon.id,
            name: bodyInfoMap[moon.id]?.name ?? moon.id,
            position: moonPosition,
            radius: moonRadius,
            kind: 'moon',
            parent: {
              position: planetPosition,
              radius: planetRadius
            }
          });
        }
      });
    });

    return labels;
  }, [bodyInfoMap, bodyRadii, bodyWorldPositions, planets]);
  const requestFocusOnPoint = useCallback((
    position: [number, number, number],
    radius: number,
    anchorId?: string
  ) => {
    const minDistanceForTarget = Math.max(focusDistanceFloor, radius * 2);
    const desiredDistance = Math.min(Math.max(radius * 8, minDistanceForTarget), cameraMaxDistance * 0.95);
    focusRequestRef.current = {
      target: new Vector3(...position),
      distance: desiredDistance
    };
    if (anchorId) {
      setAnchoredBodyId(anchorId);
    }
  }, [cameraMaxDistance, focusDistanceFloor]);
  const requestFocusOnBody = useCallback((bodyId: string) => {
    const position = bodyWorldPositions[bodyId];
    if (!position) return;
    const radius = bodyRadii[bodyId] ?? focusDistanceFloor;
    requestFocusOnPoint(position, radius, bodyId);
  }, [bodyRadii, bodyWorldPositions, focusDistanceFloor, requestFocusOnPoint]);
  const handleResetCamera = useCallback(() => {
    const anchorPosition = bodyWorldPositions[starBodyId] ?? [0, 0, 0];
    const resetDistance = Math.min(Math.max(baseCameraDistance, focusDistanceFloor * 3), cameraMaxDistance * 0.8);
    focusRequestRef.current = {
      target: new Vector3(...anchorPosition),
      distance: resetDistance
    };
    setAnchoredBodyId(starBodyId);
  }, [baseCameraDistance, bodyWorldPositions, cameraMaxDistance, focusDistanceFloor, starBodyId]);
  const handleCenterBody = useCallback((bodyId: string) => {
    requestFocusOnBody(bodyId);
  }, [requestFocusOnBody]);
  const handleCenterFleet = useCallback((fleetId: string) => {
    const position = fleetPositionById.get(fleetId);
    if (!position) return;
    requestFocusOnPoint(position, fleetIconScale * 6);
  }, [fleetIconScale, fleetPositionById, requestFocusOnPoint]);
  const handleCenterStation = useCallback((stationId: string) => {
    const position = stationPositionById.get(stationId);
    if (!position) return;
    requestFocusOnPoint(position, stationIconScale * 6);
  }, [requestFocusOnPoint, stationIconScale, stationPositionById]);
  const initialCameraPosition = useMemo<[number, number, number]>(() => (
    positionFromSpherical(cameraInitialSpherical, anchoredTarget)
  ), [
    anchoredTarget,
    cameraInitialSpherical.phi,
    cameraInitialSpherical.radius,
    cameraInitialSpherical.theta
  ]);

  const prefersTouchFallback = typeof window !== 'undefined' && (
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
    || (typeof window.matchMedia !== 'function' && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  );
  const maxDpr = prefersTouchFallback ? MAX_DPR_MOBILE : MAX_DPR_DESKTOP;
  const toneMappingExposure = prefersTouchFallback ? 1.05 : 1.12;
  const shadowMapSize = prefersTouchFallback ? 512 : 1024;
  const shadowCameraFar = Math.max(maxOrbitRadius * 2.2, starRadius * 120);
  const shadowCameraNear = Math.max(0.02 * clampedScale, 0.005);
  const bloomIntensity = prefersTouchFallback ? 0.4 : 0.75;
  const bloomThreshold = prefersTouchFallback ? 0.32 : 0.26;
  const bloomSmoothing = prefersTouchFallback ? 0.75 : 0.6;
  const bloomRadius = prefersTouchFallback ? 0.2 : 0.38;
  const vignetteOffset = prefersTouchFallback ? 0.68 : 0.62;
  const vignetteDarkness = prefersTouchFallback ? 0.14 : 0.2;
  const cloudShadowStrengthScale = prefersTouchFallback ? 0.2 : 1;
  const rimLightIntensity = prefersTouchFallback ? 0.12 : 0.18;
  const rimLightDistance = Math.max(cameraFar * 0.8, maxOrbitRadius * 3.2);
  const rimLightColor = useMemo(
    () => new Color('#e6ecff').lerp(new Color(starTintColor), 0.3).getStyle(),
    [starTintColor]
  );

  return (
    <div className="relative w-full h-full bg-black">
        <Canvas
          shadows
        onCreated={({ gl }) => {
          gl.shadowMap.type = PCFSoftShadowMap;
          gl.outputColorSpace = SRGBColorSpace;
          gl.toneMapping = ACESFilmicToneMapping;
          gl.toneMappingExposure = toneMappingExposure;
        }}
        camera={{ position: initialCameraPosition, fov: 55, near: cameraNear, far: cameraFar }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        dpr={[1, maxDpr]}
      >
        <color attach="background" args={['#000000']} />
        <SystemStarfield
          radius={starfieldRadius}
          seedKey={`${starSystem.id}-${astroKey}-starfield`}
          tintColor={starTintColor}
        />
        <SystemRimLight
          intensity={rimLightIntensity}
          color={rimLightColor}
          distance={rimLightDistance}
          target={anchoredTarget}
        />
        <ambientLight intensity={ambientLightIntensity} color={ambientLightColor} />
        <hemisphereLight
          intensity={hemisphereLightIntensity}
          color={hemisphereSkyColor}
          groundColor={hemisphereGroundColor}
        />
        <pointLight
          position={[0, 0, 0]}
          intensity={starLightIntensity}
          distance={starLightDistance}
          decay={2}
          color={starLightColor}
          castShadow
          shadow-mapSize={[shadowMapSize, shadowMapSize]}
          shadow-camera-near={shadowCameraNear}
          shadow-camera-far={shadowCameraFar}
          shadow-bias={-0.00015}
          shadow-normalBias={0.02}
        />

        <SystemCamera
          maxDistance={cameraMaxDistance}
          minDistance={cameraMinDistance}
          focusRequest={focusRequestRef}
          initialSpherical={cameraInitialSpherical}
          onCameraStateChange={onCameraStateChange}
          lastCameraStateRef={lastCameraStateRef}
          anchoredTarget={anchoredTarget}
          anchoredBodyId={anchoredBodyId}
          rotateSpeed={rotateSpeed}
          zoomSpeed={zoomSpeed}
          cameraNear={cameraNear}
          cameraFar={cameraFar}
        />

        <SystemRoot>
          <SystemSurfaceTextureManager
            starSystem={starSystem}
            astroKey={astroKey}
            planetSurfaceDescriptorsByBodyId={planetSurfaceDescriptorsByBodyId ?? undefined}
            ownerKeyByBodyId={ownerKeyByBodyId}
            planets={planets}
            bodyWorldPositions={bodyWorldPositions}
            bodyRadii={bodyRadii}
            selectedBodyId={selectedBodyId}
            hoveredBodyId={hoveredBodyId}
            cloudShadowStrengthScale={cloudShadowStrengthScale}
            resolveMaterial={resolveBodyMaterial}
          />
          <SystemCelestialLayer
            stars={starModels}
            starGeometry={starGeometry}
            planets={planets}
            orbitMaterial={orbitMaterial}
            orbitShadowMaterial={orbitShadowMaterial}
            planetGeometry={planetGeometry}
            moonGeometry={moonGeometry}
            resolvePlanetMaterial={resolvePlanetMaterial}
            resolveMoonMaterial={resolveMoonMaterial}
            resolveAtmosphereBundle={resolveAtmosphereBundle}
            orbitThickness={orbitThickness}
            onFocusBody={requestFocusOnBody}
            onHoverBody={handleHoverBody}
            onBlurBody={handleBlurBody}
            onSelectBody={handleSelectBody}
          />
          <SystemEntitiesLayer
            starBodyId={starBodyId}
            fleets={systemFleets}
            stations={systemStations}
            day={day}
            starRadius={starRadius}
            bodyWorldPositions={bodyWorldPositions}
            bodyRadii={bodyRadii}
            clampedScale={clampedScale}
            selectedFleetId={selectedFleetId}
            selectedObjectId={selectedObjectId}
            hoveredObjectId={hoveredObjectId}
            fleetIconScale={fleetIconScale}
            fleetLayoutConfig={fleetLayoutConfig}
            getFactionColor={getFactionColor}
            onHoverObject={handleHoverObject}
            onBlurObject={handleBlurObject}
            onSelectObject={handleSelectObject}
            onFocusPoint={requestFocusOnPoint}
          />
          {showBodyLabels && (
            <SystemBodyLabels
              labels={bodyLabels}
              baseScale={clampedScale}
            />
          )}
        </SystemRoot>
        <EffectComposer enableNormalPass={false}>
          <SMAA />
          <Bloom
            intensity={bloomIntensity}
            mipmapBlur={!prefersTouchFallback}
            radius={bloomRadius}
            luminanceThreshold={bloomThreshold}
            luminanceSmoothing={bloomSmoothing}
          />
          <Vignette offset={vignetteOffset} darkness={vignetteDarkness} />
        </EffectComposer>
      </Canvas>
      <div className="pointer-events-none absolute inset-0 flex items-start justify-start p-4">
        <div className="pointer-events-auto flex gap-2">
          <button
            type="button"
            onClick={handleResetCamera}
            className="rounded border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow transition hover:border-slate-500 hover:bg-slate-700"
          >
            {t('systemView.actions.resetCamera')}
          </button>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-end justify-end p-4">
        <div className="pointer-events-auto w-80 max-w-full">
          {displayedBody ? (
            <SystemBodyInfoPanel
              body={displayedBody}
              isSelected={isSelectionActive}
              onClearSelection={isSelectionActive ? clearSelection : undefined}
              onCenter={() => handleCenterBody(displayedBody.id)}
              onOpenSurfaceView={onOpenSurfaceView}
            />
          ) : displayedFleet ? (
            <SystemFleetInfoPanel
              fleet={displayedFleet}
              fleetName={displayedFleetName}
              factionName={displayedFleetFaction?.name ?? t('systemView.fleetInfo.unknownFaction')}
              factionColor={displayedFleetFaction?.color}
              power={displayedFleetPower}
              isSelected={isSelectionActive}
              onClearSelection={isSelectionActive ? clearSelection : undefined}
              onCenter={() => handleCenterFleet(displayedFleet.id)}
              onInspect={onInspectFleet ? () => onInspectFleet(displayedFleet.id) : undefined}
            />
          ) : displayedStation ? (
            <SystemStationInfoPanel
              station={displayedStation}
              stationName={displayedStationName}
              factionName={displayedStationFaction?.name ?? t('systemView.fleetInfo.unknownFaction')}
              factionColor={displayedStationFaction?.color}
              isSelected={isSelectionActive}
              onClearSelection={isSelectionActive ? clearSelection : undefined}
              onCenter={() => handleCenterStation(displayedStation.id)}
            />
          ) : (
            <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-4 text-sm text-slate-200 shadow-lg">
              <div className="text-xs uppercase tracking-wide text-slate-400">{t('systemView.objectInfo.title')}</div>
              <div className="mt-2 text-slate-300">{t('systemView.objectInfo.hoverHint')}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SystemView3D;
