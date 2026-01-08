import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Billboard, OrbitControls, Text } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import {
  AdditiveBlending,
  BackSide,
  Camera,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  Euler,
  Group,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Material,
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Mesh,
  Object3D,
  PerspectiveCamera,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  ShaderMaterial,
  Spherical,
  SphereGeometry,
  TorusGeometry,
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
import { SurfaceMapWorkerClient, buildSurfaceMapWorkerRequest, type SurfaceTextureResult } from '../../workers';

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
const LENS_FLARE_TEXTURE_SIZE = 128;
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
const SYSTEM_VIEW_CAMERA_MIN_DISTANCE_RADIUS_FACTOR = 1.15;

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
const SURFACE_TEXTURE_MAX_CACHE_ENTRIES = 12;
const SURFACE_TEXTURE_MAX_INFLIGHT = 2;
const DAY_NIGHT_TERMINATOR_SOFTNESS = 0.22;
const DAY_NIGHT_NIGHT_MIN = 0.08;
const ATMOSPHERE_DAY_NIGHT_NIGHT_MIN = 0.12;

type SurfaceTextureResolution = { width: number; height: number };

const pickSurfaceTextureResolution = (diameterPx: number): SurfaceTextureResolution | null => {
  if (!Number.isFinite(diameterPx) || diameterPx < SURFACE_TEXTURE_MIN_DIAMETER_PX) return null;
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
vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
vWorldPosition = worldPosition.xyz;`
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
        '#include <output_fragment>',
        `float sunDistance = length(vWorldPosition);
vec3 sunDir = sunDistance > 0.000001 ? (-vWorldPosition / sunDistance) : vec3(0.0, 0.0, 1.0);
float nDotL = dot(normalize(vWorldNormal), sunDir);
float terminator = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, nDotL);
float lightFactor = mix(uNightMin, 1.0, terminator);
gl_FragColor = vec4(outgoingLight * lightFactor, diffuseColor.a);`
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
  const atmosphere = (planet as PlanetData).atmosphere;

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
    return {
      id: moonId,
      radius: Math.max(moonRadiusKm * sceneScale * RADIUS_VISIBILITY_BONUS, minMoonRadius),
      orbitRadius: moonOrbitRadius,
      orbitAngle: moonAngle,
      orbitInclinationDeg: moonInclinationDeg,
      orbitAscendingNodeDeg: moonAscendingNodeDeg,
      type: getMoonType(moon as MoonSource),
      isSolid: (moon as MoonSource).isSolid,
      atmosphere: (moon as MoonSource).atmosphere
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
    moons
  };
};

const applyPlanetOrbitSpacing = (
  planets: OrbitingPlanet[],
  starRadius: number,
  planetOrbitClearance: number
): OrbitingPlanet[] => {
  let lastOrbitRadius = starRadius;
  let lastPlanetRadius = 0;

  return planets.map((planet, index) => {
    const minimumDistanceFromStar = starRadius + planet.radius + planetOrbitClearance;
    const minimumDistanceFromPrevious = index === 0
      ? minimumDistanceFromStar
      : lastOrbitRadius + lastPlanetRadius + planet.radius + planetOrbitClearance;
    const adjustedOrbitRadius = Math.max(planet.orbitRadius, minimumDistanceFromPrevious);
    lastOrbitRadius = adjustedOrbitRadius;
    lastPlanetRadius = planet.radius;
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
      scratch: {
        starWorld: new Vector3(),
        lensWorld: new Vector3(),
        lensLocal: new Vector3(),
        projected: new Vector3(),
        toCamera: new Vector3()
      }
    };
  }, [tintColor]);

  useEffect(() => {
    return () => {
      lensFlareState.lensflare.dispose();
    };
  }, [lensFlareState]);

  useFrame((state, delta) => {
    if (!coreRef.current) return;
    coreRef.current.rotation.y += delta * 0.08;
    coreRef.current.rotation.z += delta * 0.02;

    if (!groupRef.current) return;

    const { scratch, lensflare, elements, baseColors, sizeScales, intensityScales } = lensFlareState;
    groupRef.current.getWorldPosition(scratch.starWorld);
    scratch.toCamera.copy(state.camera.position).sub(scratch.starWorld);
    const distanceToCamera = scratch.toCamera.length();
    if (!Number.isFinite(distanceToCamera) || distanceToCamera < 0.001) {
      lensflare.visible = false;
      return;
    }

    scratch.toCamera.divideScalar(distanceToCamera);
    scratch.lensWorld.copy(scratch.starWorld).addScaledVector(scratch.toCamera, radius * 1.02);
    scratch.lensLocal.copy(scratch.lensWorld);
    groupRef.current.worldToLocal(scratch.lensLocal);
    lensflare.position.copy(scratch.lensLocal);

    scratch.projected.copy(scratch.lensWorld).project(state.camera);
    const onScreen = scratch.projected.z > -1
      && scratch.projected.z < 1
      && Math.abs(scratch.projected.x) <= 1.2
      && Math.abs(scratch.projected.y) <= 1.2;

    const centerDist = Math.sqrt(scratch.projected.x * scratch.projected.x + scratch.projected.y * scratch.projected.y);
    const centerFactor = 1 - MathUtils.smoothstep(centerDist, 0.15, 0.95);
    const intensity = MathUtils.clamp(Math.pow(centerFactor, 1.25), 0, 1);

    const shouldShow = onScreen && intensity > 0.02;
    lensflare.visible = shouldShow;
    if (!shouldShow) return;

    const viewportHeightPx = state.size.height * state.gl.getPixelRatio();
    const fovRad = (state.camera as PerspectiveCamera).isPerspectiveCamera
      ? MathUtils.degToRad((state.camera as PerspectiveCamera).fov)
      : MathUtils.degToRad(55);
    const starDiameterPx = (radius / distanceToCamera) * (viewportHeightPx / Math.tan(fovRad * 0.5));
    const baseSizePx = MathUtils.clamp(starDiameterPx * 1.4, 48, viewportHeightPx * 0.75);

    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      element.size = baseSizePx * sizeScales[index];
      element.color.copy(baseColors[index]).multiplyScalar(intensity * intensityScales[index]);
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
      <primitive object={lensFlareState.lensflare} dispose={null} />
    </group>
  );
};

interface MoonOrbitGroupProps {
  moon: OrbitingMoon;
  orbitMaterial: MeshBasicMaterial;
  moonGeometry: SphereGeometry;
  moonMaterial: MeshStandardMaterial;
  atmosphereMaterials: Partial<Record<Exclude<AtmosphereType, 'None'>, ShaderMaterial>>;
  orbitThickness: number;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string) => void;
}

const MoonOrbitGroup: React.FC<MoonOrbitGroupProps & { onFocus: (bodyId: string) => void }> = ({
  moon,
  orbitMaterial,
  moonGeometry,
  moonMaterial,
  atmosphereMaterials,
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

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} frustumCulled />
      <mesh
        geometry={moonGeometry}
        material={hitboxMaterial}
        position={moonPosition}
        scale={moonHitboxScale}
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
        position={moonPosition}
        scale={moonScale}
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
      {moon.atmosphere && moon.atmosphere !== 'None' && (
        <group position={moonPosition}>
          <AtmosphereShell
            geometry={moonGeometry}
            radius={moon.radius}
            atmosphere={moon.atmosphere}
            materialByType={atmosphereMaterials}
          />
        </group>
      )}
    </group>
  );
};

interface PlanetOrbitGroupProps {
  planet: OrbitingPlanet;
  orbitMaterial: MeshBasicMaterial;
  planetGeometry: SphereGeometry;
  moonGeometry: SphereGeometry;
  planetMaterial: MeshStandardMaterial;
  resolveMoonMaterial: (moon: OrbitingMoon) => MeshStandardMaterial;
  atmosphereMaterials: Partial<Record<Exclude<AtmosphereType, 'None'>, ShaderMaterial>>;
  orbitThickness: number;
  onFocus: (bodyId: string) => void;
  onHover: (bodyId: string) => void;
  onBlur: (bodyId: string) => void;
  onSelect: (bodyId: string) => void;
}

const PlanetOrbitGroup: React.FC<PlanetOrbitGroupProps> = ({
  planet,
  orbitMaterial,
  planetGeometry,
  moonGeometry,
  planetMaterial,
  resolveMoonMaterial,
  atmosphereMaterials,
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

  return (
    <group>
      <mesh geometry={orbitGeometry} material={orbitMaterial} rotation={orbitRotation} frustumCulled />
      <group position={planetPosition}>
        <mesh
          geometry={planetGeometry}
          material={hitboxMaterial}
          scale={planetHitboxScale}
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
        {planet.atmosphere && planet.atmosphere !== 'None' && (
          <AtmosphereShell
            geometry={planetGeometry}
            radius={planet.radius}
            atmosphere={planet.atmosphere}
            materialByType={atmosphereMaterials}
          />
        )}
        {planet.moons.map(moon => (
          <MoonOrbitGroup
            key={moon.id}
            moon={moon}
            orbitMaterial={orbitMaterial}
            moonGeometry={moonGeometry}
            moonMaterial={resolveMoonMaterial(moon)}
            atmosphereMaterials={atmosphereMaterials}
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
  planetGeometry: SphereGeometry;
  moonGeometry: SphereGeometry;
  resolvePlanetMaterial: (planet: OrbitingPlanet) => MeshStandardMaterial;
  resolveMoonMaterial: (moon: OrbitingMoon) => MeshStandardMaterial;
  atmosphereMaterials: Partial<Record<Exclude<AtmosphereType, 'None'>, ShaderMaterial>>;
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
  planetGeometry,
  moonGeometry,
  resolvePlanetMaterial,
  resolveMoonMaterial,
  atmosphereMaterials,
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
          planetGeometry={planetGeometry}
          moonGeometry={moonGeometry}
          planetMaterial={resolvePlanetMaterial(planet)}
          resolveMoonMaterial={resolveMoonMaterial}
          atmosphereMaterials={atmosphereMaterials}
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

const ATMOSPHERE_STYLE: Record<Exclude<AtmosphereType, 'None'>, { color: string; intensity: number; power: number; scale: number }> = {
  Thin: { color: '#a5f3fc', intensity: 0.6, power: 3.0, scale: 1.035 },
  Earthlike: { color: '#38bdf8', intensity: 0.85, power: 2.6, scale: 1.05 },
  CO2: { color: '#fb923c', intensity: 0.9, power: 2.4, scale: 1.06 },
  H2He: { color: '#a78bfa', intensity: 1.05, power: 2.2, scale: 1.09 }
};

const createAtmosphereMaterial = (params: { color: string; intensity: number; power: number }): ShaderMaterial => {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: BackSide,
    uniforms: {
      uColor: { value: new Color(params.color) },
      uIntensity: { value: params.intensity },
      uPower: { value: params.power },
      uNightMin: { value: ATMOSPHERE_DAY_NIGHT_NIGHT_MIN },
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
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uPower;
      uniform float uNightMin;
      uniform float uTerminatorSoftness;
      varying vec3 vWorldPosition;
      varying vec3 vWorldNormal;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        float ndv = max(dot(normalize(vWorldNormal), viewDir), 0.0);
        float rim = pow(1.0 - ndv, uPower);
        float sunDistance = length(vWorldPosition);
        vec3 sunDir = sunDistance > 0.000001 ? (-vWorldPosition / sunDistance) : vec3(0.0, 0.0, 1.0);
        float nDotL = dot(normalize(vWorldNormal), sunDir);
        float terminator = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, nDotL);
        float lightFactor = mix(uNightMin, 1.0, terminator);
        vec3 color = uColor * rim * uIntensity * lightFactor;
        gl_FragColor = vec4(color, rim * uIntensity * lightFactor);
      }
    `,
    toneMapped: false
  });
};

const AtmosphereShell: React.FC<{
  geometry: SphereGeometry;
  radius: number;
  atmosphere?: AtmosphereType;
  materialByType: Partial<Record<Exclude<AtmosphereType, 'None'>, ShaderMaterial>>;
}> = ({ geometry, radius, atmosphere, materialByType }) => {
  if (!atmosphere || atmosphere === 'None') return null;
  const style = ATMOSPHERE_STYLE[atmosphere];
  const material = materialByType[atmosphere];
  if (!style || !material) return null;

  const shellRadius = radius * style.scale;
  return (
    <mesh
      geometry={geometry}
      material={material}
      scale={[shellRadius, shellRadius, shellRadius]}
      frustumCulled
      raycast={() => {}}
    />
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
  resolveMaterial
}) => {
  const { camera, gl, size } = useThree();
  const workerRef = useRef<SurfaceMapWorkerClient | null>(null);
  const cacheRef = useRef<Map<string, DataTexture>>(new Map());
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

  useEffect(() => {
    requestStateRef.current = ({
      systems: [starSystem],
      planetSurfaceDescriptorsByBodyId
    } as unknown as GameState);
  }, [planetSurfaceDescriptorsByBodyId, starSystem]);

  useEffect(() => {
    workerRef.current = new SurfaceMapWorkerClient();
    return () => {
      workerRef.current?.dispose();
      workerRef.current = null;
      cacheRef.current.forEach(texture => texture.dispose());
      cacheRef.current.clear();
      cacheLastUsedRef.current.clear();
      inFlightRef.current.clear();
      desiredKeyByBodyIdRef.current.clear();
    };
  }, []);

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

  const applyTextureToMaterial = useCallback((material: MeshStandardMaterial, key: string, texture: DataTexture) => {
    if (material.map !== texture) {
      material.map = texture;
      material.color.set('#ffffff');
      material.needsUpdate = true;
    }
    material.userData.surfaceTextureKey = key;
  }, []);

  const clearTextureFromMaterial = useCallback((material: MeshStandardMaterial) => {
    if (material.map) {
      material.map = null;
      material.needsUpdate = true;
    }
    const baseColor = typeof material.userData.baseColor === 'string' ? material.userData.baseColor : null;
    if (baseColor) {
      material.color.set(baseColor);
    }
    material.userData.surfaceTextureKey = null;
  }, []);

  useFrame(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    if (!planetSurfaceDescriptorsByBodyId) return;

    camera.updateMatrixWorld();

    const now = performance.now();
    const activeKeys = new Set<string>();

    const cameraFovRad = MathUtils.degToRad(camera.fov);
    const pixelsPerWorldUnitAtZ1 = size.height / (2 * Math.tan(cameraFovRad / 2));

    const shouldForceLowRes = (bodyId: string) => bodyId === selectedBodyId || bodyId === hoveredBodyId;

    const touchKey = (key: string) => {
      cacheLastUsedRef.current.set(key, now);
      activeKeys.add(key);
    };

    const updateBody = (bodyId: string, isSolid: boolean) => {
      const descriptor = planetSurfaceDescriptorsByBodyId[bodyId];
      if (!descriptor) return;
      if (!isSolid) return;

      const worldPos = bodyWorldPositions[bodyId];
      const radius = bodyRadii[bodyId];
      if (!worldPos || typeof radius !== 'number') return;

      scratch.world.set(...worldPos);
      scratch.ndc.copy(scratch.world).project(camera);
      const isOnScreen = scratch.ndc.z > -1 && scratch.ndc.z < 1
        && Math.abs(scratch.ndc.x) <= 1.15
        && Math.abs(scratch.ndc.y) <= 1.15;

      scratch.view.copy(scratch.world).applyMatrix4(camera.matrixWorldInverse);
      let z = -scratch.view.z;
      if (!Number.isFinite(z) || z <= 0) {
        z = camera.position.distanceTo(scratch.world);
        if (!Number.isFinite(z) || z <= 0) return;
      }

      let diameterPx = 0;
      if (isOnScreen) {
        const pixelRadius = (radius / z) * pixelsPerWorldUnitAtZ1;
        diameterPx = pixelRadius * 2;
      }

      let resolution = pickSurfaceTextureResolution(diameterPx);
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

      const key = buildTextureKey(bodyId, descriptor, resolution);
      desiredKeyByBodyIdRef.current.set(bodyId, key);
      touchKey(key);

      const cachedTexture = cacheRef.current.get(key) ?? null;
      const material = resolveMaterial(bodyId);
      if (material && cachedTexture) {
        applyTextureToMaterial(material, key, cachedTexture);
      }

      if (cachedTexture) return;
      if (inFlightRef.current.has(key)) return;
      if (inFlightRef.current.size >= SURFACE_TEXTURE_MAX_INFLIGHT) return;

      const state = requestStateRef.current;
      if (!state) return;
      const workerRequest = buildSurfaceMapWorkerRequest(state, bodyId);
      if (!workerRequest) return;
      const worker = workerRef.current;
      if (!worker) return;

      inFlightRef.current.set(key, { bodyId });
      worker.requestSurfaceTexture(workerRequest, resolution)
        .then((result: SurfaceTextureResult | null) => {
          inFlightRef.current.delete(key);
          if (!result) return;

          const texture = new DataTexture(result.rgba, result.width, result.height);
          texture.colorSpace = SRGBColorSpace;
          texture.wrapS = RepeatWrapping;
          texture.wrapT = ClampToEdgeWrapping;
          texture.minFilter = LinearMipmapLinearFilter;
          texture.magFilter = LinearFilter;
          texture.generateMipmaps = true;
          texture.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
          texture.flipY = true;
          texture.needsUpdate = true;

          cacheRef.current.set(key, texture);
          cacheLastUsedRef.current.set(key, performance.now());

          const desiredKey = desiredKeyByBodyIdRef.current.get(bodyId);
          if (desiredKey !== key) return;
          const mat = resolveMaterial(bodyId);
          if (!mat) return;
          applyTextureToMaterial(mat, key, texture);
        })
        .catch(() => {
          inFlightRef.current.delete(key);
        });
    };

    planets.forEach((planet) => {
      updateBody(planet.id, planet.isSolid ?? true);
      planet.moons.forEach(moon => updateBody(moon.id, moon.isSolid ?? true));
    });

    if (cacheRef.current.size <= SURFACE_TEXTURE_MAX_CACHE_ENTRIES) return;

    const keys = Array.from(cacheRef.current.keys());
    keys.sort((a, b) => (cacheLastUsedRef.current.get(a) ?? 0) - (cacheLastUsedRef.current.get(b) ?? 0));

    for (const key of keys) {
      if (cacheRef.current.size <= SURFACE_TEXTURE_MAX_CACHE_ENTRIES) break;
      if (activeKeys.has(key)) continue;
      if (inFlightRef.current.has(key)) continue;
      const tex = cacheRef.current.get(key);
      if (!tex) continue;
      cacheRef.current.delete(key);
      cacheLastUsedRef.current.delete(key);
      tex.dispose();
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

  const atmosphereMaterials = useMemo(() => {
    return {
      Thin: createAtmosphereMaterial(ATMOSPHERE_STYLE.Thin),
      Earthlike: createAtmosphereMaterial(ATMOSPHERE_STYLE.Earthlike),
      CO2: createAtmosphereMaterial(ATMOSPHERE_STYLE.CO2),
      H2He: createAtmosphereMaterial(ATMOSPHERE_STYLE.H2He)
    } satisfies Partial<Record<Exclude<AtmosphereType, 'None'>, ShaderMaterial>>;
  }, []);
  useEffect(() => {
    return () => {
      Object.values(atmosphereMaterials).forEach(material => material?.dispose());
    };
  }, [atmosphereMaterials]);

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
    material.userData.baseColor = baseColor;
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
    material.userData.baseColor = baseColor;
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
  const planetGeometry = useDisposableMemo(() => new SphereGeometry(1, 48, 48), []);
  const moonGeometry = useDisposableMemo(() => new SphereGeometry(1, 32, 32), []);

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
  const ambientLightIntensity = MathUtils.clamp(0.12 + clampedScale * 0.04, 0.1, 0.22);
  const hemisphereLightIntensity = MathUtils.clamp(0.18 + clampedScale * 0.05, 0.16, 0.32);
  const starLightDistance = Math.max(maxOrbitRadius * 8, starRadius * 60);
  const starLightIntensity = MathUtils.clamp(3.5 + starRadius * 1.6, 3.5, 14);
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
  const cameraMinDistance = useMemo(() => {
    const anchoredRadius = bodyRadii[anchoredBodyId ?? ''];
    const effectiveRadius = typeof anchoredRadius === 'number' ? anchoredRadius : focusDistanceFloor;
    return Math.max(focusDistanceFloor, effectiveRadius * SYSTEM_VIEW_CAMERA_MIN_DISTANCE_RADIUS_FACTOR);
  }, [anchoredBodyId, bodyRadii, focusDistanceFloor]);
  const rotateSpeed = MathUtils.clamp(1 / clampedScale, 0.35, 2.5);
  const zoomSpeed = MathUtils.clamp(1 / clampedScale, 0.4, 3);
  const cameraFar = cameraMaxDistance + maxOrbitRadius * 2.5;
  const cameraNear = Math.max(0.05, Math.min(cameraMinDistance * 0.25, cameraFar / 2000));
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

  return (
    <div className="relative w-full h-full bg-black">
      <Canvas
        camera={{ position: initialCameraPosition, fov: 55, near: cameraNear, far: cameraFar }}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        dpr={[1, maxDpr]}
      >
        <color attach="background" args={['#000000']} />
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
            resolveMaterial={resolveBodyMaterial}
          />
          <SystemCelestialLayer
            stars={starModels}
            starGeometry={starGeometry}
            planets={planets}
            orbitMaterial={orbitMaterial}
            planetGeometry={planetGeometry}
            moonGeometry={moonGeometry}
            resolvePlanetMaterial={resolvePlanetMaterial}
            resolveMoonMaterial={resolveMoonMaterial}
            atmosphereMaterials={atmosphereMaterials}
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
