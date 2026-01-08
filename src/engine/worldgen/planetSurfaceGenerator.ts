import type {
  Army,
  AtmosphereType,
  Biome,
  GameState,
  GroundBuilding,
  HexCoord,
  MoonData,
  PlanetBody,
  PlanetData,
  PlanetSurfaceConfig,
  PlanetSurfaceDescriptor,
  PlanetSurfaceMap,
  PlanetSurfaceTile,
  Settlement,
  SettlementGenerationConfig,
  SettlementType,
  SurfacePos
} from '../../shared/shared';
import { ArmyState, FeatureBits, sorted } from '../../shared/shared';
import { GROUND_UNIT_STATS } from '../../content/data/groundUnits';
import { RNG } from '../rng';
import { getPlanetById } from '../planets';

// ============================================================
// Stable 32-bit hashing helpers (was: planetSurface/hash32.ts)
// ============================================================

/**
 * FNV-1a 32-bit hash.
 * Returns an unsigned uint32.
 */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5; // offset basis
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    // hash *= 16777619 (with uint32 overflow)
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function hashJoin32(...parts: Array<string | number | boolean | null | undefined>): number {
  const s = parts.map(p => (p === null || p === undefined ? '' : String(p))).join('|');
  return fnv1a32(s);
}

// ==========================================
// Hex helpers (was: planetSurface/hex.ts)
// ==========================================

export const axialToIndex = (coord: HexCoord, w: number): number => coord.r * w + coord.q;

export const indexToAxial = (index: number, w: number): HexCoord => ({
  q: index % w,
  r: Math.floor(index / w)
});

export const wrapQ = (q: number, w: number, wrapX: boolean): number => {
  if (!wrapX) return q;
  const m = q % w;
  return m < 0 ? m + w : m;
};

export const isInBounds = (coord: HexCoord, w: number, h: number): boolean => coord.q >= 0 && coord.q < w && coord.r >= 0 && coord.r < h;

// Axial neighbors (pointy-top axial coordinate system).
const NEIGHBOR_DIRS: ReadonlyArray<HexCoord> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
];

export const neighborsAxial = (coord: HexCoord, w: number, h: number, wrapX: boolean): HexCoord[] => {
  const out: HexCoord[] = [];
  for (const d of NEIGHBOR_DIRS) {
    const n: HexCoord = { q: coord.q + d.q, r: coord.r + d.r };
    if (wrapX) n.q = wrapQ(n.q, w, true);
    if (isInBounds(n, w, h)) out.push(n);
  }
  return out;
};

export const normalizedLatitude = (r: number, h: number): number => {
  if (h <= 1) return 0;
  return (r / (h - 1)) * 2 - 1;
};

const LATITUDE_EXPONENT = 1.45;

const computeLatTermOffset = (h: number, latGradientK: number): number => {
  if (h <= 1 || latGradientK === 0) return 0;
  let sum = 0;
  for (let r = 0; r < h; r += 1) {
    const lat = normalizedLatitude(r, h);
    sum += -latGradientK * Math.pow(Math.abs(lat), LATITUDE_EXPONENT);
  }
  return sum / h;
};

// ==========================================
// Noise (was: planetSurface/noise.ts)
// ==========================================

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10); // smootherstep

const hashUnit2D = (seed: number, x: number, y: number): number => {
  // Deterministic [0..1] from integer lattice coords.
  const h = hashJoin32(seed >>> 0, x | 0, y | 0);
  return h / 0xffffffff;
};

const hashUnit3D = (seed: number, x: number, y: number, z: number): number => {
  const h = hashJoin32(seed >>> 0, x | 0, y | 0, z | 0);
  return h / 0xffffffff;
};

/**
 * Value noise 2D (continuous) based on integer lattice + bilinear interpolation.
 * Input coords are continuous; internal lattice is integer.
 */
export const valueNoise2D = (seed: number, x: number, y: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const sx = fade(x - x0);
  const sy = fade(y - y0);

  const n00 = hashUnit2D(seed, x0, y0);
  const n10 = hashUnit2D(seed, x1, y0);
  const n01 = hashUnit2D(seed, x0, y1);
  const n11 = hashUnit2D(seed, x1, y1);

  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);
  return lerp(ix0, ix1, sy); // 0..1
};

export const valueNoise3D = (seed: number, x: number, y: number, z: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;

  const sx = fade(x - x0);
  const sy = fade(y - y0);
  const sz = fade(z - z0);

  const n000 = hashUnit3D(seed, x0, y0, z0);
  const n100 = hashUnit3D(seed, x1, y0, z0);
  const n010 = hashUnit3D(seed, x0, y1, z0);
  const n110 = hashUnit3D(seed, x1, y1, z0);
  const n001 = hashUnit3D(seed, x0, y0, z1);
  const n101 = hashUnit3D(seed, x1, y0, z1);
  const n011 = hashUnit3D(seed, x0, y1, z1);
  const n111 = hashUnit3D(seed, x1, y1, z1);

  const ix00 = lerp(n000, n100, sx);
  const ix10 = lerp(n010, n110, sx);
  const ix01 = lerp(n001, n101, sx);
  const ix11 = lerp(n011, n111, sx);

  const iy0 = lerp(ix00, ix10, sy);
  const iy1 = lerp(ix01, ix11, sy);

  return lerp(iy0, iy1, sz); // 0..1
};

export const fbm2D = (seed: number, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    sum += (valueNoise2D(seed + i * 1013, x * freq, y * freq) * 2 - 1) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0; // ~[-1..1]
};

const periodicCoord = (x: number, radius = 1): { u: number; v: number } => {
  const angle = x * Math.PI * 2;
  return { u: Math.cos(angle) * radius, v: Math.sin(angle) * radius };
};

export const valueNoise2DPeriodicX = (seed: number, x: number, y: number, freqX = 1, freqY = 1): number => {
  const { u, v } = periodicCoord(x, freqX);
  return valueNoise3D(seed, u, v, y * freqY);
};

export const fbm2DPeriodicX = (
  seed: number,
  x: number,
  y: number,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
  baseFreqX = 1,
  baseFreqY = 1
): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    const fx = baseFreqX * freq;
    const fy = baseFreqY * freq;
    sum += (valueNoise2DPeriodicX(seed + i * 1013, x, y, fx, fy) * 2 - 1) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
};

export const ridgedFbm2DPeriodicX = (
  seed: number,
  x: number,
  y: number,
  octaves: number,
  baseFreqX = 1,
  baseFreqY = 1
): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    const fx = baseFreqX * freq;
    const fy = baseFreqY * freq;
    const n = valueNoise2DPeriodicX(seed + i * 2179, x, y, fx, fy);
    const ridge = 1 - Math.abs(n * 2 - 1); // 0..1
    const v = ridge * 2 - 1; // [-1..1]
    sum += v * amp;
    norm += amp;
    amp *= 0.55;
    freq *= 2.1;
  }
  return norm > 0 ? sum / norm : 0;
};

export const ridgedFbm2D = (seed: number, x: number, y: number, octaves: number): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    const n = valueNoise2D(seed + i * 2179, x * freq, y * freq);
    const ridge = 1 - Math.abs(n * 2 - 1); // 0..1
    const v = ridge * 2 - 1; // [-1..1]
    sum += v * amp;
    norm += amp;
    amp *= 0.55;
    freq *= 2.1;
  }
  return norm > 0 ? sum / norm : 0;
};

export const domainWarp2D = (seed: number, x: number, y: number, strength: number): { x: number; y: number } => {
  const dx = fbm2D(seed ^ 0x68bc21eb, x * 0.8, y * 0.8, 3);
  const dy = fbm2D(seed ^ 0x02e5be93, x * 0.8, y * 0.8, 3);
  return { x: x + dx * strength, y: y + dy * strength };
};

export const domainWarp2DPeriodicX = (
  seed: number,
  x: number,
  y: number,
  strength: number,
  baseFreqX = 1,
  baseFreqY = 1
): { x: number; y: number } => {
  const dx = fbm2DPeriodicX(seed ^ 0x68bc21eb, x, y, 3, 2, 0.5, baseFreqX * 0.8, baseFreqY * 0.8);
  const dy = fbm2DPeriodicX(seed ^ 0x02e5be93, x, y, 3, 2, 0.5, baseFreqX * 0.8, baseFreqY * 0.8);
  return { x: x + dx * strength, y: y + dy * strength };
};

type NoiseRotation2D = { cos: number; sin: number };
type NoiseRotation3D = { cosX: number; sinX: number; cosY: number; sinY: number; cosZ: number; sinZ: number };

const unitFromHash = (seed: number, salt: string): number => hashJoin32(seed, salt) / 0xffffffff;

const buildRotation2D = (seed: number, salt: string): NoiseRotation2D => {
  const angle = unitFromHash(seed, salt) * Math.PI * 2;
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
};

const buildRotation3D = (seed: number, salt: string): NoiseRotation3D => {
  const ax = unitFromHash(seed, `${salt}-x`) * Math.PI * 2;
  const ay = unitFromHash(seed, `${salt}-y`) * Math.PI * 2;
  const az = unitFromHash(seed, `${salt}-z`) * Math.PI * 2;
  return {
    cosX: Math.cos(ax),
    sinX: Math.sin(ax),
    cosY: Math.cos(ay),
    sinY: Math.sin(ay),
    cosZ: Math.cos(az),
    sinZ: Math.sin(az)
  };
};

const rotate3D = (x: number, y: number, z: number, rot: NoiseRotation3D): { x: number; y: number; z: number } => {
  const y1 = y * rot.cosX - z * rot.sinX;
  const z1 = y * rot.sinX + z * rot.cosX;
  const x2 = x * rot.cosY + z1 * rot.sinY;
  const z2 = -x * rot.sinY + z1 * rot.cosY;
  const x3 = x2 * rot.cosZ - y1 * rot.sinZ;
  const y3 = x2 * rot.sinZ + y1 * rot.cosZ;
  return { x: x3, y: y3, z: z2 };
};

const valueNoise2DRot = (seed: number, x: number, y: number, fx: number, fy: number, rot: NoiseRotation2D): number => {
  const rx = x * fx;
  const ry = y * fy;
  const nx = rx * rot.cos - ry * rot.sin;
  const ny = rx * rot.sin + ry * rot.cos;
  return valueNoise2D(seed, nx, ny);
};

const fbm2DRot = (
  seed: number,
  x: number,
  y: number,
  octaves: number,
  rot: NoiseRotation2D,
  baseFreqX = 1,
  baseFreqY = 1,
  lacunarity = 2,
  gain = 0.5
): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    const fx = baseFreqX * freq;
    const fy = baseFreqY * freq;
    sum += (valueNoise2DRot(seed + i * 1013, x, y, fx, fy, rot) * 2 - 1) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
};

const ridgedFbm2DRot = (
  seed: number,
  x: number,
  y: number,
  octaves: number,
  rot: NoiseRotation2D,
  baseFreqX = 1,
  baseFreqY = 1
): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    const fx = baseFreqX * freq;
    const fy = baseFreqY * freq;
    const n = valueNoise2DRot(seed + i * 2179, x, y, fx, fy, rot);
    const ridge = 1 - Math.abs(n * 2 - 1);
    const v = ridge * 2 - 1;
    sum += v * amp;
    norm += amp;
    amp *= 0.55;
    freq *= 2.1;
  }
  return norm > 0 ? sum / norm : 0;
};

const domainWarp2DRot = (
  seed: number,
  x: number,
  y: number,
  strength: number,
  rot: NoiseRotation2D,
  baseFreqX = 1,
  baseFreqY = 1
): { x: number; y: number } => {
  const dx = fbm2DRot(seed ^ 0x68bc21eb, x, y, 3, rot, baseFreqX * 0.8, baseFreqY * 0.8);
  const dy = fbm2DRot(seed ^ 0x02e5be93, x, y, 3, rot, baseFreqX * 0.8, baseFreqY * 0.8);
  return { x: x + dx * strength, y: y + dy * strength };
};

const valueNoise2DPeriodicXRot = (
  seed: number,
  x: number,
  y: number,
  freqX: number,
  freqY: number,
  rot: NoiseRotation3D
): number => {
  const { u, v } = periodicCoord(x, freqX);
  const p = rotate3D(u, v, y * freqY, rot);
  return valueNoise3D(seed, p.x, p.y, p.z);
};

const fbm2DPeriodicXRot = (
  seed: number,
  x: number,
  y: number,
  octaves: number,
  rot: NoiseRotation3D,
  baseFreqX = 1,
  baseFreqY = 1,
  lacunarity = 2,
  gain = 0.5
): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    const fx = baseFreqX * freq;
    const fy = baseFreqY * freq;
    sum += (valueNoise2DPeriodicXRot(seed + i * 1013, x, y, fx, fy, rot) * 2 - 1) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
};

const ridgedFbm2DPeriodicXRot = (
  seed: number,
  x: number,
  y: number,
  octaves: number,
  rot: NoiseRotation3D,
  baseFreqX = 1,
  baseFreqY = 1
): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    const fx = baseFreqX * freq;
    const fy = baseFreqY * freq;
    const n = valueNoise2DPeriodicXRot(seed + i * 2179, x, y, fx, fy, rot);
    const ridge = 1 - Math.abs(n * 2 - 1);
    const v = ridge * 2 - 1;
    sum += v * amp;
    norm += amp;
    amp *= 0.55;
    freq *= 2.1;
  }
  return norm > 0 ? sum / norm : 0;
};

const domainWarp2DPeriodicXRot = (
  seed: number,
  x: number,
  y: number,
  strength: number,
  rot: NoiseRotation3D,
  baseFreqX = 1,
  baseFreqY = 1
): { x: number; y: number } => {
  const dx = fbm2DPeriodicXRot(seed ^ 0x68bc21eb, x, y, 3, rot, baseFreqX * 0.8, baseFreqY * 0.8);
  const dy = fbm2DPeriodicXRot(seed ^ 0x02e5be93, x, y, 3, rot, baseFreqX * 0.8, baseFreqY * 0.8);
  return { x: x + dx * strength, y: y + dy * strength };
};

type NoiseSampler = {
  warp: (seed: number, x: number, y: number, strength: number, fx: number, fy: number) => { x: number; y: number };
  fbm: (seed: number, x: number, y: number, octaves: number, fx: number, fy: number, lac?: number, gain?: number) => number;
  ridged: (seed: number, x: number, y: number, octaves: number, fx: number, fy: number) => number;
  noise: (seed: number, x: number, y: number, fx: number, fy: number) => number;
};

const makeNoiseSampler = (wrapX: boolean, rot2D: NoiseRotation2D, rot3D: NoiseRotation3D): NoiseSampler => {
  if (wrapX) {
    return {
      warp: (seed, x, y, strength, fx, fy) => domainWarp2DPeriodicXRot(seed, x, y, strength, rot3D, fx, fy),
      fbm: (seed, x, y, octaves, fx, fy, lac = 2, gain = 0.5) => fbm2DPeriodicXRot(seed, x, y, octaves, rot3D, fx, fy, lac, gain),
      ridged: (seed, x, y, octaves, fx, fy) => ridgedFbm2DPeriodicXRot(seed, x, y, octaves, rot3D, fx, fy),
      noise: (seed, x, y, fx, fy) => valueNoise2DPeriodicXRot(seed, x, y, fx, fy, rot3D)
    };
  }

  return {
    warp: (seed, x, y, strength, fx, fy) => domainWarp2DRot(seed, x, y, strength, rot2D, fx, fy),
    fbm: (seed, x, y, octaves, fx, fy, lac = 2, gain = 0.5) => fbm2DRot(seed, x, y, octaves, rot2D, fx, fy, lac, gain),
    ridged: (seed, x, y, octaves, fx, fy) => ridgedFbm2DRot(seed, x, y, octaves, rot2D, fx, fy),
    noise: (seed, x, y, fx, fy) => valueNoise2DRot(seed, x, y, fx, fy, rot2D)
  };
};

// ==========================================
// Params (was: planetSurface/params.ts)
// ==========================================

export type SurfaceClass = 'airless' | 'icy' | 'temperate' | 'hot' | 'dense';
export type SurfaceClassReason =
  | 'no_atmosphere'
  | 'low_pressure'
  | 'cold'
  | 'hot'
  | 'high_pressure'
  | 'co2_greenhouse'
  | 'h2he_envelope'
  | 'temperate';

export interface SurfaceParams {
  surfaceClass: SurfaceClass;
  surfaceClassReason: SurfaceClassReason;
  waterFraction: number; // 0..1
  reliefScale: number; // >0
  tectonicsIndex: number; // 0..1
  erosionIndex: number; // 0..1
  humidityFactor: number; // 0..1
  latGradientK: number; // >0
  lapseRateK: number; // K per "elev unit" above sea level
  craterIntensity: number; // 0..1
  volcanismIndex: number; // 0..1
  riversEnabled: boolean;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const clampRange = (x: number, min: number, max: number): number => Math.max(min, Math.min(max, x));

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const atmosphereDensityFactor = (atm: AtmosphereType, airMassIndex?: number): number => {
  if (isFiniteNumber(airMassIndex)) return clamp01(airMassIndex);
  switch (atm) {
    case 'None':
      return 0;
    case 'Thin':
      return 0.25;
    case 'Earthlike':
      return 0.6;
    case 'CO2':
      return 0.8;
    case 'H2He':
      return 1.0;
    default:
      return 0.4;
  }
};

const resolveClimateSnapshot = (params: {
  climateK?: number;
  greenhouseK?: number;
  airMassIndex?: number;
  temperatureK: number;
  teqK: number;
  tidalBonusK?: number;
  atmosphere: AtmosphereType;
}): { climateK: number; greenhouseK: number; airMassIndex: number } => {
  const climateK = isFiniteNumber(params.climateK) ? params.climateK : params.temperatureK;
  const greenhouseK = isFiniteNumber(params.greenhouseK)
    ? params.greenhouseK
    : Math.max(0, climateK - params.teqK - (params.tidalBonusK ?? 0));
  const airMassIndex = isFiniteNumber(params.airMassIndex)
    ? clamp01(params.airMassIndex)
    : atmosphereDensityFactor(params.atmosphere);
  return { climateK, greenhouseK, airMassIndex };
};

const CLIMATE_ICY_K = 240;
const CLIMATE_HOT_K = 335;
const AIRLESS_AIRMASS_INDEX = 0.06;
const DENSE_AIRMASS_INDEX = 0.6;

const pickSurfaceClass = (params: {
  climateK: number;
  greenhouseK: number;
  airMassIndex: number;
  atmosphere: AtmosphereType;
}): { surfaceClass: SurfaceClass; surfaceClassReason: SurfaceClassReason } => {
  const { climateK, greenhouseK, airMassIndex, atmosphere } = params;
  if (airMassIndex < AIRLESS_AIRMASS_INDEX) {
    return {
      surfaceClass: 'airless',
      surfaceClassReason: atmosphere === 'None' ? 'no_atmosphere' : 'low_pressure'
    };
  }
  if (climateK < CLIMATE_ICY_K) return { surfaceClass: 'icy', surfaceClassReason: 'cold' };
  if (climateK > CLIMATE_HOT_K) return { surfaceClass: 'hot', surfaceClassReason: 'hot' };
  if (airMassIndex >= DENSE_AIRMASS_INDEX) {
    const reason: SurfaceClassReason = atmosphere === 'H2He'
      ? 'h2he_envelope'
      : atmosphere === 'CO2' && greenhouseK >= 45
        ? 'co2_greenhouse'
        : 'high_pressure';
    return { surfaceClass: 'dense', surfaceClassReason: reason };
  }
  return { surfaceClass: 'temperate', surfaceClassReason: 'temperate' };
};

const MIN_LIQUID_WATER_PRESSURE_BAR = 0.08;
const FREEZE_POINT_BASE_K = 273.15;
const FREEZE_POINT_MIN_PRESSURE_K = 276;

const computeEffectiveFreezingPointK = (pressureBar: number): number => {
  const normalized = clamp01((pressureBar - MIN_LIQUID_WATER_PRESSURE_BAR) / (1 - MIN_LIQUID_WATER_PRESSURE_BAR));
  return FREEZE_POINT_MIN_PRESSURE_K + (FREEZE_POINT_BASE_K - FREEZE_POINT_MIN_PRESSURE_K) * normalized;
};

const computeLiquidWaterPotential = (pressureBar: number | undefined, climateK: number): number => {
  if (!isFiniteNumber(pressureBar) || pressureBar < MIN_LIQUID_WATER_PRESSURE_BAR) return 0;
  const freezePointK = computeEffectiveFreezingPointK(pressureBar);
  return clamp01((climateK - freezePointK + 12) / 28);
};

const computeMassHeatIndex = (massEarth: number): number => {
  const safeMass = Math.max(0, massEarth);
  return clamp01(Math.log10(safeMass + 1) / Math.log10(6));
};

const computeTectonicsIndex = (params: {
  massEarth: number;
  waterFraction: number;
  tidalBonusK?: number;
  typeBias?: number;
}): number => {
  const massScore = computeMassHeatIndex(params.massEarth);
  const waterScore = clamp01(params.waterFraction);
  const tidalScore = isFiniteNumber(params.tidalBonusK) ? clamp01(params.tidalBonusK / 220) : 0;
  const bias = params.typeBias ?? 0;
  return clamp01(0.12 + 0.58 * massScore + 0.16 * waterScore + 0.35 * tidalScore + bias);
};

const computeErosionIndex = (params: {
  airMassIndex: number;
  waterFraction: number;
  climateK: number;
  pressureBar?: number;
}): number => {
  const airMass = clamp01(params.airMassIndex);
  if (airMass < AIRLESS_AIRMASS_INDEX) return clamp01(0.02 + 0.15 * params.waterFraction);
  const pressure = isFiniteNumber(params.pressureBar) ? params.pressureBar : 0;
  const freezePointK =
    pressure >= MIN_LIQUID_WATER_PRESSURE_BAR ? computeEffectiveFreezingPointK(pressure) : FREEZE_POINT_BASE_K;
  const liquidPotential = computeLiquidWaterPotential(pressure, params.climateK);
  const icePotential = clamp01((freezePointK - params.climateK + 8) / 28);
  const windErosion = airMass * (params.climateK > 305 ? 1 : 0.7);
  const waterErosion = clamp01(params.waterFraction) * (0.2 + 0.8 * liquidPotential);
  const iceErosion = clamp01(params.waterFraction) * icePotential * 0.4;
  const base = 0.04;
  return clamp01(base + 0.5 * windErosion + 0.45 * waterErosion + 0.25 * iceErosion);
};

const computeWaterFraction = (params: {
  pressureBar?: number;
  climateK: number;
  albedo: number;
  airMassIndex: number;
}): number => {
  const { pressureBar, climateK, albedo, airMassIndex } = params;
  const p = typeof pressureBar === 'number' && Number.isFinite(pressureBar) ? pressureBar : undefined;
  if (airMassIndex < AIRLESS_AIRMASS_INDEX) return 0.02;

  // Basic habitability window heuristic; keep it smooth and deterministic.
  const t = climateK;
  const tempScore = clamp01(1 - Math.abs(t - 288) / 140); // ~1 near 288K, fades out
  const pressureScore = p === undefined ? 0.6 : clamp01(Math.log10(Math.max(p, 0.05) + 1) / Math.log10(12));
  const albedoPenalty = clamp01((albedo - 0.25) / 0.55); // high albedo -> more ice -> less open water

  // Start from a baseline, then push toward wetter if temperate & enough air.
  const baseline = 0.15 + 0.55 * tempScore * (0.35 + 0.65 * pressureScore);
  const cooled = baseline * (1 - 0.35 * albedoPenalty);

  // Hot worlds dry out.
  const hotPenalty = clamp01((t - 320) / 200);
  const dried = cooled * (1 - 0.6 * hotPenalty);

  // Very cold worlds can have lots of water but mostly frozen; keep fraction moderate.
  const coldPenalty = clamp01((230 - t) / 120);
  const final = dried * (1 - 0.25 * coldPenalty) + 0.08 * coldPenalty;

  return clamp01(final);
};

export const deriveSurfaceParamsFromPlanet = (planet: PlanetData): SurfaceParams => {
  const { climateK, greenhouseK, airMassIndex } = resolveClimateSnapshot({
    climateK: planet.climateK,
    greenhouseK: planet.greenhouseK,
    airMassIndex: planet.airMassIndex,
    temperatureK: planet.temperatureK,
    teqK: planet.teqK,
    atmosphere: planet.atmosphere
  });
  const density = atmosphereDensityFactor(planet.atmosphere, airMassIndex);
  const { surfaceClass, surfaceClassReason } = pickSurfaceClass({
    climateK,
    greenhouseK,
    airMassIndex,
    atmosphere: planet.atmosphere
  });

  const waterFraction = computeWaterFraction({
    pressureBar: planet.pressureBar,
    climateK,
    albedo: planet.albedo,
    airMassIndex
  });

  const typeBias = planet.type === 'Terrestrial'
    ? 0.05
    : planet.type === 'Dwarf'
      ? -0.18
      : planet.type === 'SubNeptune'
        ? -0.08
        : -0.2;
  const tectonicsIndex = computeTectonicsIndex({
    massEarth: planet.massEarth,
    waterFraction,
    typeBias
  });
  const erosionIndex = computeErosionIndex({
    airMassIndex,
    waterFraction,
    climateK,
    pressureBar: planet.pressureBar
  });
  const reliefBase = 1 / Math.sqrt(Math.max(0.15, planet.gravityG));
  const reliefScale = clampRange(reliefBase * (0.75 + 0.6 * tectonicsIndex) * (1 - 0.35 * erosionIndex), 0.4, 2.4);
  const craterBase = surfaceClass === 'airless' ? 0.9 : 0.18 + 0.25 * (1 - density);
  const craterIntensity = clamp01(craterBase * (1 - 0.55 * erosionIndex));
  const heatBoost = clamp01((climateK - 300) / 120);
  const volcanismIndex = clamp01(0.08 + 0.55 * tectonicsIndex + 0.2 * heatBoost);
  const liquidPotential = computeLiquidWaterPotential(planet.pressureBar, climateK);
  const humidityFactor =
    clamp01(0.12 + 0.88 * density) *
    clamp01(0.2 + 0.8 * waterFraction) *
    (0.2 + 0.8 * liquidPotential);
  const heatTransport = clamp01(0.35 + 0.65 * density) * (0.6 + 0.4 * liquidPotential);
  const latGradientK = 22 + 58 * (1 - heatTransport);
  const lapseRateK = density > 0.2 ? (7 + 3 * (1 - humidityFactor)) * density : 0;

  const riversEnabled =
    surfaceClass !== 'airless' && waterFraction > 0.08 && density >= 0.25 && liquidPotential > 0.4;

  return {
    surfaceClass,
    surfaceClassReason,
    waterFraction,
    reliefScale,
    tectonicsIndex,
    erosionIndex,
    humidityFactor,
    latGradientK,
    lapseRateK,
    craterIntensity: clamp01(craterIntensity),
    volcanismIndex: clamp01(volcanismIndex),
    riversEnabled
  };
};

export const deriveSurfaceParamsFromMoon = (moon: MoonData): SurfaceParams => {
  // Moons share similar heuristics, but allow tidal heating to drive volcanism.
  const { climateK, greenhouseK, airMassIndex } = resolveClimateSnapshot({
    climateK: moon.climateK,
    greenhouseK: moon.greenhouseK,
    airMassIndex: moon.airMassIndex,
    temperatureK: moon.temperatureK,
    teqK: moon.teqK,
    tidalBonusK: moon.tidalBonusK,
    atmosphere: moon.atmosphere as AtmosphereType
  });
  const density = atmosphereDensityFactor(moon.atmosphere as AtmosphereType, airMassIndex);
  const { surfaceClass, surfaceClassReason } = pickSurfaceClass({
    climateK,
    greenhouseK,
    airMassIndex,
    atmosphere: moon.atmosphere as AtmosphereType
  });

  const waterFraction = computeWaterFraction({
    pressureBar: moon.pressureBar,
    climateK,
    albedo: moon.albedo,
    airMassIndex
  });

  const tidal = typeof moon.tidalBonusK === 'number' && Number.isFinite(moon.tidalBonusK) ? moon.tidalBonusK : 0;
  const typeBias = moon.type === 'Volcanic'
    ? 0.2
    : moon.type === 'Eden'
      ? 0.08
      : moon.type === 'Icy'
        ? -0.08
        : moon.type === 'Irregular'
          ? -0.18
          : 0;
  const tectonicsIndex = computeTectonicsIndex({
    massEarth: moon.massEarth,
    waterFraction,
    tidalBonusK: tidal,
    typeBias
  });
  const erosionIndex = computeErosionIndex({
    airMassIndex,
    waterFraction,
    climateK,
    pressureBar: moon.pressureBar
  });
  const reliefBase = 1 / Math.sqrt(Math.max(0.15, moon.gravityG));
  const reliefScale = clampRange(reliefBase * (0.72 + 0.58 * tectonicsIndex) * (1 - 0.35 * erosionIndex), 0.45, 2.6);
  const craterBase = surfaceClass === 'airless' ? 0.95 : 0.25 + 0.22 * (1 - density);
  const craterIntensity = clamp01(craterBase * (1 - 0.55 * erosionIndex));
  const tidalBoost = clamp01(tidal / 250);
  const volcanismIndex = clamp01(0.06 + 0.4 * tectonicsIndex + 0.5 * tidalBoost);
  const liquidPotential = computeLiquidWaterPotential(moon.pressureBar, climateK);
  const humidityFactor =
    clamp01(0.1 + 0.9 * density) *
    clamp01(0.2 + 0.8 * waterFraction) *
    (0.2 + 0.8 * liquidPotential);
  const heatTransport = clamp01(0.3 + 0.7 * density) * (0.55 + 0.45 * liquidPotential);
  const latGradientK = 22 + 58 * (1 - heatTransport);
  const lapseRateK = density > 0.2 ? (7 + 3 * (1 - humidityFactor)) * density : 0;
  const riversEnabled =
    surfaceClass !== 'airless' && waterFraction > 0.08 && density >= 0.25 && liquidPotential > 0.4;

  return {
    surfaceClass,
    surfaceClassReason,
    waterFraction,
    reliefScale,
    tectonicsIndex,
    erosionIndex,
    humidityFactor,
    latGradientK,
    lapseRateK,
    craterIntensity: clamp01(craterIntensity),
    volcanismIndex,
    riversEnabled
  };
};

const FALLBACK_SURFACE_PARAMS: SurfaceParams = {
  surfaceClass: 'airless',
  surfaceClassReason: 'no_atmosphere',
  waterFraction: 0.02,
  reliefScale: 1,
  tectonicsIndex: 0.1,
  erosionIndex: 0.02,
  humidityFactor: 0.05,
  latGradientK: 65,
  lapseRateK: 0,
  craterIntensity: 0.9,
  volcanismIndex: 0.1,
  riversEnabled: false
};

type HydrologyMode = 'none' | 'frozen' | 'liquid';

const resolveHydrologyMode = (params: {
  atmosphere?: AtmosphereType;
  pressureBar?: number;
  baseT0K: number;
}): HydrologyMode => {
  if (!params.atmosphere || params.atmosphere === 'None') return 'none';
  if (!isFiniteNumber(params.pressureBar) || params.pressureBar < MIN_LIQUID_WATER_PRESSURE_BAR) return 'none';
  const freezePointK = computeEffectiveFreezingPointK(params.pressureBar);
  return params.baseT0K < freezePointK ? 'frozen' : 'liquid';
};

const freezeWaterBiomes = (tiles: PlanetSurfaceTile[]): void => {
  tiles.forEach(tile => {
    if (isWaterBiome(tile.biome)) tile.biome = 'ice';
  });
};

const resolveSurfaceInputs = (params: {
  descriptor: PlanetSurfaceDescriptor;
  planetData?: PlanetData;
  moonData?: MoonData;
}): { env: SurfaceParams; baseT0K: number; albedo?: number; atmosphere?: AtmosphereType; pressureBar?: number } => {
  const isMoon = params.descriptor.astroRef.moonIndex !== undefined;
  const preferredMoon = isMoon ? params.moonData : undefined;
  const preferredPlanet = !isMoon ? params.planetData : undefined;
  const fallbackMoon = preferredMoon ?? params.moonData;
  const fallbackPlanet = preferredPlanet ?? params.planetData;
  const climateSource = preferredMoon ?? preferredPlanet ?? fallbackMoon ?? fallbackPlanet;

  const env: SurfaceParams = preferredMoon
    ? deriveSurfaceParamsFromMoon(preferredMoon)
    : preferredPlanet
    ? deriveSurfaceParamsFromPlanet(preferredPlanet)
    : fallbackMoon
    ? deriveSurfaceParamsFromMoon(fallbackMoon)
    : fallbackPlanet
    ? deriveSurfaceParamsFromPlanet(fallbackPlanet)
    : FALLBACK_SURFACE_PARAMS;
  const baseT0K = climateSource?.climateK ?? climateSource?.temperatureK ?? 220;
  const albedo = climateSource?.albedo;
  const atmosphere = climateSource?.atmosphere as AtmosphereType | undefined;
  const pressureBar = climateSource?.pressureBar;

  return { env, baseT0K, albedo, atmosphere, pressureBar };
};

const classifyLandBiome = (params: {
  env: SurfaceParams;
  hydrologyMode: HydrologyMode;
  elevRel: number;
  tempC: number;
  moist: number;
  atmosphere?: AtmosphereType;
}): Biome => {
  const { env, hydrologyMode, elevRel, tempC, atmosphere } = params;
  const m = clampRange(params.moist, 0, 255);
  const vacuum = env.surfaceClass === 'airless';
  const noLiquidWater = hydrologyMode === 'none';
  const frozen = env.surfaceClass === 'icy' || hydrologyMode === 'frozen';
  const hot = env.surfaceClass === 'hot';
  const dense = env.surfaceClass === 'dense';
  const harshDense = env.surfaceClassReason === 'h2he_envelope' || env.surfaceClassReason === 'co2_greenhouse';
  const mountainThreshold = env.surfaceClass === 'airless' ? 0.9 : 0.85;
  const isMountain = elevRel > mountainThreshold;
  const lowland = elevRel < 0.2;
  const veryDry = m < 50;
  const dry = m < 90;
  const humid = m > 160;
  const veryHumid = m > 210;
  const highVolcanism = env.volcanismIndex > 0.62;
  const mildVolcanism = env.volcanismIndex > 0.48;
  const highGravity = env.reliefScale < 0.75;
  const oxidizingAtmosphere = atmosphere === 'CO2' || atmosphere === 'Thin' || atmosphere === 'Earthlike';
  const chemicallyActive = harshDense && env.erosionIndex > 0.55 && tempC > -5;

  if (vacuum) {
    if (isMountain) return 'mountain';
    if (tempC < -45) return veryDry ? 'dusty_ice' : 'fractured_ice';
    if (highVolcanism && tempC < -10 && elevRel < 0.45) return 'cryovolcanic';
    if (highGravity && lowland) return 'compressed_plateau';
    if (highVolcanism && tempC > 40) return 'lava_flats';
    if (tempC > 32 && veryDry) return 'vitrified';
    if (tempC > -5 && tempC < 35 && env.erosionIndex < 0.2) return 'thermal_polygons';
    if (lowland && env.craterIntensity > 0.6) return 'cratered';
    return 'rocky';
  }

  if (noLiquidWater) {
    if (isMountain) return 'mountain';
    if (tempC < -40) return veryDry ? 'dusty_ice' : 'fractured_ice';
    if (highVolcanism && tempC < -8 && elevRel < 0.5) return 'cryovolcanic';
    if (highGravity && lowland) return 'compressed_plateau';
    if (highVolcanism && tempC > 38) return 'lava_flats';
    if (tempC > 30 && veryDry) return 'vitrified';
    if (tempC > 24 && veryDry) return 'ash_desert';
    if (dry && lowland) return 'fossil_basin';
    if (tempC > -4 && tempC < 30 && env.erosionIndex < 0.18) return 'thermal_polygons';
    if (lowland && env.craterIntensity > 0.5) return 'cratered';
    return 'rocky';
  }

  if (frozen) {
    if (isMountain && tempC > -30) return 'mountain';
    if (highVolcanism && tempC < -10 && elevRel < 0.45) return 'cryovolcanic';
    if (tempC < -45) return veryDry ? 'dusty_ice' : 'fractured_ice';
    if (tempC < -30) return 'ice';
    if (tempC < -10) return m > 140 ? 'taiga' : 'tundra';
    if (veryDry && lowland) return 'fossil_basin';
    if (m < 80) return 'rocky';
    return 'tundra';
  }

  if (hot) {
    if (isMountain) return 'mountain';
    if (highVolcanism && tempC > 40) return 'lava_flats';
    if (mildVolcanism && veryDry) return 'ash_desert';
    if (tempC > 42 && veryDry) return 'vitrified';
    if (tempC > 30 && dry && oxidizingAtmosphere) return 'oxidized';
    if (tempC > 34 && m < 130) return 'desert';
    if (m < 95) return 'desert';
    if (m < 130) return 'rocky';
    if (veryHumid && tempC < 32) return 'rainforest';
    if (humid) return 'forest';
    return 'grassland';
  }

  const moistAdj = dense ? clampRange(m + (harshDense ? -35 : 20), 0, 255) : m;
  const tempAdj = harshDense ? tempC + 2 : tempC;

  if (chemicallyActive && lowland) return 'chemical_erosion';
  if (dense && highGravity && lowland) return 'compressed_plateau';
  if (tempAdj < -15) return 'ice';
  if (tempAdj < -6) return moistAdj > 120 ? 'taiga' : 'tundra';
  if (isMountain) return 'mountain';
  if (tempAdj > 30 && moistAdj < 90) return oxidizingAtmosphere && dry ? 'oxidized' : 'desert';
  if (tempAdj > 24 && moistAdj > 200) return 'rainforest';
  if (moistAdj > 150) return 'forest';
  if (moistAdj < 90) return 'desert';
  return 'grassland';
};

// ==========================================
// Descriptor (was: planetSurface/descriptor.ts)
// ==========================================

export const DEFAULT_PLANET_SURFACE_GENERATOR_VERSION = 4;

const clampInt = (x: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(x)));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const deriveSurfaceSeed = (params: {
  gameSeed: number;
  systemId: string;
  bodyId: string;
  generatorVersion: number;
}): number => {
  const { gameSeed, systemId, bodyId, generatorVersion } = params;
  return hashJoin32(gameSeed, systemId, bodyId, 'surface', `v${generatorVersion}`);
};

export const computeDefaultSurfaceConfig = (
  body: PlanetBody,
  generatorVersion = DEFAULT_PLANET_SURFACE_GENERATOR_VERSION
): PlanetSurfaceConfig => {
  // size is radiusEarth for generated bodies, default to 1
  const size = typeof body.size === 'number' && Number.isFinite(body.size) ? Math.max(0.1, body.size) : 1;
  const w = clampInt(60 * Math.sqrt(size), 64, 128);
  const h = clampInt(w / 2, 32, 64);

  return {
    w,
    h,
    wrapX: true,
    generatorVersion
  };
};

export const parseAstroRefFromBodyId = (
  systemId: string,
  bodyId: string
): { planetIndex: number; moonIndex?: number } | undefined => {
  // Canonical IDs used by engine/planets.ts:
  // - planet-${systemId}-${planetIndex+1}
  // - moon-${systemId}-${planetIndex+1}-${moonIndex+1}
  const safeSystemId = escapeRegExp(systemId);

  const planetMatch = new RegExp(`^planet-${safeSystemId}-(\\d+)$`).exec(bodyId);
  if (planetMatch) {
    const planetIndex = Number(planetMatch[1]) - 1;
    if (Number.isFinite(planetIndex) && planetIndex >= 0) return { planetIndex };
    return undefined;
  }

  const moonMatch = new RegExp(`^moon-${safeSystemId}-(\\d+)-(\\d+)$`).exec(bodyId);
  if (moonMatch) {
    const planetIndex = Number(moonMatch[1]) - 1;
    const moonIndex = Number(moonMatch[2]) - 1;
    if (Number.isFinite(planetIndex) && planetIndex >= 0 && Number.isFinite(moonIndex) && moonIndex >= 0) {
      return { planetIndex, moonIndex };
    }
  }

  return undefined;
};

export const createPlanetSurfaceDescriptor = (params: {
  gameSeed: number;
  systemId: string;
  body: PlanetBody;
  generatorVersion?: number;
  settlementConfig?: SettlementGenerationConfig;
}): PlanetSurfaceDescriptor => {
  const generatorVersion = params.generatorVersion ?? DEFAULT_PLANET_SURFACE_GENERATOR_VERSION;
  const config = computeDefaultSurfaceConfig(params.body, generatorVersion);
  const seed = deriveSurfaceSeed({
    gameSeed: params.gameSeed,
    systemId: params.systemId,
    bodyId: params.body.id,
    generatorVersion
  });

  const astroRef = parseAstroRefFromBodyId(params.systemId, params.body.id);

  return {
    seed,
    config,
    // Contract requires an astroRef; fall back deterministically for custom bodies.
    astroRef: astroRef ?? { planetIndex: 0 },
    settlementConfig: normalizeSettlementConfig(params.settlementConfig)
  };
};

// ==========================================
// Surface map generator (was: planetSurface/generateSurfaceMap.ts)
// ==========================================

const clamp = (x: number, min: number, max: number): number => Math.max(min, Math.min(max, x));

const wrapDelta01 = (a: number, b: number, wrapX: boolean): number => {
  const d = Math.abs(a - b);
  return wrapX ? Math.min(d, 1 - d) : d;
};

const quantile = (values: Float32Array, q: number): number => {
  const n = values.length;
  if (n === 0) return 0;
  const qq = clamp(q, 0, 1);
  const sortedVals = sorted(Array.from(values), (a, b) => a - b);
  const idx = Math.floor(qq * (n - 1));
  return sortedVals[idx];
};

const isWaterBiome = (b: Biome): boolean => b === 'ocean' || b === 'coast' || b === 'lake';

const computeOceanConnectedMask = (waterMask: Uint8Array, w: number, h: number, wrapX: boolean): Uint8Array => {
  // Flood-fill from north & south edges (and west/east when not wrapping) to mark "ocean-connected" water.
  const ocean = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  const push = (idx: number) => {
    ocean[idx] = 1;
    queue[tail++] = idx;
  };

  for (let q = 0; q < w; q += 1) {
    const top = q;
    const bottom = (h - 1) * w + q;
    if (waterMask[top] && !ocean[top]) push(top);
    if (waterMask[bottom] && !ocean[bottom]) push(bottom);
  }

  if (!wrapX) {
    for (let r = 0; r < h; r += 1) {
      const left = r * w;
      const right = r * w + (w - 1);
      if (waterMask[left] && !ocean[left]) push(left);
      if (waterMask[right] && !ocean[right]) push(right);
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const c = indexToAxial(idx, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    for (const n of ns) {
      const ni = axialToIndex(n, w);
      if (!waterMask[ni] || ocean[ni]) continue;
      push(ni);
    }
  }

  return ocean;
};

const bfsDistanceToWater = (waterMask: Uint8Array, w: number, h: number, wrapX: boolean): Uint16Array => {
  const dist = new Uint16Array(w * h);
  dist.fill(0xffff);

  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < waterMask.length; i += 1) {
    if (!waterMask[i]) continue;
    dist[i] = 0;
    queue[tail++] = i;
  }

  while (head < tail) {
    const idx = queue[head++];
    const d = dist[idx];
    const c = indexToAxial(idx, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    for (const n of ns) {
      const ni = axialToIndex(n, w);
      if (dist[ni] !== 0xffff) continue;
      dist[ni] = d + 1;
      queue[tail++] = ni;
    }
  }

  return dist;
};

const computeSlope = (idx: number, elev: Float32Array, w: number, h: number, wrapX: boolean): number => {
  const c = indexToAxial(idx, w);
  const ns = neighborsAxial(c, w, h, wrapX);
  let maxDiff = 0;
  for (const n of ns) {
    const ni = axialToIndex(n, w);
    const diff = Math.abs(elev[idx] - elev[ni]);
    if (diff > maxDiff) maxDiff = diff;
  }
  return maxDiff;
};

type ComponentLabeling = {
  labels: Int32Array;
  sizes: number[];
};

const labelComponents = (mask: Uint8Array, target: number, w: number, h: number, wrapX: boolean): ComponentLabeling => {
  const n = w * h;
  const labels = new Int32Array(n);
  labels.fill(-1);
  const sizes: number[] = [];
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  let label = 0;

  for (let i = 0; i < n; i += 1) {
    if (labels[i] !== -1) continue;
    if (mask[i] !== target) continue;

    head = 0;
    tail = 0;
    queue[tail++] = i;
    labels[i] = label;
    let size = 0;

    while (head < tail) {
      const idx = queue[head++];
      size += 1;
      const c = indexToAxial(idx, w);
      const ns = neighborsAxial(c, w, h, wrapX);
      for (const nCoord of ns) {
        const ni = axialToIndex(nCoord, w);
        if (labels[ni] !== -1) continue;
        if (mask[ni] !== target) continue;
        labels[ni] = label;
        queue[tail++] = ni;
      }
    }

    sizes[label] = size;
    label += 1;
  }

  return { labels, sizes };
};

const applyMicroCleanup = (
  waterMask: Uint8Array,
  w: number,
  h: number,
  wrapX: boolean,
  minWaterSize: number,
  minLandSize: number
): Uint8Array => {
  const n = waterMask.length;
  const cleaned = new Uint8Array(waterMask);

  // Remove tiny water (convert to land).
  if (minWaterSize > 0) {
    const waterComponents = labelComponents(cleaned, 1, w, h, wrapX);
    for (let i = 0; i < n; i += 1) {
      const comp = waterComponents.labels[i];
      if (comp >= 0 && waterComponents.sizes[comp] < minWaterSize) {
        cleaned[i] = 0;
      }
    }
  }

  // Remove tiny land (convert to water).
  if (minLandSize > 0) {
    const landComponents = labelComponents(cleaned, 0, w, h, wrapX);
    for (let i = 0; i < n; i += 1) {
      const comp = landComponents.labels[i];
      if (comp >= 0 && landComponents.sizes[comp] < minLandSize) {
        cleaned[i] = 1;
      }
    }
  }

  return cleaned;
};

const classifyWaterComponents = (
  waterMask: Uint8Array,
  w: number,
  h: number,
  wrapX: boolean
): { oceanMask: Uint8Array; labels: ComponentLabeling } => {
  const n = waterMask.length;
  const labels = labelComponents(waterMask, 1, w, h, wrapX);
  let largestIdx = -1;
  let largestSize = -1;
  for (let i = 0; i < labels.sizes.length; i += 1) {
    const size = labels.sizes[i] ?? 0;
    if (size > largestSize) {
      largestSize = size;
      largestIdx = i;
    }
  }
  const oceanMask = new Uint8Array(n);
  if (largestIdx >= 0) {
    for (let i = 0; i < n; i += 1) {
      if (labels.labels[i] === largestIdx) oceanMask[i] = 1;
    }
  }
  return { oceanMask, labels };
};

const DEFAULT_NEUTRAL_OUTPOST_CHANCE = 0.05;
const DEFAULT_NEUTRAL_OUTPOST_RUINS_CHANCE = 0.6;
const DEFAULT_DEVELOPMENT_BIAS = 0;

const SETTLEMENT_BASE_POPULATION: Readonly<Record<SettlementType, number>> = {
  outpost: 1_000,
  colony: 1_000,
  frontierTown: 10_001,
  city: 100_001,
  metropolis: 1_000_001,
  megalopolis: 100_000_001
};

const SETTLEMENT_MIN_SPACING: Readonly<Record<SettlementType, number>> = {
  outpost: 6,
  colony: 4,
  frontierTown: 6,
  city: 8,
  metropolis: 12,
  megalopolis: 18
};

const SETTLEMENT_CANDIDATE_SAMPLES: Readonly<Record<SettlementType, number>> = {
  outpost: 140,
  colony: 180,
  frontierTown: 240,
  city: 300,
  metropolis: 380,
  megalopolis: 520
};

const normalizeSettlementConfig = (config?: SettlementGenerationConfig): Required<SettlementGenerationConfig> => {
  const raw = config ?? {};
  const neutralOutpostChance = typeof raw.neutralOutpostChance === 'number' ? raw.neutralOutpostChance : DEFAULT_NEUTRAL_OUTPOST_CHANCE;
  const neutralOutpostRuinsChance =
    typeof raw.neutralOutpostRuinsChance === 'number' ? raw.neutralOutpostRuinsChance : DEFAULT_NEUTRAL_OUTPOST_RUINS_CHANCE;
  const developmentBias = typeof raw.developmentBias === 'number' ? raw.developmentBias : DEFAULT_DEVELOPMENT_BIAS;

  return {
    neutralOutpostChance: clamp(neutralOutpostChance, 0, 1),
    neutralOutpostRuinsChance: clamp(neutralOutpostRuinsChance, 0, 1),
    developmentBias: clamp(developmentBias, -1, 1)
  };
};

const resolveSettlementConfig = (descriptor: PlanetSurfaceDescriptor): Required<SettlementGenerationConfig> =>
  normalizeSettlementConfig(descriptor.settlementConfig);

const hexDistanceWrapped = (a: HexCoord, b: HexCoord, w: number, wrapX: boolean): number => {
  const dr = b.r - a.r;
  const dq0 = b.q - a.q;
  const dqs = wrapX ? [dq0, dq0 + w, dq0 - w] : [dq0];

  let best = Infinity;
  for (const dq of dqs) {
    const dist = (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
    if (dist < best) best = dist;
  }
  return best;
};

const NAME_STYLES: ReadonlyArray<{
  starts: readonly string[];
  mids: readonly string[];
  ends: readonly string[];
  capitalPostfixes: readonly string[];
  colonyPostfixes: readonly string[];
}> = [
  {
    // "Terran"-ish
    starts: [
      'Al',
      'Bel',
      'Cor',
      'Dal',
      'Eld',
      'Fen',
      'Gal',
      'Hel',
      'Ith',
      'Jar',
      'Kel',
      'Lor',
      'Mar',
      'Nor',
      'Or',
      'Pra',
      'Quel',
      'Riv',
      'Sol',
      'Tor',
      'Ul',
      'Val',
      'Wen',
      'Xan',
      'Yor',
      'Zen'
    ],
    mids: ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'io', 'oa', 'ui', 'ar', 'en', 'il', 'or', 'un', 'an'],
    ends: ['ton', 'grad', 'haven', 'burg', 'heim', 'port', 'gate', 'hold', 'spire', 'reach', 'mere', 'ford', 'crest', 'point'],
    capitalPostfixes: ['Prime', 'Crown', 'Central', 'Alpha'],
    colonyPostfixes: ['Base', 'Landing', 'Station', 'Post']
  },
  {
    // "Industrial" / harder phonemes
    starts: ['Kar', 'Brak', 'Drax', 'Vor', 'Keld', 'Zor', 'Ryk', 'Mor', 'Khar', 'Tek', 'Vex', 'Dro', 'Skal', 'Grav', 'Nex', 'Kor'],
    mids: ['a', 'e', 'i', 'o', 'u', 'aa', 'oo', 'ir', 'or', 'ul', 'an', 'en'],
    ends: ['ar', 'on', 'is', 'um', 'ax', 'ex', 'or', 'us', 'ek', 'ok', 'ium', 'polis', 'forge', 'works'],
    capitalPostfixes: ['Hub', 'Prime', 'Core'],
    colonyPostfixes: ['Camp', 'Rig', 'Depot']
  },
  {
    // "Frontier" / softer
    starts: ['Astra', 'Nova', 'Luna', 'Sable', 'Cedar', 'Silver', 'Aurora', 'Dust', 'Pioneer', 'Horizon', 'Ember', 'Cobalt'],
    mids: ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'io', 'oa', 'ui'],
    ends: ['vale', 'ridge', 'harbor', 'bay', 'field', 'watch', 'rest', 'fall', 'cross', 'view', 'point'],
    capitalPostfixes: ['Prime', 'Seat', 'Heights'],
    colonyPostfixes: ['Landing', 'Camp', 'Haven']
  }
];

const toTitleCase = (value: string): string => {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const generateSettlementName = (params: {
  descriptorSeed: number;
  factionId: string;
  coord: HexCoord;
  type: SettlementType;
  isCapital: boolean;
  used: Set<string>;
}): string => {
  const { descriptorSeed, factionId, coord, type, isCapital, used } = params;

  const styleIndex = (hashJoin32(factionId, 'style') >>> 0) % NAME_STYLES.length;
  const style = NAME_STYLES[styleIndex] ?? NAME_STYLES[0];

  // Per-settlement RNG keeps naming stable even if placement RNG usage changes.
  const rng = new RNG(hashJoin32(descriptorSeed, factionId, coord.q, coord.r, type, 'name'));

  const start = rng.pick([...style.starts]) ?? 'Nova';
  const mid = rng.next() < 0.75 ? (rng.pick([...style.mids]) ?? '') : '';
  const end = rng.pick([...style.ends]) ?? 'ton';

  let base = `${start}${mid}${end}`;
  base = toTitleCase(base);

  // Optional postfixes for flavor.
  if (isCapital) {
    if (rng.next() < 0.55) {
      const postfix = rng.pick([...style.capitalPostfixes]) ?? 'Prime';
      base = `${base} ${postfix}`;
    }
  } else if (type === 'colony' || type === 'outpost') {
    if (rng.next() < 0.35) {
      const postfix = rng.pick([...style.colonyPostfixes]) ?? 'Base';
      base = `${base} ${postfix}`;
    }
  }

  // Uniqueness on a per-body basis.
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  for (let attempt = 2; attempt <= 25; attempt += 1) {
    const candidate = `${base} ${attempt}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }

  // Last-resort: deterministic numeric suffix.
  const fallback = `${base} ${rng.int(26, 99)}`;
  used.add(fallback);
  return fallback;
};

const placeSettlementsV1 = (params: {
  descriptor: PlanetSurfaceDescriptor;
  tiles: PlanetSurfaceTile[];
  w: number;
  h: number;
  wrapX: boolean;
  ownerFactionId?: string | null;
}): Settlement[] => {
  const { descriptor, tiles, w, h, wrapX, ownerFactionId } = params;
  const settlementConfig = resolveSettlementConfig(descriptor);
  const n = w * h;
  const rng = new RNG(descriptor.seed ^ 0x9e3779b9);

  // Precompute elevations once (used by slope scoring).
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i += 1) elev[i] = tiles[i].elev / 1000;

  const isLandIndex = (i: number): boolean => !isWaterBiome(tiles[i].biome);

  const pickCandidates = (k: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let safety = 0;
    while (out.length < k && safety < k * 30) {
      safety += 1;
      const idx = rng.int(0, n - 1);
      if (!isLandIndex(idx)) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    return out;
  };

  const tempC = (tC2: number): number => tC2 / 2;

  const scoreSite = (idx: number, existing: number[]): number => {
    const tile = tiles[idx];
    const slope = computeSlope(idx, elev, w, h, wrapX);
    const c = indexToAxial(idx, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    const nearWater = ns.some(nc => isWaterBiome(tiles[axialToIndex(nc, w)].biome)) ? 1 : 0;
    const t = tempC(tile.tempC2);
    const tempComfort = 1 - clamp(Math.abs(t - 18) / 45, 0, 1);

    let minDist = Infinity;
    for (const e of existing) {
      const ec = indexToAxial(e, w);
      const dq = wrapX ? Math.min(Math.abs(ec.q - c.q), w - Math.abs(ec.q - c.q)) : Math.abs(ec.q - c.q);
      const dr = Math.abs(ec.r - c.r);
      const d = Math.sqrt(dq * dq + dr * dr);
      if (d < minDist) minDist = d;
    }
    const spacing = existing.length === 0 ? 1 : clamp(minDist / 10, 0, 1);

    // Prefer moderate moisture, low slope, near water, comfortable temps.
    const moistScore = 1 - Math.abs(tile.moist / 255 - 0.55);
    const slopePenalty = clamp(slope / 1.2, 0, 1);
    return (0.35 * tempComfort + 0.25 * moistScore + 0.2 * nearWater + 0.2 * spacing) * (1 - 0.55 * slopePenalty);
  };

  const settlements: Settlement[] = [];

  const placeOne = (k: number, existing: number[]): number | null => {
    const candidates = pickCandidates(k);
    let best: { idx: number; score: number } | null = null;
    for (const idx of candidates) {
      const s = scoreSite(idx, existing);
      if (!best || s > best.score) best = { idx, score: s };
    }
    return best ? best.idx : null;
  };

  if (!ownerFactionId) {
    // Neutral: 0..1 outpost depending on scenario config.
    if (rng.next() > settlementConfig.neutralOutpostChance) return [];
    const idx = placeOne(120, []);
    if (idx === null) return [];
    const coord = indexToAxial(idx, w);
    const isRuins = rng.next() < settlementConfig.neutralOutpostRuinsChance;
    settlements.push({
      id: rng.id('settlement'),
      name: isRuins ? 'Ruins' : 'Outpost',
      coord,
      factionId: undefined,
      type: 'outpost',
      population: isRuins ? 0 : SETTLEMENT_BASE_POPULATION.outpost,
      status: isRuins ? 'ruins' : 'active'
    });
    if (!isRuins) tiles[idx].featureBits |= FeatureBits.City;
    return settlements;
  }

  // Owned: 1 capital + N cities.
  const capitalIdx = placeOne(260, []);
  const placed: number[] = [];
  if (capitalIdx !== null) {
    placed.push(capitalIdx);
    const coord = indexToAxial(capitalIdx, w);
    settlements.push({
      id: rng.id('settlement'),
      name: 'Capital',
      coord,
      factionId: ownerFactionId,
      type: 'city',
      population: SETTLEMENT_BASE_POPULATION.city,
      isCapital: true
    });
    tiles[capitalIdx].featureBits |= FeatureBits.City | FeatureBits.Capital;
  }

  const cityCount = clamp(Math.round(1 + rng.next() * 3), 1, 4);
  for (let i = 0; i < cityCount; i += 1) {
    const idx = placeOne(220, placed);
    if (idx === null) break;
    placed.push(idx);
    const coord = indexToAxial(idx, w);
    settlements.push({
      id: rng.id('settlement'),
      name: `City ${i + 1}`,
      coord,
      factionId: ownerFactionId,
      type: 'city',
      population: SETTLEMENT_BASE_POPULATION.city
    });
    tiles[idx].featureBits |= FeatureBits.City;
  }

  return settlements;
};

const placeSettlementsV2 = (params: {
  descriptor: PlanetSurfaceDescriptor;
  tiles: PlanetSurfaceTile[];
  w: number;
  h: number;
  wrapX: boolean;
  ownerFactionId?: string | null;
  env: SurfaceParams;
}): Settlement[] => {
  const { descriptor, tiles, w, h, wrapX, ownerFactionId, env } = params;
  const settlementConfig = resolveSettlementConfig(descriptor);
  const n = w * h;
  const rng = new RNG(descriptor.seed ^ 0x9e3779b9);

  // Precompute elevations once (used by slope scoring).
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i += 1) elev[i] = tiles[i].elev / 1000;

  const isLandIndex = (i: number): boolean => !isWaterBiome(tiles[i].biome);

  const pickCandidates = (k: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let safety = 0;
    while (out.length < k && safety < k * 40) {
      safety += 1;
      const idx = rng.int(0, n - 1);
      if (!isLandIndex(idx)) continue;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(idx);
    }
    return out;
  };

  const tempC = (tC2: number): number => tC2 / 2;

  const placed: Array<{ idx: number; coord: HexCoord; type: SettlementType }> = [];

  const canPlaceAt = (coord: HexCoord, type: SettlementType, spacingMultiplier: number) => {
    if (placed.length === 0) return { ok: true, minDist: Infinity, nearestRequired: 0 };

    let minDist = Infinity;
    let nearestRequired = 0;

    for (const p of placed) {
      const required = Math.max(SETTLEMENT_MIN_SPACING[type], SETTLEMENT_MIN_SPACING[p.type]) * spacingMultiplier;
      const d = hexDistanceWrapped(coord, p.coord, w, wrapX);
      if (d < required) return { ok: false, minDist: d, nearestRequired: required };
      if (d < minDist) {
        minDist = d;
        nearestRequired = required;
      }
    }

    return { ok: true, minDist, nearestRequired };
  };

  const scoreSite = (idx: number, type: SettlementType, spacingMultiplier: number): number => {
    const tile = tiles[idx];
    const slope = computeSlope(idx, elev, w, h, wrapX);
    const c = indexToAxial(idx, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    const nearWater = ns.some(nc => isWaterBiome(tiles[axialToIndex(nc, w)].biome)) ? 1 : 0;
    const t = tempC(tile.tempC2);
    const tempComfort = 1 - clamp(Math.abs(t - 18) / 45, 0, 1);

    const placement = canPlaceAt(c, type, spacingMultiplier);
    if (!placement.ok) return -Infinity;

    const spacingScore =
      placed.length === 0 ? 1 : clamp((placement.minDist - placement.nearestRequired) / Math.max(1, placement.nearestRequired * 2), 0, 1);

    // Prefer moderate moisture, low slope, near water, comfortable temps.
    const moistScore = 1 - Math.abs(tile.moist / 255 - 0.55);
    const slopePenalty = clamp(slope / 1.2, 0, 1);

    // Type-specific weighting: larger settlements care more about spacing & waterways.
    let tempW = 0.35;
    let moistW = 0.25;
    let waterW = 0.2;
    let spacingW = 0.2;
    let slopeFactor = 0.55;

    if (type === 'frontierTown') {
      waterW = 0.21;
      spacingW = 0.21;
      moistW = 0.24;
      tempW = 0.34;
    } else if (type === 'city') {
      waterW = 0.23;
      spacingW = 0.22;
      moistW = 0.23;
      tempW = 0.32;
      slopeFactor = 0.6;
    } else if (type === 'metropolis') {
      waterW = 0.26;
      spacingW = 0.24;
      moistW = 0.2;
      tempW = 0.3;
      slopeFactor = 0.65;
    } else if (type === 'megalopolis') {
      waterW = 0.28;
      spacingW = 0.27;
      moistW = 0.18;
      tempW = 0.27;
      slopeFactor = 0.75;
    }

    const base = tempW * tempComfort + moistW * moistScore + waterW * nearWater + spacingW * spacingScore;
    return base * (1 - slopeFactor * slopePenalty);
  };

  const placeOne = (type: SettlementType): number | null => {
    const samples = SETTLEMENT_CANDIDATE_SAMPLES[type];

    // Progressive relaxation prevents "no placement" dead-ends on small landmasses.
    const relaxations = [1.0, 0.85, 0.7];

    for (const spacingMultiplier of relaxations) {
      const candidates = pickCandidates(samples);
      let best: { idx: number; score: number } | null = null;

      for (const idx of candidates) {
        if (!isLandIndex(idx)) continue;
        const s = scoreSite(idx, type, spacingMultiplier);
        if (!Number.isFinite(s)) continue;
        if (!best || s > best.score) best = { idx, score: s };
      }

      if (best) return best.idx;
    }

    return null;
  };

  // Neutral: 0..1 outpost depending on scenario config.
  if (!ownerFactionId) {
    if (rng.next() > settlementConfig.neutralOutpostChance) return [];
    const idx = placeOne('outpost');
    if (idx === null) return [];

    const coord = indexToAxial(idx, w);
    const isRuins = rng.next() < settlementConfig.neutralOutpostRuinsChance;
    const settlements: Settlement[] = [
      {
        id: rng.id('settlement'),
        name: isRuins ? 'Ruins' : 'Outpost',
        coord,
        factionId: undefined,
        type: 'outpost',
        population: isRuins ? 0 : SETTLEMENT_BASE_POPULATION.outpost,
        status: isRuins ? 'ruins' : 'active'
      }
    ];

    if (!isRuins) tiles[idx].featureBits |= FeatureBits.City;
    return settlements;
  }

  // --- Development stage heuristic ---
  let landCount = 0;
  for (let i = 0; i < n; i += 1) if (isLandIndex(i)) landCount += 1;

  const surfaceClassScore = (() => {
    switch (env.surfaceClass) {
      case 'temperate':
        return 0.9;
      case 'icy':
        return 0.45;
      case 'hot':
        return 0.4;
      case 'dense':
        return 0.35;
      case 'airless':
        return 0.18;
      default:
        return 0.45;
    }
  })();

  const sizeScore = clamp((landCount - 500) / 2600, 0, 1);
  const waterScore = clamp((env.waterFraction - 0.05) / 0.35, 0, 1);

  const developmentBias = settlementConfig.developmentBias ?? 0;
  const development = clamp(
    0.12 + 0.55 * surfaceClassScore + 0.18 * sizeScore + 0.12 * waterScore + 0.25 * rng.next() + developmentBias,
    0,
    1
  );

  let stage = 0;
  if (development >= 0.25) stage = 1;
  if (development >= 0.45) stage = 2;
  if (development >= 0.7) stage = 3;
  if (development >= 0.88) stage = 4;

  // Hard constraints for extreme worlds.
  if (env.surfaceClass === 'airless') stage = Math.min(stage, 2);
  if (landCount < 320) stage = Math.min(stage, 1);
  if (stage >= 4 && (landCount < 1400 || env.surfaceClass === 'airless')) stage = 3;

  const scale = clamp(landCount / 2000, 0.35, 1.45);

  let megalopolisCount = stage >= 4 ? 1 : 0;
  let metropolisCount = stage >= 3 ? 1 : 0;
  if (stage >= 3 && development > 0.92 && rng.next() < 0.35 * scale) metropolisCount += 1;

  let cityCount = stage >= 2 ? clamp(1 + rng.int(0, Math.floor(2 * scale)), 1, 5) : 0;
  if (stage >= 3 && rng.next() < 0.35) cityCount += 1;

  let frontierCount = stage >= 1 ? rng.int(1, Math.max(1, Math.floor(2 * scale) + 2)) : 0;
  let colonyCount = 1 + rng.int(0, Math.max(1, Math.floor(3 * scale)));

  // Total cap to prevent map clutter.
  const maxSettlements = clamp(Math.floor(landCount / 70), 1, 36);

  const reduceOne = (): void => {
    if (colonyCount > 1) {
      colonyCount -= 1;
      return;
    }
    if (frontierCount > 0) {
      frontierCount -= 1;
      return;
    }
    if (cityCount > 1) {
      cityCount -= 1;
      return;
    }
    if (metropolisCount > 1) {
      metropolisCount -= 1;
      return;
    }
    // Never reduce megalopolis below 0/1; if it exists, keep it.
    if (cityCount > 0) {
      cityCount -= 1;
      return;
    }
    if (frontierCount > 0) {
      frontierCount -= 1;
    }
  };

  while (megalopolisCount + metropolisCount + cityCount + frontierCount + colonyCount > maxSettlements) {
    reduceOne();
    // Safety: in worst-case, stop reducing.
    if (megalopolisCount + metropolisCount + cityCount + frontierCount + colonyCount <= 1) break;
  }

  const schedule: SettlementType[] = [];
  for (let i = 0; i < megalopolisCount; i += 1) schedule.push('megalopolis');
  for (let i = 0; i < metropolisCount; i += 1) schedule.push('metropolis');
  for (let i = 0; i < cityCount; i += 1) schedule.push('city');
  for (let i = 0; i < frontierCount; i += 1) schedule.push('frontierTown');
  for (let i = 0; i < colonyCount; i += 1) schedule.push('colony');

  // Place larger settlements first (schedule already built from largest → smallest).

  const settlements: Settlement[] = [];
  const usedNames = new Set<string>();

  let capitalAssigned = false;

  for (const type of schedule) {
    const idx = placeOne(type);
    if (idx === null) continue;

    const coord = indexToAxial(idx, w);

    const isCapital = !capitalAssigned;
    if (isCapital) capitalAssigned = true;

    const name = generateSettlementName({
      descriptorSeed: descriptor.seed,
      factionId: ownerFactionId,
      coord,
      type,
      isCapital,
      used: usedNames
    });

    settlements.push({
      id: rng.id('settlement'),
      name,
      coord,
      factionId: ownerFactionId,
      type,
      population: SETTLEMENT_BASE_POPULATION[type],
      ...(isCapital ? { isCapital: true } : {})
    });

    placed.push({ idx, coord, type });

    tiles[idx].featureBits |= FeatureBits.City;
    if (isCapital) tiles[idx].featureBits |= FeatureBits.Capital;
  }

  return settlements;
};

const placeSettlements = (params: {
  descriptor: PlanetSurfaceDescriptor;
  tiles: PlanetSurfaceTile[];
  w: number;
  h: number;
  wrapX: boolean;
  ownerFactionId?: string | null;
  env: SurfaceParams;
}): Settlement[] => {
  const generatorVersion = params.descriptor.config?.generatorVersion ?? 1;

  // v1 kept for save compatibility (old descriptors).
  if (generatorVersion <= 1) {
    return placeSettlementsV1(params);
  }
  return placeSettlementsV2(params);
};

const addRivers = (params: {
  tiles: PlanetSurfaceTile[];
  elev: Float32Array;
  seaLevelElev: number;
  w: number;
  h: number;
  wrapX: boolean;
}): void => {
  const { tiles, elev, seaLevelElev, w, h, wrapX } = params;
  const n = w * h;

  const downhill = new Int32Array(n);
  downhill.fill(-1);

  for (let i = 0; i < n; i += 1) {
    if (elev[i] <= seaLevelElev) continue;
    if (isWaterBiome(tiles[i].biome)) continue;
    const c = indexToAxial(i, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    let best = -1;
    let bestE = elev[i];
    for (const nCoord of ns) {
      const ni = axialToIndex(nCoord, w);
      const e = elev[ni];
      if (e < bestE) {
        bestE = e;
        best = ni;
      }
    }
    downhill[i] = best;
  }

  const order = sorted(Array.from({ length: n }, (_, i) => i), (a, b) => elev[b] - elev[a]); // high->low

  const acc = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) acc[i] = elev[i] > seaLevelElev && !isWaterBiome(tiles[i].biome) ? 1 : 0;

  for (const i of order) {
    const to = downhill[i];
    if (to >= 0) acc[to] += acc[i];
  }

  const threshold = Math.max(25, Math.floor(n / 320));
  for (let i = 0; i < n; i += 1) {
    if (elev[i] <= seaLevelElev) continue;
    if (isWaterBiome(tiles[i].biome)) continue;
    if (tiles[i].tempC2 <= 0) continue; // <= 0°C
    if (acc[i] >= threshold) {
      tiles[i].featureBits |= FeatureBits.River;
    }
  }
};

const generateSurfaceMapV2 = (params: {
  systemId: string;
  bodyId: string;
  descriptor: PlanetSurfaceDescriptor;
  planetData?: PlanetData;
  moonData?: MoonData;
  ownerFactionId?: string | null;
}): PlanetSurfaceMap => {
  const { descriptor } = params;
  const { w, h, wrapX } = descriptor.config;
  const n = w * h;

  const { env, baseT0K, albedo, atmosphere, pressureBar } = resolveSurfaceInputs(params);
  const hydrologyMode = resolveHydrologyMode({ atmosphere, pressureBar, baseT0K });
  const envHydrology: SurfaceParams =
    hydrologyMode === 'liquid'
      ? env
      : {
          ...env,
          waterFraction: hydrologyMode === 'none' ? 0 : env.waterFraction,
          riversEnabled: false
        };
  const allowRivers = hydrologyMode === 'liquid' && envHydrology.riversEnabled;
  const albedoOffset =
    typeof albedo === 'number' ? -18 * clamp((albedo - 0.25) / 0.6, 0, 1) : 0;
  const latTermOffset = computeLatTermOffset(h, env.latGradientK);

  // --- Elevation field ---
  const elev = new Float32Array(n);
  const baseSeed = descriptor.seed;

  for (let r = 0; r < h; r += 1) {
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      // cylindrical: wrapX naturally supported by using q normalized
      const x = q / w;
      const y = r / h;

      const warped = domainWarp2D(baseSeed ^ 0x1b873593, x * 3.2, y * 2.4, 0.25);
      const continents = fbm2D(baseSeed ^ 0xa2b3c4d5, warped.x * 1.1, warped.y * 1.1, 5);
      const mountains = ridgedFbm2D(baseSeed ^ 0x7f4a7c15, warped.x * 2.8, warped.y * 2.8, 4);

      // crater term (airless)
      const craterNoise = valueNoise2D(baseSeed ^ 0x165667b1, x * 6.0, y * 6.0) * 2 - 1;
      const crater = env.surfaceClass === 'airless' ? craterNoise * env.craterIntensity * 0.45 : 0;

      const raw = continents * 0.85 + mountains * 0.55 + crater;
      elev[i] = raw * env.reliefScale;
    }
  }

  const seaLevelElev = quantile(elev, envHydrology.waterFraction);

  // --- Water mask & water types (ocean vs lake) ---
  const waterMask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    waterMask[i] = hydrologyMode === 'none' ? 0 : elev[i] <= seaLevelElev ? 1 : 0;
  }
  const oceanConnected =
    hydrologyMode === 'none' ? new Uint8Array(n) : computeOceanConnectedMask(waterMask, w, h, wrapX);

  // --- Temperature field ---
  const tempC2 = new Int16Array(n);

  for (let r = 0; r < h; r += 1) {
    const lat = normalizedLatitude(r, h);
    const latTerm = -env.latGradientK * Math.pow(Math.abs(lat), LATITUDE_EXPONENT) - latTermOffset;
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const aboveSea = Math.max(0, elev[i] - seaLevelElev);
      const altTerm = -env.lapseRateK * aboveSea;

      const localK = baseT0K + latTerm + altTerm + albedoOffset;
      const c = localK - 273.15;
      tempC2[i] = Math.round(c * 2);
    }
  }

  // --- Moisture field (distance-to-water BFS) ---
  const dist = bfsDistanceToWater(waterMask, w, h, wrapX);
  const moistU8 = new Uint8Array(n);
  const d0 = clamp(Math.round(Math.min(w, h) / 4), 6, 12);
  for (let i = 0; i < n; i += 1) {
    if (waterMask[i]) {
      moistU8[i] = 255;
      continue;
    }
    const d = dist[i] === 0xffff ? 999 : dist[i];
    const m = 255 * Math.exp(-d / d0) * env.humidityFactor;
    moistU8[i] = Math.round(clamp(m, 0, 255));
  }

  // --- Biomes + features base ---
  const tiles: PlanetSurfaceTile[] = Array.from({ length: n }, (_, i): PlanetSurfaceTile => {
    const isWater = waterMask[i] === 1;
    let biome: Biome = 'rocky';
    if (isWater) biome = oceanConnected[i] ? 'ocean' : 'lake';

    return {
      elev: Math.round(elev[i] * 1000), // stable encoding (int-ish)
      tempC2: tempC2[i],
      moist: moistU8[i],
      biome,
      featureBits: 0
    };
  });

  // Coast refinement: water adjacent to land => coast.
  for (let i = 0; i < n; i += 1) {
    if (!isWaterBiome(tiles[i].biome)) continue;
    const c = indexToAxial(i, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    const adjacentLand = ns.some(nc => !isWaterBiome(tiles[axialToIndex(nc, w)].biome));
    if (adjacentLand) tiles[i].biome = 'coast';
  }

  // Land classification
  for (let i = 0; i < n; i += 1) {
    if (isWaterBiome(tiles[i].biome)) continue;
    const elevRel = elev[i] - seaLevelElev;
    const t = tiles[i].tempC2 / 2;
    const m = tiles[i].moist;
    tiles[i].biome = classifyLandBiome({ env, hydrologyMode, elevRel, tempC: t, moist: m, atmosphere });
  }

  // Volcanic hotspots (optional)
  if (env.volcanismIndex > 0.55) {
    for (let r = 0; r < h; r += 1) {
      for (let q = 0; q < w; q += 1) {
        const i = r * w + q;
        if (isWaterBiome(tiles[i].biome)) continue;
        const x = q / w;
        const y = r / h;
        const hot = fbm2D(baseSeed ^ 0xdeadbeef, x * 4.0, y * 4.0, 4);
        if (hot > 0.72 + (1 - env.volcanismIndex) * 0.25) {
          tiles[i].biome = 'volcanic';
        }
      }
    }
  }

  // Rivers
  if (allowRivers) {
    addRivers({ tiles, elev, seaLevelElev, w, h, wrapX });
  }

  // Settlements (also stamps city/capital bits onto tiles)
  const settlements = placeSettlements({
    descriptor,
    tiles,
    w,
    h,
    wrapX,
    ownerFactionId: params.ownerFactionId,
    env: envHydrology
  });

  if (hydrologyMode === 'frozen') {
    freezeWaterBiomes(tiles);
  }

  return {
    systemId: params.systemId,
    bodyId: params.bodyId,
    descriptor,
    seaLevelElev: Math.round(seaLevelElev * 1000),
    tiles,
    settlements
  };
};

const generateSurfaceMapV3 = (params: {
  systemId: string;
  bodyId: string;
  descriptor: PlanetSurfaceDescriptor;
  planetData?: PlanetData;
  moonData?: MoonData;
  ownerFactionId?: string | null;
}): PlanetSurfaceMap => {
  const { descriptor } = params;
  const { w, h, wrapX } = descriptor.config;
  const n = w * h;

  const { env, baseT0K, albedo, atmosphere, pressureBar } = resolveSurfaceInputs(params);
  const hydrologyMode = resolveHydrologyMode({ atmosphere, pressureBar, baseT0K });
  const envHydrology: SurfaceParams =
    hydrologyMode === 'liquid'
      ? env
      : {
          ...env,
          waterFraction: hydrologyMode === 'none' ? 0 : env.waterFraction,
          riversEnabled: false
        };
  const allowRivers = hydrologyMode === 'liquid' && envHydrology.riversEnabled;
  const albedoOffset =
    typeof albedo === 'number' ? -18 * clamp((albedo - 0.25) / 0.6, 0, 1) : 0;
  const latTermOffset = computeLatTermOffset(h, env.latGradientK);

  const baseSeed = descriptor.seed;
  const warp2D = wrapX
    ? (seed: number, x: number, y: number, strength: number, fx: number, fy: number) =>
        domainWarp2DPeriodicX(seed, x, y, strength, fx, fy)
    : (seed: number, x: number, y: number, strength: number, fx: number, fy: number) =>
        domainWarp2D(seed, x * fx, y * fy, strength);
  const fbm2DGen = wrapX
    ? (seed: number, x: number, y: number, octaves: number, fx: number, fy: number, lac = 2, gain = 0.5) =>
        fbm2DPeriodicX(seed, x, y, octaves, lac, gain, fx, fy)
    : (seed: number, x: number, y: number, octaves: number, fx: number, fy: number, lac = 2, gain = 0.5) =>
        fbm2D(seed, x * fx, y * fy, octaves, lac, gain);
  const ridged2DGen = wrapX
    ? (seed: number, x: number, y: number, octaves: number, fx: number, fy: number) =>
        ridgedFbm2DPeriodicX(seed, x, y, octaves, fx, fy)
    : (seed: number, x: number, y: number, octaves: number, fx: number, fy: number) =>
        ridgedFbm2D(seed, x * fx, y * fy, octaves);
  const noise2D = wrapX
    ? (seed: number, x: number, y: number, fx: number, fy: number) => valueNoise2DPeriodicX(seed, x, y, fx, fy)
    : (seed: number, x: number, y: number, fx: number, fy: number) => valueNoise2D(seed, x * fx, y * fy);

  // --- Elevation field ---
  const elev = new Float32Array(n);
  for (let r = 0; r < h; r += 1) {
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const x = q / w;
      const y = r / h;

      const warped = warp2D(baseSeed ^ 0x1b873593, x, y, 0.25, 3.2, 2.4);
      const continents = fbm2DGen(baseSeed ^ 0xa2b3c4d5, warped.x, warped.y, 5, 1.1, 1.1);
      const mountains = ridged2DGen(baseSeed ^ 0x7f4a7c15, warped.x, warped.y, 4, 2.8, 2.8);

      const craterNoise = noise2D(baseSeed ^ 0x165667b1, x, y, 6.0, 6.0) * 2 - 1;
      const crater = env.surfaceClass === 'airless' ? craterNoise * env.craterIntensity * 0.45 : 0;

      const raw = continents * 0.85 + mountains * 0.55 + crater;
      elev[i] = raw * env.reliefScale;
    }
  }

  const seaLevelElev = quantile(elev, envHydrology.waterFraction);

  // --- Water mask with cleanup ---
  const forceDry = hydrologyMode === 'none';
  const initialWaterMask = new Uint8Array(n);
  if (!forceDry) {
    for (let i = 0; i < n; i += 1) initialWaterMask[i] = elev[i] <= seaLevelElev ? 1 : 0;
  }

  let waterMask = initialWaterMask;
  let oceanMask = new Uint8Array(n);
  if (!forceDry) {
    const cleanedWaterMask = applyMicroCleanup(initialWaterMask, w, h, wrapX, 3, 3);
    // Keep elevation consistent with cleanup flips (avoids land below sea level and water above it).
    const seaLevelEps = 0.001;
    for (let i = 0; i < n; i += 1) {
      if (cleanedWaterMask[i] === initialWaterMask[i]) continue;
      if (cleanedWaterMask[i] === 1) {
        if (elev[i] > seaLevelElev - seaLevelEps) elev[i] = seaLevelElev - seaLevelEps;
      } else {
        if (elev[i] < seaLevelElev + seaLevelEps) elev[i] = seaLevelElev + seaLevelEps;
      }
    }
    waterMask = cleanedWaterMask;
    oceanMask = classifyWaterComponents(waterMask, w, h, wrapX).oceanMask;
  }

  // --- Temperature field ---
  const tempC2 = new Int16Array(n);

  for (let r = 0; r < h; r += 1) {
    const lat = normalizedLatitude(r, h);
    const latTerm = -env.latGradientK * Math.pow(Math.abs(lat), LATITUDE_EXPONENT) - latTermOffset;
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const aboveSea = Math.max(0, elev[i] - seaLevelElev);
      const altTerm = -env.lapseRateK * aboveSea;

      const localK = baseT0K + latTerm + altTerm + albedoOffset;
      const c = localK - 273.15;
      tempC2[i] = Math.round(c * 2);
    }
  }

  // --- Moisture field ---
  const dist = bfsDistanceToWater(waterMask, w, h, wrapX);
  const moistU8 = new Uint8Array(n);
  const d0 = clamp(Math.round(Math.min(w, h) / 4), 6, 12);
  for (let i = 0; i < n; i += 1) {
    if (waterMask[i]) {
      moistU8[i] = 255;
      continue;
    }
    const d = dist[i] === 0xffff ? 999 : dist[i];
    const m = 255 * Math.exp(-d / d0) * env.humidityFactor;
    moistU8[i] = Math.round(clamp(m, 0, 255));
  }

  // --- Biomes base ---
  const tiles: PlanetSurfaceTile[] = Array.from({ length: n }, (_, i): PlanetSurfaceTile => {
    let biome: Biome = 'rocky';
    if (waterMask[i]) biome = oceanMask[i] ? 'ocean' : 'lake';

    return {
      elev: Math.round(elev[i] * 1000),
      tempC2: tempC2[i],
      moist: moistU8[i],
      biome,
      featureBits: 0
    };
  });

  // Coast refinement: any water adjacent to land becomes coast.
  for (let i = 0; i < n; i += 1) {
    if (!isWaterBiome(tiles[i].biome)) continue;
    const c = indexToAxial(i, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    const adjacentLand = ns.some(nc => !isWaterBiome(tiles[axialToIndex(nc, w)].biome));
    if (adjacentLand) tiles[i].biome = 'coast';
  }

  // Land classification
  for (let i = 0; i < n; i += 1) {
    if (isWaterBiome(tiles[i].biome)) continue;
    const elevRel = elev[i] - seaLevelElev;
    const t = tiles[i].tempC2 / 2;
    const m = tiles[i].moist;
    tiles[i].biome = classifyLandBiome({ env, hydrologyMode, elevRel, tempC: t, moist: m, atmosphere });
  }

  // Volcanic hotspots
  if (env.volcanismIndex > 0.55) {
    for (let r = 0; r < h; r += 1) {
      for (let q = 0; q < w; q += 1) {
        const i = r * w + q;
        if (isWaterBiome(tiles[i].biome)) continue;
        const x = q / w;
        const y = r / h;
        const hot = fbm2DGen(baseSeed ^ 0xdeadbeef, x, y, 4, 4.0, 4.0);
        if (hot > 0.72 + (1 - env.volcanismIndex) * 0.25) {
          tiles[i].biome = 'volcanic';
        }
      }
    }
  }

  // Rivers
  if (allowRivers) {
    addRivers({ tiles, elev, seaLevelElev, w, h, wrapX });
  }

  const settlements = placeSettlements({
    descriptor,
    tiles,
    w,
    h,
    wrapX,
    ownerFactionId: params.ownerFactionId,
    env: envHydrology
  });

  if (hydrologyMode === 'frozen') {
    freezeWaterBiomes(tiles);
  }

  return {
    systemId: params.systemId,
    bodyId: params.bodyId,
    descriptor,
    seaLevelElev: Math.round(seaLevelElev * 1000),
    tiles,
    settlements
  };
};

const generateSurfaceMapV4 = (params: {
  systemId: string;
  bodyId: string;
  descriptor: PlanetSurfaceDescriptor;
  planetData?: PlanetData;
  moonData?: MoonData;
  ownerFactionId?: string | null;
}): PlanetSurfaceMap => {
  const { descriptor } = params;
  const { w, h, wrapX } = descriptor.config;
  const n = w * h;

  const { env, baseT0K, albedo, atmosphere, pressureBar } = resolveSurfaceInputs(params);
  const hydrologyMode = resolveHydrologyMode({ atmosphere, pressureBar, baseT0K });
  const envHydrology: SurfaceParams =
    hydrologyMode === 'liquid'
      ? env
      : {
          ...env,
          waterFraction: hydrologyMode === 'none' ? 0 : env.waterFraction,
          riversEnabled: false
        };
  const allowRivers = hydrologyMode === 'liquid' && envHydrology.riversEnabled;
  const albedoOffset =
    typeof albedo === 'number' ? -18 * clamp((albedo - 0.25) / 0.6, 0, 1) : 0;
  const latTermOffset = computeLatTermOffset(h, env.latGradientK);

  const baseSeed = descriptor.seed;

  const macroNoise = makeNoiseSampler(
    wrapX,
    buildRotation2D(baseSeed, 'macro'),
    buildRotation3D(baseSeed, 'macro')
  );
  const reliefNoise = makeNoiseSampler(
    wrapX,
    buildRotation2D(baseSeed, 'relief'),
    buildRotation3D(baseSeed, 'relief')
  );
  const detailNoise = makeNoiseSampler(
    wrapX,
    buildRotation2D(baseSeed, 'detail'),
    buildRotation3D(baseSeed, 'detail')
  );

  const macroShiftX = unitFromHash(baseSeed, 'macro-shift-x');
  const macroShiftY = unitFromHash(baseSeed, 'macro-shift-y');
  const reliefShiftX = unitFromHash(baseSeed, 'relief-shift-x');
  const reliefShiftY = unitFromHash(baseSeed, 'relief-shift-y');
  const detailShiftX = unitFromHash(baseSeed, 'detail-shift-x');
  const detailShiftY = unitFromHash(baseSeed, 'detail-shift-y');

  const coreRng = new RNG(baseSeed ^ 0x6f0f3b1d);
  const coreCount = coreRng.int(1, 2 + Math.round(env.tectonicsIndex * 2));
  const coreRadiusScale = 1.1 - 0.25 * env.tectonicsIndex;
  const coreStrengthScale = 0.85 + 0.35 * env.tectonicsIndex;
  const cores: Array<{ x: number; y: number; radius: number; strength: number }> = [];
  for (let i = 0; i < coreCount; i += 1) {
    cores.push({
      x: coreRng.next(),
      y: coreRng.next(),
      radius: coreRng.range(0.18, 0.34) * coreRadiusScale,
      strength: coreRng.range(0.65, 1.1) * coreStrengthScale
    });
  }

  const macro = new Float32Array(n);
  const coreInfluence = new Float32Array(n);
  let macroMin = Number.POSITIVE_INFINITY;
  let macroMax = Number.NEGATIVE_INFINITY;
  let coreMax = 0;

  for (let r = 0; r < h; r += 1) {
    const yNorm = r / h;
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const xNorm = q / w;

      const x = xNorm + macroShiftX;
      const y = yNorm + macroShiftY;

      const warped = macroNoise.warp(baseSeed ^ 0x1b873593, x, y, 0.42, 0.55, 0.45);
      const macroBase = macroNoise.fbm(baseSeed ^ 0xa2b3c4d5, warped.x, warped.y, 3, 0.55, 0.42, 2.05, 0.5);
      const macroDetail = macroNoise.fbm(baseSeed ^ 0x8f1bbcdc, warped.x, warped.y, 2, 1.25, 0.95, 2.2, 0.5);

      let coreSum = 0;
      for (const core of cores) {
        const dx = wrapDelta01(xNorm, core.x, wrapX);
        const dy = yNorm - core.y;
        const d2 = dx * dx + dy * dy;
        const influence = Math.exp(-d2 / (2 * core.radius * core.radius));
        coreSum += influence * core.strength;
      }

      coreInfluence[i] = coreSum;
      if (coreSum > coreMax) coreMax = coreSum;

      const field = macroBase * 0.6 + macroDetail * 0.2 + coreSum * 0.85;
      macro[i] = field;
      if (field < macroMin) macroMin = field;
      if (field > macroMax) macroMax = field;
    }
  }

  const macroSeaBase = quantile(macro, env.waterFraction);
  const macroRange = Math.max(0.0001, macroMax - macroMin);
  const coastBand = clamp(macroRange * 0.18, 0.06, 0.28);
  const coastStrength = macroRange * 0.12;

  const macroAdjusted = new Float32Array(n);
  let adjustedMin = Number.POSITIVE_INFINITY;
  let adjustedMax = Number.NEGATIVE_INFINITY;

  for (let r = 0; r < h; r += 1) {
    const yNorm = r / h;
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const xNorm = q / w;

      const x = xNorm + detailShiftX;
      const y = yNorm + detailShiftY;

      const coastNoise = detailNoise.fbm(baseSeed ^ 0x2c1b3c6d, x, y, 2, 4.6, 3.4, 2.1, 0.5);
      const dist = Math.abs(macro[i] - macroSeaBase);
      const t = dist < coastBand ? 1 - dist / coastBand : 0;
      const coastWeight = fade(clamp(t, 0, 1));
      const field = macro[i] + coastNoise * coastStrength * coastWeight;

      macroAdjusted[i] = field;
      if (field < adjustedMin) adjustedMin = field;
      if (field > adjustedMax) adjustedMax = field;
    }
  }

  const seaLevelElev = 0;
  const seaLevelMacro = quantile(macroAdjusted, envHydrology.waterFraction);
  const initialWaterMask = new Uint8Array(n);
  const forceDry = hydrologyMode === 'none';
  if (!forceDry) {
    for (let i = 0; i < n; i += 1) {
      initialWaterMask[i] = macroAdjusted[i] > seaLevelMacro ? 0 : 1;
    }
  }

  const microSize = Math.max(3, Math.floor(n / 1400));
  const waterMask = forceDry
    ? initialWaterMask
    : applyMicroCleanup(initialWaterMask, w, h, wrapX, microSize, microSize);
  const oceanMask = forceDry ? new Uint8Array(n) : classifyWaterComponents(waterMask, w, h, wrapX).oceanMask;

  const elev = new Float32Array(n);
  const landSpan = Math.max(0.0001, adjustedMax - seaLevelMacro);
  const oceanSpan = Math.max(0.0001, seaLevelMacro - adjustedMin);
  const invLand = 1 / landSpan;
  const invOcean = 1 / oceanSpan;
  const coreScale = coreMax > 0 ? 1 / coreMax : 0;

  for (let r = 0; r < h; r += 1) {
    const yNorm = r / h;
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const xNorm = q / w;
      const isWater = waterMask[i] === 1;
      const macroVal = macroAdjusted[i];

      const landness = isWater ? 0 : clamp((macroVal - seaLevelMacro) * invLand, 0, 1);
      const oceanness = isWater ? clamp((seaLevelMacro - macroVal) * invOcean, 0, 1) : 0;
      const coreBias = coreScale > 0 ? clamp(coreInfluence[i] * coreScale, 0, 1) : 0;

      let base = isWater
        ? -0.06 - oceanness * 0.55
        : 0.06 + landness * 0.62 + coreBias * 0.14;

      const x = xNorm + reliefShiftX;
      const y = yNorm + reliefShiftY;

      if (!isWater) {
        const warped = reliefNoise.warp(baseSeed ^ 0x9e3779b9, x, y, 0.3, 1.8, 1.4);
        const hills = reliefNoise.fbm(baseSeed ^ 0x3c6ef372, warped.x, warped.y, 4, 2.4, 2.1, 2.05, 0.5);
        const ridges = reliefNoise.ridged(baseSeed ^ 0x1f123bb5, warped.x, warped.y, 4, 3.2, 3.0);
        const reliefMask = 0.2 + 0.55 * landness + 0.25 * coreBias;
        base += (hills * 0.4 + ridges * 0.6) * reliefMask * 0.35;
      } else {
        const seabed = reliefNoise.fbm(baseSeed ^ 0x7f4a7c15, x, y, 3, 1.4, 1.2, 2.1, 0.5);
        base += seabed * 0.05;
      }

      const craterNoise = detailNoise.noise(
        baseSeed ^ 0x165667b1,
        xNorm + detailShiftX,
        yNorm + detailShiftY,
        6.0,
        6.0
      ) * 2 - 1;
      const crater = env.surfaceClass === 'airless' ? craterNoise * env.craterIntensity * 0.45 : 0;

      elev[i] = (base + crater) * env.reliefScale;
    }
  }

  const seaLevelEps = 0.001;
  for (let i = 0; i < n; i += 1) {
    if (waterMask[i]) {
      if (elev[i] > seaLevelElev - seaLevelEps) elev[i] = seaLevelElev - seaLevelEps;
    } else if (elev[i] < seaLevelElev + seaLevelEps) {
      elev[i] = seaLevelElev + seaLevelEps;
    }
  }

  // --- Temperature field ---
  const tempC2 = new Int16Array(n);

  for (let r = 0; r < h; r += 1) {
    const lat = normalizedLatitude(r, h);
    const latTerm = -env.latGradientK * Math.pow(Math.abs(lat), LATITUDE_EXPONENT) - latTermOffset;
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const aboveSea = Math.max(0, elev[i] - seaLevelElev);
      const altTerm = -env.lapseRateK * aboveSea;

      const localK = baseT0K + latTerm + altTerm + albedoOffset;
      const c = localK - 273.15;
      tempC2[i] = Math.round(c * 2);
    }
  }

  // --- Moisture field ---
  const dist = bfsDistanceToWater(waterMask, w, h, wrapX);
  const moistU8 = new Uint8Array(n);
  const d0 = clamp(Math.round(Math.min(w, h) / 4), 6, 12);
  for (let i = 0; i < n; i += 1) {
    if (waterMask[i]) {
      moistU8[i] = 255;
      continue;
    }
    const d = dist[i] === 0xffff ? 999 : dist[i];
    const m = 255 * Math.exp(-d / d0) * env.humidityFactor;
    moistU8[i] = Math.round(clamp(m, 0, 255));
  }

  // --- Biomes base ---
  const tiles: PlanetSurfaceTile[] = Array.from({ length: n }, (_, i): PlanetSurfaceTile => {
    let biome: Biome = 'rocky';
    if (waterMask[i]) biome = oceanMask[i] ? 'ocean' : 'lake';

    return {
      elev: Math.round(elev[i] * 1000),
      tempC2: tempC2[i],
      moist: moistU8[i],
      biome,
      featureBits: 0
    };
  });

  // Coast refinement: any water adjacent to land becomes coast.
  for (let i = 0; i < n; i += 1) {
    if (!isWaterBiome(tiles[i].biome)) continue;
    const c = indexToAxial(i, w);
    const ns = neighborsAxial(c, w, h, wrapX);
    const adjacentLand = ns.some(nc => !isWaterBiome(tiles[axialToIndex(nc, w)].biome));
    if (adjacentLand) tiles[i].biome = 'coast';
  }

  // Land classification
  for (let i = 0; i < n; i += 1) {
    if (isWaterBiome(tiles[i].biome)) continue;
    const elevRel = elev[i] - seaLevelElev;

    const r = Math.floor(i / w);
    const q = i - r * w;
    const x = q / w + detailShiftX;
    const y = r / h + detailShiftY;

    const tempJitter = detailNoise.fbm(baseSeed ^ 0x5bd1e995, x, y, 2, 6.4, 5.2, 2.1, 0.5);
    const moistJitter = detailNoise.fbm(baseSeed ^ 0x27d4eb2d, x, y, 2, 7.1, 6.3, 2.1, 0.5);

    const t = tiles[i].tempC2 / 2 + tempJitter * 1.6;
    const m = clamp(tiles[i].moist + moistJitter * 12, 0, 255);

    tiles[i].biome = classifyLandBiome({ env, hydrologyMode, elevRel, tempC: t, moist: m, atmosphere });
  }

  // Volcanic hotspots
  if (env.volcanismIndex > 0.55) {
    for (let r = 0; r < h; r += 1) {
      const y = r / h + detailShiftY;
      for (let q = 0; q < w; q += 1) {
        const i = r * w + q;
        if (isWaterBiome(tiles[i].biome)) continue;
        const x = q / w + detailShiftX;
        const hot = detailNoise.fbm(baseSeed ^ 0xdeadbeef, x, y, 4, 4.0, 4.0, 2.0, 0.5);
        if (hot > 0.72 + (1 - env.volcanismIndex) * 0.25) {
          tiles[i].biome = 'volcanic';
        }
      }
    }
  }

  // Rivers
  if (allowRivers) {
    addRivers({ tiles, elev, seaLevelElev, w, h, wrapX });
  }

  const settlements = placeSettlements({
    descriptor,
    tiles,
    w,
    h,
    wrapX,
    ownerFactionId: params.ownerFactionId,
    env: envHydrology
  });

  if (hydrologyMode === 'frozen') {
    freezeWaterBiomes(tiles);
  }

  return {
    systemId: params.systemId,
    bodyId: params.bodyId,
    descriptor,
    seaLevelElev: Math.round(seaLevelElev * 1000),
    tiles,
    settlements
  };
};

export const generateSurfaceMap = (params: {
  systemId: string;
  bodyId: string;
  descriptor: PlanetSurfaceDescriptor;
  planetData?: PlanetData;
  moonData?: MoonData;
  ownerFactionId?: string | null;
}): PlanetSurfaceMap => {
  const generatorVersion = params.descriptor.config?.generatorVersion ?? 1;
  if (generatorVersion >= 4) {
    return generateSurfaceMapV4(params);
  }
  if (generatorVersion >= 3) {
    return generateSurfaceMapV3(params);
  }
  return generateSurfaceMapV2(params);
};

// ==========================================
// Summary (audit/debug)
// ==========================================

export interface SurfaceMapSummary {
  tileCount: number;
  seaLevelElev: number;
  tilesHash: number;
  tileStats: {
    elev: { min: number; max: number; avg: number };
    tempC2: { min: number; max: number; avg: number };
    moist: { min: number; max: number; avg: number };
  };
  biomeHistogram: Record<Biome, number>;
  settlements: {
    total: number;
    byType: Record<SettlementType, number>;
    byStatus: Record<string, number>;
    byFactionId: Record<string, number>;
    capitals: Array<{ id: string; name: string; coord: HexCoord; factionId?: string }>;
  };
  tileSample: Array<{
    index: number;
    coord: HexCoord;
    elev: number;
    tempC2: number;
    moist: number;
    biome: Biome;
    featureBits: number;
  }>;
}

const BIOME_ORDER: Biome[] = [
  'ocean',
  'coast',
  'lake',
  'ice',
  'fractured_ice',
  'dusty_ice',
  'cryovolcanic',
  'tundra',
  'taiga',
  'grassland',
  'forest',
  'rainforest',
  'desert',
  'ash_desert',
  'thermal_polygons',
  'lava_flats',
  'vitrified',
  'oxidized',
  'compressed_plateau',
  'chemical_erosion',
  'fossil_basin',
  'rocky',
  'mountain',
  'volcanic',
  'cratered'
];

const SETTLEMENT_TYPE_ORDER: SettlementType[] = [
  'outpost',
  'colony',
  'frontierTown',
  'city',
  'metropolis',
  'megalopolis'
];

const createCountRecord = <T extends string>(keys: readonly T[]): Record<T, number> => {
  const out = {} as Record<T, number>;
  keys.forEach(key => {
    out[key] = 0;
  });
  return out;
};

const toSortedRecord = (entries: Array<[string, number]>): Record<string, number> => {
  const out: Record<string, number> = {};
  sorted(entries, (a, b) => a[0].localeCompare(b[0])).forEach(([key, value]) => {
    out[key] = value;
  });
  return out;
};

const buildTileSample = (tiles: PlanetSurfaceTile[], w: number, h: number): SurfaceMapSummary['tileSample'] => {
  if (tiles.length === 0 || w <= 0 || h <= 0) return [];
  const rows = Math.min(4, h);
  const cols = Math.min(8, w);
  const sample: SurfaceMapSummary['tileSample'] = [];
  for (let rIndex = 0; rIndex < rows; rIndex += 1) {
    const r = Math.floor(((rIndex + 0.5) * h) / rows);
    for (let qIndex = 0; qIndex < cols; qIndex += 1) {
      const q = Math.floor(((qIndex + 0.5) * w) / cols);
      const index = r * w + q;
      const tile = tiles[index];
      if (!tile) continue;
      sample.push({
        index,
        coord: { q, r },
        elev: tile.elev,
        tempC2: tile.tempC2,
        moist: tile.moist,
        biome: tile.biome,
        featureBits: tile.featureBits
      });
    }
  }
  return sample;
};

export const summarizeSurfaceMap = (map: PlanetSurfaceMap): SurfaceMapSummary => {
  const { tiles, settlements } = map;
  const tileCount = tiles.length;

  let elevMin = Number.POSITIVE_INFINITY;
  let elevMax = Number.NEGATIVE_INFINITY;
  let elevSum = 0;
  let tempMin = Number.POSITIVE_INFINITY;
  let tempMax = Number.NEGATIVE_INFINITY;
  let tempSum = 0;
  let moistMin = Number.POSITIVE_INFINITY;
  let moistMax = Number.NEGATIVE_INFINITY;
  let moistSum = 0;

  const biomeHistogram = createCountRecord(BIOME_ORDER);

  let tilesHash = hashJoin32(
    map.systemId,
    map.bodyId,
    map.descriptor.seed,
    map.seaLevelElev,
    tileCount
  );

  for (let i = 0; i < tileCount; i += 1) {
    const tile = tiles[i];
    elevMin = Math.min(elevMin, tile.elev);
    elevMax = Math.max(elevMax, tile.elev);
    elevSum += tile.elev;

    tempMin = Math.min(tempMin, tile.tempC2);
    tempMax = Math.max(tempMax, tile.tempC2);
    tempSum += tile.tempC2;

    moistMin = Math.min(moistMin, tile.moist);
    moistMax = Math.max(moistMax, tile.moist);
    moistSum += tile.moist;

    biomeHistogram[tile.biome] += 1;
    tilesHash = hashJoin32(
      tilesHash,
      tile.elev,
      tile.tempC2,
      tile.moist,
      tile.biome,
      tile.featureBits
    );
  }

  if (tileCount === 0) {
    elevMin = 0;
    elevMax = 0;
    tempMin = 0;
    tempMax = 0;
    moistMin = 0;
    moistMax = 0;
  }

  const orderedSettlements = sorted(settlements, (a, b) => a.id.localeCompare(b.id));
  const byType = createCountRecord(SETTLEMENT_TYPE_ORDER);
  const byStatus: Record<string, number> = { active: 0, ruins: 0 };
  const factionCounts = new Map<string, number>();
  const capitals: Array<{ id: string; name: string; coord: HexCoord; factionId?: string }> = [];

  orderedSettlements.forEach(settlement => {
    byType[settlement.type] += 1;
    const statusKey = settlement.status === 'ruins' ? 'ruins' : 'active';
    byStatus[statusKey] += 1;
    const factionKey = settlement.factionId ?? '__neutral__';
    factionCounts.set(factionKey, (factionCounts.get(factionKey) ?? 0) + 1);
    if (settlement.isCapital) {
      capitals.push({
        id: settlement.id,
        name: settlement.name,
        coord: settlement.coord,
        factionId: settlement.factionId
      });
    }
    tilesHash = hashJoin32(
      tilesHash,
      settlement.id,
      settlement.name,
      settlement.coord.q,
      settlement.coord.r,
      settlement.type,
      settlement.population,
      settlement.status ?? '',
      settlement.factionId ?? '',
      settlement.isCapital ? 1 : 0
    );
  });

  return {
    tileCount,
    seaLevelElev: map.seaLevelElev,
    tilesHash,
    tileStats: {
      elev: {
        min: elevMin,
        max: elevMax,
        avg: tileCount > 0 ? elevSum / tileCount : 0
      },
      tempC2: {
        min: tempMin,
        max: tempMax,
        avg: tileCount > 0 ? tempSum / tileCount : 0
      },
      moist: {
        min: moistMin,
        max: moistMax,
        avg: tileCount > 0 ? moistSum / tileCount : 0
      }
    },
    biomeHistogram,
    settlements: {
      total: settlements.length,
      byType,
      byStatus,
      byFactionId: toSortedRecord(Array.from(factionCounts.entries())),
      capitals
    },
    tileSample: buildTileSample(tiles, map.descriptor.config.w, map.descriptor.config.h)
  };
};

// ==========================================
// Access/cache (was: planetSurface/access.ts)
// ==========================================

const surfaceCache = new WeakMap<PlanetSurfaceDescriptor, Map<string, PlanetSurfaceMap>>();

const getOwnerKey = (ownerFactionId?: string | null): string => ownerFactionId ?? '__neutral__';

const freezeSurfaceMap = (map: PlanetSurfaceMap): PlanetSurfaceMap => {
  map.tiles.forEach(tile => Object.freeze(tile));
  Object.freeze(map.tiles);

  map.settlements.forEach(settlement => {
    Object.freeze(settlement.coord);
    Object.freeze(settlement);
  });
  Object.freeze(map.settlements);

  return Object.freeze(map);
};

export const getSurfaceDescriptor = (state: GameState, bodyId: string): PlanetSurfaceDescriptor | null => {
  return state.planetSurfaceDescriptorsByBodyId?.[bodyId] ?? null;
};

export const getAstroForBody = (
  state: GameState,
  bodyId: string,
  descriptor: PlanetSurfaceDescriptor
): { systemId: string; planetData?: PlanetData; moonData?: MoonData; ownerFactionId?: string | null } | null => {
  const match = getPlanetById(state.systems, bodyId);
  if (!match) return null;
  const { system, planet: body } = match;

  const ownerFactionId = body.ownerFactionId ?? null;

  const astro = system.astro;
  if (!astro) return { systemId: system.id, ownerFactionId };

  const planetIndex = descriptor.astroRef.planetIndex;
  const planetData = astro.planets?.[planetIndex];
  if (!planetData) return { systemId: system.id, ownerFactionId };

  const moonIndex = descriptor.astroRef.moonIndex;
  const moonData = moonIndex !== undefined ? planetData.moons?.[moonIndex] : undefined;

  return { systemId: system.id, planetData, moonData, ownerFactionId };
};

export const generateSurfaceMapForState = (state: GameState, bodyId: string): PlanetSurfaceMap | null => {
  const descriptor = getSurfaceDescriptor(state, bodyId);
  if (!descriptor) return null;
  const astro = getAstroForBody(state, bodyId, descriptor);
  if (!astro) return null;

  const ownerKey = getOwnerKey(astro.ownerFactionId);
  const cachedByOwner = surfaceCache.get(descriptor);
  const cachedMap = cachedByOwner?.get(ownerKey);
  if (cachedMap) return cachedMap;

  const surfaceMap = freezeSurfaceMap(
    generateSurfaceMap({
      systemId: astro.systemId,
      bodyId,
      descriptor,
      planetData: astro.planetData,
      moonData: astro.moonData,
      ownerFactionId: astro.ownerFactionId
    })
  );

  const cache = cachedByOwner ?? new Map<string, PlanetSurfaceMap>();
  if (!cachedByOwner) {
    surfaceCache.set(descriptor, cache);
  }
  cache.set(ownerKey, surfaceMap);

  return surfaceMap;
};

export const getTileAt = (
  state: GameState,
  bodyId: string,
  q: number,
  r: number
): { descriptor: PlanetSurfaceDescriptor; tile: PlanetSurfaceTile } | null => {
  const descriptor = getSurfaceDescriptor(state, bodyId);
  if (!descriptor) return null;
  const { w, h } = descriptor.config;
  if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
  const qq = Math.floor(q);
  const rr = Math.floor(r);
  if (qq < 0 || qq >= w || rr < 0 || rr >= h) return null;

  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;
  const idx = rr * w + qq;
  return { descriptor, tile: map.tiles[idx] };
};

// ==========================================
// Validation (was: planetSurface/validation.ts)
// ==========================================

export const isInsideGrid = (pos: SurfacePos, descriptor: PlanetSurfaceDescriptor): boolean => {
  const { w, h } = descriptor.config;
  return pos.q >= 0 && pos.q < w && pos.r >= 0 && pos.r < h;
};

export const isPassable = (biome: Biome): boolean => !isWaterBiome(biome);

export const isBuildable = (biome: Biome): boolean => !isWaterBiome(biome) && biome !== 'mountain' && biome !== 'ice';

const axialDirs = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
] as const;

const axialRing = (center: { q: number; r: number }, radius: number): Array<{ q: number; r: number }> => {
  if (radius <= 0) return [center];
  const results: Array<{ q: number; r: number }> = [];
  // Start at direction 4 * radius (south-west)
  let q = center.q + axialDirs[4].q * radius;
  let r = center.r + axialDirs[4].r * radius;
  for (let side = 0; side < 6; side += 1) {
    const d = axialDirs[side];
    for (let step = 0; step < radius; step += 1) {
      results.push({ q, r });
      q += d.q;
      r += d.r;
    }
  }
  return results;
};

export const relocateSurfacePosDeterministic = (params: {
  state: GameState;
  entityId: string;
  kind: 'army' | 'building';
  bodyId: string;
  map?: PlanetSurfaceMap;
  origin: { q: number; r: number };
  predicate: (biome: Biome, q: number, r: number) => boolean;
  isOccupied?: (q: number, r: number) => boolean;
}): SurfacePos | null => {
  const { state, entityId, bodyId } = params;
  const map = params.map ?? generateSurfaceMapForState(state, bodyId);
  if (!map) return null;
  if (map.bodyId !== bodyId) return null;

  const { w, h, wrapX } = map.descriptor.config;
  const inBounds = (q: number, r: number) => q >= 0 && q < w && r >= 0 && r < h;
  const occupied = params.isOccupied ?? (() => false);

  const maxRadius = w + h;
  const originFinite = Number.isFinite(params.origin.q) && Number.isFinite(params.origin.r);
  if (originFinite) {
    for (let radius = 0; radius <= maxRadius; radius += 1) {
      const ring = axialRing(params.origin, radius);
      const candidates: Array<{ q: number; r: number; score: number }> = [];
      for (const c of ring) {
        const q = wrapQ(c.q, w, wrapX);
        const r = c.r;
        if (!inBounds(q, r)) continue;
        if (occupied(q, r)) continue;
        const biome = map.tiles[r * w + q].biome;
        if (!params.predicate(biome, q, r)) continue;
        const score = fnv1a32(`${entityId}|${bodyId}|${q}|${r}`) >>> 0;
        candidates.push({ q, r, score });
      }
      if (candidates.length === 0) continue;
      const rankedCandidates = sorted(candidates, (a, b) => a.score - b.score);
      return { bodyId, q: rankedCandidates[0].q, r: rankedCandidates[0].r };
    }
  }

  // Fallback: scan whole map
  let best: { q: number; r: number; score: number } | null = null;
  for (let r = 0; r < h; r += 1) {
    for (let q = 0; q < w; q += 1) {
      if (occupied(q, r)) continue;
      const biome = map.tiles[r * w + q].biome;
      if (!params.predicate(biome, q, r)) continue;
      const score = fnv1a32(`${entityId}|${bodyId}|${q}|${r}`) >>> 0;
      if (!best || score < best.score) best = { q, r, score };
    }
  }
  return best ? { bodyId, q: best.q, r: best.r } : null;
};

// ==========================================
// Positions (was: planetSurface/positions.ts)
// ==========================================

const clampInt2 = (x: number): number => (Number.isFinite(x) ? Math.floor(x) : NaN);

const pickInitialArmyPos = (state: GameState, armyId: string, bodyId: string): SurfacePos | null => {
  const descriptor = state.planetSurfaceDescriptorsByBodyId?.[bodyId];
  if (!descriptor) return null;
  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;

  const { w, h } = descriptor.config;

  const explicitCapital = map.settlements.find(s => s.isCapital)?.coord;
  // Fallback: pick the largest settlement by population if no explicit capital is flagged.
  let largest: (typeof map.settlements)[number] | null = null;
  for (const s of map.settlements) {
    if (!largest || s.population > largest.population) largest = s;
  }
  const capital = explicitCapital ?? largest?.coord;
  const origin = capital ? { q: capital.q, r: capital.r } : { q: Math.floor(w / 2), r: Math.floor(h / 2) };

  // Prefer passable tiles near capital/center. Deterministic tie-break by hash.
  const pos = relocateSurfacePosDeterministic({
    state,
    entityId: armyId,
    kind: 'army',
    bodyId,
    origin,
    predicate: biome => isPassable(biome)
  });
  return pos;
};

export const pickLandingSurfacePosForArmy = (params: {
  state: GameState;
  map: PlanetSurfaceMap;
  army: Army;
  isOccupied?: (q: number, r: number) => boolean;
}): SurfacePos | null => {
  const { state, map, army } = params;
  const { w, h } = map.descriptor.config;

  const explicitCapital = map.settlements.find(s => s.isCapital)?.coord;
  // Fallback: pick the largest settlement by population if no explicit capital is flagged.
  let largest: (typeof map.settlements)[number] | null = null;
  for (const s of map.settlements) {
    if (!largest || s.population > largest.population) largest = s;
  }
  const capital = explicitCapital ?? largest?.coord;
  const origin = capital ? { q: capital.q, r: capital.r } : { q: Math.floor(w / 2), r: Math.floor(h / 2) };

  const isAmphibious = GROUND_UNIT_STATS[army.unitType].tags?.includes('amphibious') ?? false;

  return relocateSurfacePosDeterministic({
    state,
    map,
    entityId: army.id,
    kind: 'army',
    bodyId: map.bodyId,
    origin,
    predicate: biome => isPassable(biome) || (isAmphibious && isWaterBiome(biome)),
    isOccupied: params.isOccupied
  });
};

export const normalizeSurfacePositions = (state: GameState): GameState => {
  const descriptors = state.planetSurfaceDescriptorsByBodyId;
  if (!descriptors) return state;

  const groundBuildings = state.groundBuildings ?? [];
  const deployedArmies = state.armies.filter(a => a.state === ArmyState.DEPLOYED);

  if (deployedArmies.length === 0 && groundBuildings.length === 0) return state;

  // Group by bodyId for efficiency.
  const touchedBodyIds = new Set<string>();
  deployedArmies.forEach(a => touchedBodyIds.add(a.containerId));
  groundBuildings.forEach(b => touchedBodyIds.add(b.surfacePos.bodyId));

  void touchedBodyIds;

  let armiesChanged = false;
  let buildingsChanged = false;

  // 1) Normalize buildings (valid tile + uniqueness per tile)
  const buildingsSorted = sorted(groundBuildings, (a, b) => a.id.localeCompare(b.id));
  const finalPosById = new Map<string, SurfacePos>();
  const occupied = new Set<string>(); // `${bodyId}:${q}:${r}`

  for (const b of buildingsSorted) {
    const bodyId = b.surfacePos.bodyId;
    const descriptor = descriptors[bodyId];
    const q = clampInt2(b.surfacePos.q);
    const r = clampInt2(b.surfacePos.r);
    let finalPos: SurfacePos = { bodyId, q, r };

    if (!descriptor) {
      const key = `${bodyId}:${finalPos.q}:${finalPos.r}`;
      occupied.add(key);
      finalPosById.set(b.id, finalPos);
      buildingsChanged = true;
      continue;
    }

    const map = generateSurfaceMapForState(state, bodyId);
    if (!map) {
      const key = `${bodyId}:${finalPos.q}:${finalPos.r}`;
      occupied.add(key);
      finalPosById.set(b.id, finalPos);
      buildingsChanged = true;
      continue;
    }

    if (!isInsideGrid(finalPos, descriptor)) {
      const relocated = relocateSurfacePosDeterministic({
        state,
        entityId: b.id,
        kind: 'building',
        bodyId,
        origin: { q, r },
        predicate: biome => isBuildable(biome),
        isOccupied: (qq, rr) => occupied.has(`${bodyId}:${qq}:${rr}`)
      });
      if (!relocated) continue;
      finalPos = relocated;
      buildingsChanged = true;
    }

    const biome = map.tiles[finalPos.r * descriptor.config.w + finalPos.q].biome;
    if (!isBuildable(biome)) {
      const relocated = relocateSurfacePosDeterministic({
        state,
        entityId: b.id,
        kind: 'building',
        bodyId,
        origin: { q: finalPos.q, r: finalPos.r },
        predicate: bb => isBuildable(bb),
        isOccupied: (qq, rr) => occupied.has(`${bodyId}:${qq}:${rr}`)
      });
      if (!relocated) continue;
      finalPos = relocated;
      buildingsChanged = true;
    }

    let key = `${bodyId}:${finalPos.q}:${finalPos.r}`;
    if (occupied.has(key)) {
      const relocated = relocateSurfacePosDeterministic({
        state,
        entityId: b.id,
        kind: 'building',
        bodyId,
        origin: { q: finalPos.q, r: finalPos.r },
        predicate: biome2 => isBuildable(biome2),
        isOccupied: (qq, rr) => occupied.has(`${bodyId}:${qq}:${rr}`)
      });
      if (!relocated) continue;
      finalPos = relocated;
      key = `${bodyId}:${finalPos.q}:${finalPos.r}`;
      buildingsChanged = true;
    }

    occupied.add(key);
    finalPosById.set(b.id, finalPos);
  }

  const nextBuildings: GroundBuilding[] = [];
  for (const b of groundBuildings) {
    const pos = finalPosById.get(b.id);
    if (!pos) continue;
    if (pos.bodyId !== b.surfacePos.bodyId || pos.q !== b.surfacePos.q || pos.r !== b.surfacePos.r) buildingsChanged = true;
    nextBuildings.push({ ...b, surfacePos: pos });
  }

  // 2) Normalize armies (ensure surfacePos exists, in-grid, passable; stacking allowed)
  const nextArmies = state.armies.map(a => {
    if (a.state !== ArmyState.DEPLOYED) return a;

    const bodyId = a.containerId;
    const descriptor = descriptors[bodyId];
    if (!descriptor) return a;
    const map = generateSurfaceMapForState(state, bodyId);
    if (!map) return a;

    const isAmphibious = GROUND_UNIT_STATS[a.unitType].tags?.includes('amphibious') ?? false;
    const isWaterBiome = (biome: Biome): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';
    const isPassableForArmy = (biome: Biome): boolean => isPassable(biome) || (isAmphibious && isWaterBiome(biome));

    const existing = a.surfacePos;
    const q0 = existing ? clampInt2(existing.q) : NaN;
    const r0 = existing ? clampInt2(existing.r) : NaN;

    let nextPos: SurfacePos | null = null;
    if (!existing) {
      nextPos = pickInitialArmyPos(state, a.id, bodyId);
    } else {
      const normalized: SurfacePos = { bodyId, q: q0, r: r0 };
      if (!isInsideGrid(normalized, descriptor)) {
        nextPos = pickInitialArmyPos(state, a.id, bodyId);
      } else {
        const biome = map.tiles[normalized.r * descriptor.config.w + normalized.q].biome;
        if (!isPassableForArmy(biome)) {
          nextPos = relocateSurfacePosDeterministic({
            state,
            entityId: a.id,
            kind: 'army',
            bodyId,
            origin: { q: normalized.q, r: normalized.r },
            predicate: b2 => isPassableForArmy(b2)
          });
        } else {
          nextPos = normalized;
        }
      }
    }

    if (!nextPos) return a;
    if (!a.surfacePos || a.surfacePos.q !== nextPos.q || a.surfacePos.r !== nextPos.r || a.surfacePos.bodyId !== nextPos.bodyId) {
      armiesChanged = true;
      return { ...a, surfacePos: nextPos };
    }
    return a;
  });

  if (!armiesChanged && !buildingsChanged) return state;
  return {
    ...state,
    armies: nextArmies,
    groundBuildings: nextBuildings.length > 0 ? nextBuildings : undefined
  };
};
