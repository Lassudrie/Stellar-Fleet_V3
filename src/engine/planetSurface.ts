import type {
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
  SettlementType,
  SurfacePos
} from '../shared/types';
import { ArmyState, FeatureBits } from '../shared/types';
import { RNG } from './rng';
import { getPlanetById } from './planets';

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

// ==========================================
// Params (was: planetSurface/params.ts)
// ==========================================

export type SurfaceClass = 'airless' | 'icy' | 'temperate' | 'hot' | 'dense';

export interface SurfaceParams {
  surfaceClass: SurfaceClass;
  waterFraction: number; // 0..1
  reliefScale: number; // >0
  humidityFactor: number; // 0..1
  latGradientK: number; // >0
  lapseRateK: number; // K per "elev unit" above sea level
  craterIntensity: number; // 0..1
  volcanismIndex: number; // 0..1
  riversEnabled: boolean;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

const atmosphereDensityFactor = (atm: AtmosphereType): number => {
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

const pickSurfaceClass = (atm: AtmosphereType, pressureBar: number | undefined, temperatureK: number): SurfaceClass => {
  const p = typeof pressureBar === 'number' && Number.isFinite(pressureBar) ? pressureBar : undefined;
  if (atm === 'None' || (p !== undefined && p < 0.03)) return 'airless';
  if (temperatureK < 190) return 'icy';
  if (temperatureK > 380) return 'hot';
  if (p !== undefined && p > 5) return 'dense';
  if (atm === 'CO2' || atm === 'H2He') return 'dense';
  return 'temperate';
};

const computeWaterFraction = (params: {
  atmosphere: AtmosphereType;
  pressureBar?: number;
  temperatureK: number;
  albedo: number;
}): number => {
  const { atmosphere, pressureBar, temperatureK, albedo } = params;
  const p = typeof pressureBar === 'number' && Number.isFinite(pressureBar) ? pressureBar : undefined;
  if (atmosphere === 'None' || (p !== undefined && p < 0.03)) return 0.02;

  // Basic habitability window heuristic; keep it smooth and deterministic.
  const t = temperatureK;
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
  const density = atmosphereDensityFactor(planet.atmosphere);
  const surfaceClass = pickSurfaceClass(planet.atmosphere, planet.pressureBar, planet.temperatureK);

  const reliefScale = 1 / Math.sqrt(Math.max(0.15, planet.gravityG));
  const waterFraction = computeWaterFraction({
    atmosphere: planet.atmosphere,
    pressureBar: planet.pressureBar,
    temperatureK: planet.temperatureK,
    albedo: planet.albedo
  });

  const craterIntensity = surfaceClass === 'airless' ? 0.9 : 0.15 + 0.2 * (1 - density);
  const volcanismIndex = 0.1 + 0.15 * (1 - reliefScale); // weak baseline; moons may override
  const humidityFactor = clamp01(0.15 + 0.85 * density) * clamp01(0.25 + 0.75 * waterFraction);
  const latGradientK = 20 + 60 * (1 - density); // dense atmos => smaller gradient
  const lapseRateK = density > 0.2 ? 10 * density : 0; // per elev-unit above sea (scaled later)

  const riversEnabled = surfaceClass !== 'airless' && waterFraction > 0.08 && density >= 0.25;

  return {
    surfaceClass,
    waterFraction,
    reliefScale,
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
  const density = atmosphereDensityFactor(moon.atmosphere as AtmosphereType);
  const surfaceClass = pickSurfaceClass(moon.atmosphere as AtmosphereType, undefined, moon.temperatureK);

  const reliefScale = 1 / Math.sqrt(Math.max(0.15, moon.gravityG));
  const waterFraction = computeWaterFraction({
    atmosphere: moon.atmosphere as AtmosphereType,
    pressureBar: undefined,
    temperatureK: moon.temperatureK,
    albedo: moon.albedo
  });

  const craterIntensity = surfaceClass === 'airless' ? 0.95 : 0.25 + 0.2 * (1 - density);
  const tidal = typeof moon.tidalBonusK === 'number' && Number.isFinite(moon.tidalBonusK) ? moon.tidalBonusK : 0;
  const volcanismIndex = clamp01(0.12 + Math.min(0.85, tidal / 250));
  const humidityFactor = clamp01(0.12 + 0.88 * density) * clamp01(0.25 + 0.75 * waterFraction);
  const latGradientK = 20 + 60 * (1 - density);
  const lapseRateK = density > 0.2 ? 10 * density : 0;
  const riversEnabled = surfaceClass !== 'airless' && waterFraction > 0.08 && density >= 0.25 && moon.temperatureK > 250;

  return {
    surfaceClass,
    waterFraction,
    reliefScale,
    humidityFactor,
    latGradientK,
    lapseRateK,
    craterIntensity: clamp01(craterIntensity),
    volcanismIndex,
    riversEnabled
  };
};

// ==========================================
// Descriptor (was: planetSurface/descriptor.ts)
// ==========================================

export const DEFAULT_PLANET_SURFACE_GENERATOR_VERSION = 2;

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
    astroRef: astroRef ?? { planetIndex: 0 }
  };
};

// ==========================================
// Surface map generator (was: planetSurface/generateSurfaceMap.ts)
// ==========================================

const clamp = (x: number, min: number, max: number): number => Math.max(min, Math.min(max, x));

const quantile = (values: Float32Array, q: number): number => {
  const n = values.length;
  if (n === 0) return 0;
  const qq = clamp(q, 0, 1);
  const sortedVals = Array.from(values);
  sortedVals.sort((a, b) => a - b);
  const idx = Math.floor(qq * (n - 1));
  return sortedVals[idx];
};

const isWaterBiome = (b: Biome): boolean => b === 'ocean' || b === 'coast' || b === 'lake';

const computeOceanConnectedMask = (waterMask: Uint8Array, w: number, h: number, wrapX: boolean): Uint8Array => {
  // Flood-fill from north & south edges to mark "ocean-connected" water.
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
      dist[ni] = (d + 1) as any;
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

const settlementTypeRank = (type: SettlementType): number => {
  switch (type) {
    case 'outpost':
      return 0;
    case 'colony':
      return 1;
    case 'frontierTown':
      return 2;
    case 'city':
      return 3;
    case 'metropolis':
      return 4;
    case 'megalopolis':
      return 5;
    default:
      return 0;
  }
};

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
  const n = w * h;
  const rng = new RNG(descriptor.seed ^ 0x9e3779b9);

  // Precompute elevations once (used by slope scoring).
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i += 1) elev[i] = tiles[i].elev;

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
    // Neutral: 0..1 outpost depending on RNG.
    if (rng.next() < 0.55) return [];
    const idx = placeOne(120, []);
    if (idx === null) return [];
    const coord = indexToAxial(idx, w);
    settlements.push({
      id: rng.id('settlement'),
      name: 'Outpost',
      coord,
      factionId: undefined,
      type: 'outpost',
      population: SETTLEMENT_BASE_POPULATION.outpost
    });
    tiles[idx].featureBits |= FeatureBits.City;
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
  const n = w * h;
  const rng = new RNG(descriptor.seed ^ 0x9e3779b9);

  // Precompute elevations once (used by slope scoring).
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i += 1) elev[i] = tiles[i].elev;

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

  // Neutral: keep legacy "maybe one outpost" behavior.
  if (!ownerFactionId) {
    if (rng.next() < 0.55) return [];
    const idx = placeOne('outpost');
    if (idx === null) return [];

    const coord = indexToAxial(idx, w);
    const settlements: Settlement[] = [
      {
        id: rng.id('settlement'),
        name: 'Outpost',
        coord,
        factionId: undefined,
        type: 'outpost',
        population: SETTLEMENT_BASE_POPULATION.outpost
      }
    ];

    tiles[idx].featureBits |= FeatureBits.City;
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

  const development = clamp(0.12 + 0.55 * surfaceClassScore + 0.18 * sizeScore + 0.12 * waterScore + 0.25 * rng.next(), 0, 1);

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

  // Place larger settlements first.
  schedule.sort((a, b) => settlementTypeRank(b) - settlementTypeRank(a));

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
    if (tiles[i].elev <= seaLevelElev) continue;
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

  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => elev[b] - elev[a]); // high->low

  const acc = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) acc[i] = tiles[i].elev > seaLevelElev ? 1 : 0;

  for (const i of order) {
    const to = downhill[i];
    if (to >= 0) acc[to] += acc[i];
  }

  const threshold = Math.max(25, Math.floor(n / 320));
  for (let i = 0; i < n; i += 1) {
    if (tiles[i].elev <= seaLevelElev) continue;
    if (tiles[i].tempC2 <= 0) continue; // <= 0°C
    if (acc[i] >= threshold) {
      tiles[i].featureBits |= FeatureBits.River;
    }
  }
};

export const generateSurfaceMap = (params: {
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

  const env: SurfaceParams = params.planetData
    ? deriveSurfaceParamsFromPlanet(params.planetData)
    : params.moonData
      ? deriveSurfaceParamsFromMoon(params.moonData)
      : // Fallback: treat as airless small body.
        {
          surfaceClass: 'airless',
          waterFraction: 0.02,
          reliefScale: 1,
          humidityFactor: 0.05,
          latGradientK: 65,
          lapseRateK: 0,
          craterIntensity: 0.9,
          volcanismIndex: 0.1,
          riversEnabled: false
        };

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

  const seaLevelElev = quantile(elev, env.waterFraction);

  // --- Water mask & water types (ocean vs lake) ---
  const waterMask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) waterMask[i] = elev[i] <= seaLevelElev ? 1 : 0;
  const oceanConnected = computeOceanConnectedMask(waterMask, w, h, wrapX);

  // --- Temperature field ---
  const tempC2 = new Int16Array(n);
  const baseT0K = params.planetData?.temperatureK ?? params.moonData?.temperatureK ?? 220;

  for (let r = 0; r < h; r += 1) {
    const lat = normalizedLatitude(r, h);
    const latTerm = -env.latGradientK * Math.pow(Math.abs(lat), 1.45);
    for (let q = 0; q < w; q += 1) {
      const i = r * w + q;
      const aboveSea = Math.max(0, elev[i] - seaLevelElev);
      const altTerm = -env.lapseRateK * aboveSea;
      const albedoTerm = params.planetData
        ? -18 * clamp((params.planetData.albedo - 0.25) / 0.6, 0, 1)
        : params.moonData
          ? -18 * clamp((params.moonData.albedo - 0.25) / 0.6, 0, 1)
          : 0;

      const localK = baseT0K + latTerm + altTerm + albedoTerm;
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

    if (env.surfaceClass === 'airless') {
      tiles[i].biome = elevRel > 0.6 ? 'rocky' : 'cratered';
      continue;
    }

    if (t < -18) {
      tiles[i].biome = 'ice';
      continue;
    }
    if (t < -6) {
      tiles[i].biome = m > 110 ? 'taiga' : 'tundra';
      continue;
    }
    if (elevRel > 0.85) {
      tiles[i].biome = 'mountain';
      continue;
    }

    if (t > 28 && m < 70) {
      tiles[i].biome = 'desert';
      continue;
    }
    if (t > 22 && m > 200) {
      tiles[i].biome = 'rainforest';
      continue;
    }
    if (m > 150) {
      tiles[i].biome = 'forest';
      continue;
    }
    tiles[i].biome = 'grassland';
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
  if (env.riversEnabled) {
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
    env
  });

  return {
    systemId: params.systemId,
    bodyId: params.bodyId,
    descriptor,
    seaLevelElev: Math.round(seaLevelElev * 1000),
    tiles,
    settlements
  };
};

// ==========================================
// Access/cache (was: planetSurface/access.ts)
// ==========================================

const surfaceCache = new WeakMap<GameState, Map<string, PlanetSurfaceMap>>();

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

  const cachedByBody = surfaceCache.get(state);
  const cachedMap = cachedByBody?.get(bodyId);
  if (cachedMap) return cachedMap;

  const surfaceMap = generateSurfaceMap({
    systemId: astro.systemId,
    bodyId,
    descriptor,
    planetData: astro.planetData,
    moonData: astro.moonData,
    ownerFactionId: astro.ownerFactionId
  });

  const cache = cachedByBody ?? new Map<string, PlanetSurfaceMap>();
  if (!cachedByBody) {
    surfaceCache.set(state, cache);
  }
  cache.set(bodyId, surfaceMap);

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

const isWaterBiome2 = (b: Biome): boolean => b === 'ocean' || b === 'coast' || b === 'lake';

export const isPassable = (biome: Biome): boolean => !isWaterBiome2(biome);

export const isBuildable = (biome: Biome): boolean => !isWaterBiome2(biome) && biome !== 'mountain' && biome !== 'ice';

const axialDirs = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
] as const;

const wrapQ2 = (q: number, w: number, wrapX: boolean): number => {
  if (!wrapX) return q;
  const m = q % w;
  return m < 0 ? m + w : m;
};

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
  origin: { q: number; r: number };
  predicate: (biome: Biome, q: number, r: number) => boolean;
  isOccupied?: (q: number, r: number) => boolean;
}): SurfacePos | null => {
  const { state, entityId, bodyId } = params;
  const descriptor = state.planetSurfaceDescriptorsByBodyId?.[bodyId];
  if (!descriptor) return null;
  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;

  const { w, h, wrapX } = descriptor.config;
  const inBounds = (q: number, r: number) => q >= 0 && q < w && r >= 0 && r < h;
  const occupied = params.isOccupied ?? (() => false);

  const maxRadius = w + h;
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    const ring = axialRing(params.origin, radius);
    const candidates: Array<{ q: number; r: number; score: number }> = [];
    for (const c of ring) {
      const q = wrapQ2(c.q, w, wrapX);
      const r = c.r;
      if (!inBounds(q, r)) continue;
      if (occupied(q, r)) continue;
      const biome = map.tiles[r * w + q].biome;
      if (!params.predicate(biome, q, r)) continue;
      const score = fnv1a32(`${entityId}|${bodyId}|${q}|${r}`) >>> 0;
      candidates.push({ q, r, score });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a.score - b.score);
    return { bodyId, q: candidates[0].q, r: candidates[0].r };
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

const clampInt2 = (x: number): number => (Number.isFinite(x) ? Math.floor(x) : 0);

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

  const buildingByTileKey = new Map<string, string>(); // `${bodyId}:${q}:${r}` -> buildingId (kept)
  const nextBuildings: GroundBuilding[] = [];

  // 1) Normalize buildings (valid tile + uniqueness per tile)
  for (const b of groundBuildings) {
    const bodyId = b.surfacePos.bodyId;
    const descriptor = descriptors[bodyId];
    if (!descriptor) continue;

    const q = clampInt2(b.surfacePos.q);
    const r = clampInt2(b.surfacePos.r);
    const basePos: SurfacePos = { bodyId, q, r };

    const map = generateSurfaceMapForState(state, bodyId);
    if (!map) continue;

    let finalPos = basePos;
    if (!isInsideGrid(finalPos, descriptor)) {
      const relocated = relocateSurfacePosDeterministic({
        state,
        entityId: b.id,
        kind: 'building',
        bodyId,
        origin: { q, r },
        predicate: biome => isBuildable(biome),
        isOccupied: (qq, rr) => buildingByTileKey.has(`${bodyId}:${qq}:${rr}`)
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
        isOccupied: (qq, rr) => buildingByTileKey.has(`${bodyId}:${qq}:${rr}`)
      });
      if (!relocated) continue;
      finalPos = relocated;
      buildingsChanged = true;
    }

    const key = `${bodyId}:${finalPos.q}:${finalPos.r}`;
    const existing = buildingByTileKey.get(key);
    if (existing) {
      // Collision: keep deterministic winner, relocate loser.
      const winner = existing.localeCompare(b.id) <= 0 ? existing : b.id;
      const loser = winner === existing ? b.id : existing;
      if (winner !== existing) {
        // Replace kept building in-place: rebuild map from nextBuildings
        const keptIndex = nextBuildings.findIndex(x => x.id === existing);
        if (keptIndex >= 0) {
          nextBuildings[keptIndex] = { ...b, surfacePos: finalPos };
          buildingsChanged = true;
        }
        buildingByTileKey.set(key, winner);
      }

      if (loser === b.id) {
        const relocated = relocateSurfacePosDeterministic({
          state,
          entityId: b.id,
          kind: 'building',
          bodyId,
          origin: { q: finalPos.q, r: finalPos.r },
          predicate: biome2 => isBuildable(biome2),
          isOccupied: (qq, rr) => buildingByTileKey.has(`${bodyId}:${qq}:${rr}`)
        });
        if (!relocated) continue;
        finalPos = relocated;
        buildingsChanged = true;
      }
    }

    buildingByTileKey.set(`${bodyId}:${finalPos.q}:${finalPos.r}`, b.id);
    if (finalPos.q !== b.surfacePos.q || finalPos.r !== b.surfacePos.r) buildingsChanged = true;
    nextBuildings.push({ ...b, surfacePos: finalPos });
  }

  // 2) Normalize armies (ensure surfacePos exists, in-grid, passable; stacking allowed)
  const nextArmies = state.armies.map(a => {
    if (a.state !== ArmyState.DEPLOYED) return a;

    const bodyId = a.containerId;
    const descriptor = descriptors[bodyId];
    if (!descriptor) return a;
    const map = generateSurfaceMapForState(state, bodyId);
    if (!map) return a;

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
        if (!isPassable(biome)) {
          nextPos = relocateSurfacePosDeterministic({
            state,
            entityId: a.id,
            kind: 'army',
            bodyId,
            origin: { q: normalized.q, r: normalized.r },
            predicate: b2 => isPassable(b2)
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

