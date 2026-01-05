import { RNG } from '../rng';
import { sorted } from '../../shared/shared';
import type {
  AtmosphereType,
  MoonData,
  MoonType,
  PlanetData,
  PlanetType,
  PlanetTypePlan,
  PlanetTypeProbs,
  SpectralType,
  StarData,
  StarOrbit,
  StarSystemAstro,
  StellarClassBounds,
  StellarDerived,
  StellarAgeClass,
  StellarMultiplicityByPrimaryType,
  StellarSystemGenParams,
  StellarSystemPlan,
  WeightedSpectralType,
  WorldgenAuditSink
} from '../../shared/shared';

// ============================================================
// Constants (was: worldgen/stellar/constants.ts)
// ============================================================

export const DEFAULT_STELLAR_SYSTEM_GEN_PARAMS: StellarSystemGenParams = {
  maxPlanets: 10,
  maxSemiMajorAxisAu: 60,
  minSemiMajorAxisAu: 0.04,
  innerSlotRatio: 0.55,
  hotGiantChance: 0.1,
  snowLineMatchRange: [0.8, 1.3],
  spacingLogMean: Math.log(1.7),
  spacingLogStd: 0.25,
  firstOrbitLogRange: [0.05, 0.35]
};

export const SPECTRAL_WEIGHTS: WeightedSpectralType[] = [
  { type: 'M', weight: 0.75 },
  { type: 'K', weight: 0.12 },
  { type: 'G', weight: 0.07 },
  { type: 'F', weight: 0.03 },
  { type: 'A', weight: 0.02 },
  { type: 'B', weight: 0.008 },
  { type: 'O', weight: 0.002 }
];

const STELLAR_AGE_BINS: Array<{ class: StellarAgeClass; minGyr: number; maxGyr: number }> = [
  { class: 'young', minGyr: 0.1, maxGyr: 2.0 },
  { class: 'mid', minGyr: 2.0, maxGyr: 6.0 },
  { class: 'old', minGyr: 6.0, maxGyr: 11.0 }
];

const STELLAR_AGE_WEIGHTS_CORE: Record<StellarAgeClass, number> = {
  young: 0.2,
  mid: 0.35,
  old: 0.45
};

const STELLAR_AGE_WEIGHTS_RIM: Record<StellarAgeClass, number> = {
  young: 0.4,
  mid: 0.4,
  old: 0.2
};

const METALLICITY_FEH_CENTER = 0.12;
const METALLICITY_FEH_GRADIENT = -0.6;
const METALLICITY_FEH_SIGMA = 0.14;

export const STELLAR_CLASS_BOUNDS: Record<SpectralType, StellarClassBounds> = {
  M: { massSun: [0.08, 0.45], teffK: [2400, 3700] },
  K: { massSun: [0.45, 0.8], teffK: [3700, 5200] },
  G: { massSun: [0.8, 1.04], teffK: [5200, 6000] },
  F: { massSun: [1.04, 1.4], teffK: [6000, 7500] },
  A: { massSun: [1.4, 2.1], teffK: [7500, 10000] },
  B: { massSun: [2.1, 16], teffK: [10000, 30000] },
  O: { massSun: [16, 60], teffK: [30000, 52000] }
};

export const MULTIPLICITY_PROBABILITY: StellarMultiplicityByPrimaryType = {
  M: 0.3,
  K: 0.4,
  G: 0.5,
  F: 0.55,
  A: 0.6,
  B: 0.7,
  O: 0.8
};

export const PLANET_COUNT_LAMBDA_BY_PRIMARY: Record<SpectralType, number> = {
  M: 3.5,
  K: 4.0,
  G: 5.0,
  F: 4.0,
  A: 3.0,
  B: 1.5,
  O: 1.5
};

export const PLANET_GREENHOUSE_K_RANGE: Record<AtmosphereType, [number, number]> = {
  None: [0, 0],
  Thin: [0, 12],
  Earthlike: [28, 45],
  CO2: [50, 150],
  H2He: [80, 260]
};

export const MOON_GREENHOUSE_K_RANGE: Record<Exclude<AtmosphereType, 'H2He'>, [number, number]> = {
  None: [0, 0],
  Thin: [0, 8],
  Earthlike: [18, 35],
  CO2: [28, 85]
};

export const AIR_MASS_PRESSURE_RANGE_BAR: [number, number] = [0.02, 50];

export const ATMOSPHERE_AIRMASS_WEIGHT: Record<AtmosphereType, number> = {
  None: 0,
  Thin: 0.6,
  Earthlike: 1.0,
  CO2: 1.1,
  H2He: 1.25
};

export const MOON_ALBEDO: Record<MoonType, number> = {
  Icy: 0.65,
  Regular: 0.18,
  Volcanic: 0.18,
  Eden: 0.28,
  Irregular: 0.12
};

export const PLANET_MASS_EARTH_RANGE: Record<PlanetType, [number, number]> = {
  Terrestrial: [0.1, 6.5],
  SubNeptune: [2, 20],
  IceGiant: [10, 80],
  GasGiant: [80, 3000],
  Dwarf: [0.003, 0.03]
};

export const PLANET_RADIUS_EARTH_CLAMP: Record<PlanetType, [number, number]> = {
  Terrestrial: [0.5, 2.0],
  SubNeptune: [1.8, 4.0],
  IceGiant: [3.0, 6.0],
  GasGiant: [8.0, 14.0],
  Dwarf: [0.1, 0.6]
};

export const MOON_MASS_EARTH_RANGE: [number, number] = [1e-5, 0.02];
export const MOON_RADIUS_EARTH_RANGE: [number, number] = [0.03, 0.35];

export const ATMOSPHERE_PRESSURE_BAR: Record<AtmosphereType, [number, number]> = {
  None: [0, 0],
  Thin: [0.05, 0.5],
  Earthlike: [0.8, 2.0],
  CO2: [2.0, 10.0],
  H2He: [10, 200]
};

export const MOON_ATMOSPHERE_PRESSURE_BAR: Record<Exclude<AtmosphereType, 'H2He'>, [number, number]> = {
  None: [0, 0],
  Thin: [0.01, 0.2],
  Earthlike: [0.2, 1.2],
  CO2: [0.3, 3.0]
};

export const DEFAULT_PLANET_ALBEDO: Record<PlanetType, number> = {
  Terrestrial: 0.3,
  SubNeptune: 0.45,
  IceGiant: 0.6,
  GasGiant: 0.5,
  Dwarf: 0.55
};

export const MOON_MASS_BUDGET_FRACTION: Record<PlanetType, [number, number]> = {
  GasGiant: [2e-4, 1e-3],
  IceGiant: [1e-4, 6e-4],
  SubNeptune: [0, 2e-4],
  Terrestrial: [0, 3e-4],
  Dwarf: [0, 1e-4]
};

// ============================================================
// Random helpers (was: worldgen/stellar/random.ts)
// ============================================================

export function clamp(x: number, min: number, max: number): number {
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

const clamp01 = (x: number): number => clamp(x, 0, 1);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const computeGalacticRadiusNorm = (
  position: { x: number; y: number; z: number } | undefined,
  galacticRadius: number | undefined
): number => {
  if (!position || !Number.isFinite(galacticRadius) || (galacticRadius as number) <= 0) return 0.5;
  const r = Math.sqrt(position.x * position.x + position.z * position.z);
  return clamp01(r / (galacticRadius as number));
};

const drawStellarAge = (rng: RNG, radiusNorm: number): { ageGyr: number; ageClass: StellarAgeClass } => {
  const t = clamp01(radiusNorm);
  const youngWeight = lerp(STELLAR_AGE_WEIGHTS_CORE.young, STELLAR_AGE_WEIGHTS_RIM.young, t);
  const midWeight = lerp(STELLAR_AGE_WEIGHTS_CORE.mid, STELLAR_AGE_WEIGHTS_RIM.mid, t);
  const oldWeight = lerp(STELLAR_AGE_WEIGHTS_CORE.old, STELLAR_AGE_WEIGHTS_RIM.old, t);
  const ageClass = weightedPick(rng, [
    { key: 'young', weight: youngWeight },
    { key: 'mid', weight: midWeight },
    { key: 'old', weight: oldWeight }
  ]);
  const bin = STELLAR_AGE_BINS.find(b => b.class === ageClass) ?? STELLAR_AGE_BINS[1];
  const ageGyr = rng.range(bin.minGyr, bin.maxGyr);
  return { ageGyr, ageClass };
};

const scaleSpectralWeightsForAge = (ageClass: StellarAgeClass): WeightedSpectralType[] => {
  return SPECTRAL_WEIGHTS.map(entry => {
    let scale = 1;
    if (ageClass === 'mid') {
      if (entry.type === 'O' || entry.type === 'B') scale = 0;
      if (entry.type === 'A') scale = 0.35;
      if (entry.type === 'F') scale = 0.8;
    } else if (ageClass === 'old') {
      if (entry.type === 'O' || entry.type === 'B') scale = 0;
      if (entry.type === 'A') scale = 0.1;
      if (entry.type === 'F') scale = 0.45;
    }
    return { type: entry.type, weight: entry.weight * scale };
  });
};

export function logUniform(rng: RNG, min: number, max: number): number {
  if (min <= 0 || max <= 0) {
    throw new Error(`logUniform requires positive bounds, got [${min}, ${max}]`);
  }
  const a = Math.log(min);
  const b = Math.log(max);
  return Math.exp(rng.range(a, b));
}

export function normal(rng: RNG, mean = 0, std = 1): number {
  return mean + std * rng.gaussian();
}

export function expNormalNoise(rng: RNG, std: number): number {
  return Math.exp(normal(rng, 0, std));
}

export function weightedPick<T extends string>(rng: RNG, items: Array<{ key: T; weight: number }>): T {
  const total = items.reduce((sum, it) => sum + Math.max(0, it.weight), 0);
  if (total <= 0) {
    throw new Error('weightedPick: total weight must be > 0');
  }
  let r = rng.next() * total;
  for (const it of items) {
    r -= Math.max(0, it.weight);
    if (r <= 0) return it.key;
  }
  return items[items.length - 1].key;
}

export function pickFromProbTable<T extends string>(rng: RNG, probs: Record<T, number>): T {
  const entries = Object.entries(probs) as Array<[T, number]>;
  const items = entries.map(([key, weight]) => ({ key, weight }));
  return weightedPick(rng, items);
}

// Poisson sampler (Knuth) - fine for lambdas in this project (<= ~5)
export function poisson(rng: RNG, lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0) {
    throw new Error(`poisson: invalid lambda ${lambda}`);
  }
  if (lambda === 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L);
  return k - 1;
}

// Deterministic 32-bit FNV-1a hash for strings.
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function deriveSeed32(...parts: Array<string | number>): number {
  const s = parts.map(p => String(p)).join('|');
  // Ensure non-zero RNG state
  return (fnv1a32(s) >>> 0) || 1;
}

export function randomUnitWeights(rng: RNG, n: number): number[] {
  if (n <= 0) return [];
  const xs = Array.from({ length: n }, () => -Math.log(Math.max(1e-12, rng.next())));
  const sum = xs.reduce((a, b) => a + b, 0);
  return xs.map(x => x / sum);
}

// ============================================================
// Stars (was: worldgen/stellar/stars.ts)
// ============================================================

export function typeFromMassSun(massSun: number): SpectralType {
  if (massSun < 0.45) return 'M';
  if (massSun < 0.8) return 'K';
  if (massSun < 1.04) return 'G';
  if (massSun < 1.4) return 'F';
  if (massSun < 2.1) return 'A';
  if (massSun < 16) return 'B';
  return 'O';
}

export function drawStarCount(rng: RNG, primaryType: SpectralType): number {
  const pMulti = MULTIPLICITY_PROBABILITY[primaryType];
  if (rng.next() > pMulti) return 1;
  return rng.next() < 0.85 ? 2 : 3;
}

export function drawCompanionMasses(rng: RNG, primaryMassSun: number, count: number): number[] {
  const masses: number[] = [];
  for (let i = 0; i < count; i++) {
    const q = rng.range(0.1, 1.0);
    const m = clamp(q * primaryMassSun, 0.08, 60);
    masses.push(m);
  }
  return masses;
}

export function computeLuminositySun(massSun: number): number {
  if (massSun <= 0.43) return 0.23 * Math.pow(massSun, 2.3);
  if (massSun <= 2) return 1.0 * Math.pow(massSun, 3.9);
  return 1.5 * Math.pow(massSun, 3.5);
}

export function computeRadiusSun(massSun: number): number {
  if (massSun <= 1) return Math.pow(massSun, 0.8);
  return Math.pow(massSun, 0.57);
}

export function computeOrbitalPeriodDays(semiMajorAxisAu: number, totalMassSun: number): number {
  const safeA = Math.max(semiMajorAxisAu, 0.01);
  const safeMass = Math.max(totalMassSun, 0.1);
  const periodYears = Math.sqrt((safeA * safeA * safeA) / safeMass);
  return Math.max(periodYears * 365.25, 1);
}

export function refineStar(rng: RNG, type: SpectralType, massSun: number, role: 'primary' | 'companion'): StarData {
  const bounds = STELLAR_CLASS_BOUNDS[type];
  const m = clamp(massSun, bounds.massSun[0], bounds.massSun[1]);
  const luminositySun = computeLuminositySun(m);
  const radiusSun = computeRadiusSun(m);
  const teffK = rng.range(bounds.teffK[0], bounds.teffK[1]);

  return {
    role,
    spectralType: type,
    massSun: m,
    radiusSun,
    luminositySun,
    teffK
  };
}

export function drawCompanionOrbits(
  rng: RNG,
  primaryMassSun: number,
  companionMasses: number[],
  params: StellarSystemGenParams = DEFAULT_STELLAR_SYSTEM_GEN_PARAMS
): StarOrbit[] {
  if (companionMasses.length === 0) return [];

  const baseMinAu = 0.12;
  const baseMaxAu = Math.max(baseMinAu * 1.5, Math.min(params.maxSemiMajorAxisAu * 0.35, 8));
  const spacingMin = 2.5;
  const spacingMax = 6.5;
  let orbitAu = logUniform(rng, baseMinAu, baseMaxAu);

  return companionMasses.map((massSun, index) => {
    if (index > 0) {
      orbitAu = Math.min(orbitAu * rng.range(spacingMin, spacingMax), params.maxSemiMajorAxisAu * 0.85);
    }
    const inclinationDeg = rng.range(0, 18);
    const ascendingNodeDeg = rng.range(0, 360);
    const phaseDeg = rng.range(0, 360);
    const periodDays = computeOrbitalPeriodDays(orbitAu, primaryMassSun + massSun);
    return {
      semiMajorAxisAu: orbitAu,
      periodDays,
      phaseDeg,
      inclinationDeg,
      ascendingNodeDeg
    };
  });
}

// ============================================================
// Planets (was: worldgen/stellar/planets.ts)
// ============================================================

export function drawMetallicityFeH(rng: RNG, radiusNorm: number): number {
  const noise = normal(rng, 0, METALLICITY_FEH_SIGMA);
  const feh = METALLICITY_FEH_CENTER + METALLICITY_FEH_GRADIENT * clamp01(radiusNorm) + noise;
  return clamp(feh, -0.9, 0.5);
}

export function computeSnowLineAu(L_total: number): number {
  return 2.7 * Math.sqrt(Math.max(0, L_total));
}

export function computeHzAu(L_total: number): { hzInnerAu: number; hzOuterAu: number } {
  const s = Math.sqrt(Math.max(0, L_total));
  return { hzInnerAu: 0.95 * s, hzOuterAu: 1.7 * s };
}

export function generateRelativeOrbitRadii(rng: RNG, planetCount: number, params: StellarSystemGenParams): number[] {
  if (planetCount <= 0) return [];
  const [minR, maxR] = params.firstOrbitLogRange;
  const r: number[] = [];
  r.push(logUniform(rng, minR, maxR));
  for (let i = 1; i < planetCount; i++) {
    const spacing = Math.exp(normal(rng, params.spacingLogMean, params.spacingLogStd));
    r.push(r[i - 1] * spacing);
  }
  return r;
}

export function scaleOrbitsToSnowLine(
  rng: RNG,
  relativeR: number[],
  planetCount: number,
  params: StellarSystemGenParams,
  snowLineAu: number
): number[] {
  if (planetCount <= 0) return [];
  const innerSlots = Math.round(planetCount * params.innerSlotRatio);
  const boundaryIndex = Math.max(1, innerSlots);
  const targetBoundaryAu = snowLineAu * rng.range(params.snowLineMatchRange[0], params.snowLineMatchRange[1]);
  const rBoundary = relativeR[boundaryIndex - 1] ?? relativeR[0];
  const scale = rBoundary > 0 ? targetBoundaryAu / rBoundary : 1;
  return relativeR.map(x => x * scale);
}

export function enforceOrbitCaps(a: number[], params: StellarSystemGenParams): number[] {
  if (a.length === 0) return a;
  let out = a.map(x => Math.max(x, params.minSemiMajorAxisAu));

  const max = out[out.length - 1];
  if (max > params.maxSemiMajorAxisAu) {
    // Compress linearly so the outermost sits at maxSemiMajorAxisAu.
    const compress = params.maxSemiMajorAxisAu / max;
    out = out.map(x => x * compress);
    // Re-enforce min.
    out = out.map(x => Math.max(x, params.minSemiMajorAxisAu));
  }
  return out;
}

export function snapOrbitToType(
  rng: RNG,
  aAu: number,
  planetType: PlanetType,
  snowLineAu: number,
  params: StellarSystemGenParams
): { aAu: number; planetType: PlanetType } {
  let a = aAu;
  let t = planetType;

  if ((t === 'GasGiant' || t === 'IceGiant') && a < 0.9 * snowLineAu) {
    if (rng.next() < params.hotGiantChance) {
      a = logUniform(rng, 0.03, 0.12);
    } else {
      a = Math.max(a, 1.1 * snowLineAu);
    }
  }

  if (t === 'Dwarf' && a < 0.6 * snowLineAu) {
    a = Math.max(a, 0.8 * snowLineAu);
  }

  if (t === 'Terrestrial' && a > 2.5 * snowLineAu) {
    t = 'Dwarf';
  }

  return { aAu: a, planetType: t };
}

export function drawEccentricity(rng: RNG, planetType: PlanetType): number {
  if (planetType === 'Terrestrial' || planetType === 'SubNeptune') {
    return clamp(Math.abs(normal(rng, 0.04, 0.05)), 0, 0.25);
  }
  return clamp(Math.abs(normal(rng, 0.08, 0.08)), 0, 0.35);
}

export function samplePlanetMassEarth(rng: RNG, planetType: PlanetType): number {
  const [minM, maxM] = PLANET_MASS_EARTH_RANGE[planetType];
  return logUniform(rng, minM, maxM);
}

export function computePlanetRadiusEarth(rng: RNG, planetType: PlanetType, massEarth: number): number {
  const noiseTerra = () => expNormalNoise(rng, 0.05);
  const noise = noiseTerra();

  let r: number;
  switch (planetType) {
    case 'Terrestrial':
      r = Math.pow(massEarth, 0.27) * noise;
      break;
    case 'SubNeptune':
      r = 1.6 * Math.pow(massEarth, 0.25) * expNormalNoise(rng, 0.05);
      break;
    case 'IceGiant':
      r = 1.9 * Math.pow(massEarth, 0.22) * expNormalNoise(rng, 0.05);
      break;
    case 'GasGiant':
      r = 11.0 * Math.exp(normal(rng, 0, 0.12));
      break;
    case 'Dwarf':
      r = 1.0 * Math.pow(massEarth, 0.30) * expNormalNoise(rng, 0.05);
      break;
    default:
      r = 1;
  }

  const [minR, maxR] = PLANET_RADIUS_EARTH_CLAMP[planetType];
  return clamp(r, minR, maxR);
}

export function computeGravityG(massEarth: number, radiusEarth: number): number {
  return massEarth / (radiusEarth * radiusEarth);
}

export function computeFluxEarth(L_total: number, aAu: number): number {
  return L_total / (aAu * aAu);
}

export function computeTeqK(fluxEarth: number, albedo: number): number {
  const f = Math.max(0, fluxEarth);
  const a = clamp(albedo, 0, 0.98);
  return 278.5 * Math.pow(f, 0.25) * Math.pow((1 - a) / 0.7, 0.25);
}

const resolvePressureBar = (pressureBar: number | undefined, minP: number, maxP: number): number => {
  if (typeof pressureBar === 'number' && Number.isFinite(pressureBar)) {
    return clamp(pressureBar, minP, maxP);
  }
  return (minP + maxP) * 0.5;
};

const normalizeLog = (value: number, min: number, max: number): number => {
  const safeMin = Math.max(min, 1e-6);
  const safeMax = Math.max(max, safeMin + 1e-6);
  const clamped = clamp(value, safeMin, safeMax);
  const denom = Math.log10(safeMax / safeMin);
  if (denom <= 0) return 0;
  return clamp01(Math.log10(clamped / safeMin) / denom);
};

const computeGreenhouseK = <T extends string>(params: {
  atmosphere: T;
  pressureBar?: number;
  pressureRanges: Record<T, [number, number]>;
  greenhouseRanges: Record<T, [number, number]>;
}): number => {
  const { atmosphere, pressureBar, pressureRanges, greenhouseRanges } = params;
  const [minK, maxK] = greenhouseRanges[atmosphere];
  if (minK <= 0 && maxK <= 0) return 0;
  const [minP, maxP] = pressureRanges[atmosphere];
  const resolvedP = resolvePressureBar(pressureBar, Math.max(minP, 1e-6), Math.max(maxP, minP + 1e-6));
  const t = normalizeLog(resolvedP, Math.max(minP, 1e-6), Math.max(maxP, minP + 1e-6));
  return lerp(minK, maxK, t);
};

const computeAirMassIndex = (atmosphere: AtmosphereType, pressureBar?: number): number => {
  if (atmosphere === 'None') return 0;
  const [minP, maxP] = AIR_MASS_PRESSURE_RANGE_BAR;
  const resolvedP = resolvePressureBar(pressureBar, minP, maxP);
  const pressureIndex = normalizeLog(resolvedP, minP, maxP);
  return clamp01(pressureIndex * ATMOSPHERE_AIRMASS_WEIGHT[atmosphere]);
};

export function computePlanetClimate(params: {
  teqK: number;
  atmosphere: AtmosphereType;
  pressureBar?: number;
}): { climateK: number; greenhouseK: number; airMassIndex: number } {
  const greenhouseK = computeGreenhouseK({
    atmosphere: params.atmosphere,
    pressureBar: params.pressureBar,
    pressureRanges: ATMOSPHERE_PRESSURE_BAR,
    greenhouseRanges: PLANET_GREENHOUSE_K_RANGE
  });
  const climateK = clamp(params.teqK + greenhouseK, 30, 2000);
  const airMassIndex = computeAirMassIndex(params.atmosphere, params.pressureBar);
  return { climateK, greenhouseK, airMassIndex };
}

export function computeMoonClimate(params: {
  teqK: number;
  atmosphere: Exclude<AtmosphereType, 'H2He'>;
  pressureBar?: number;
  tidalBonusK?: number;
}): { climateK: number; greenhouseK: number; airMassIndex: number } {
  const baseK = clamp(params.teqK + (params.tidalBonusK ?? 0), 30, 2000);
  const greenhouseK = computeGreenhouseK({
    atmosphere: params.atmosphere,
    pressureBar: params.pressureBar,
    pressureRanges: MOON_ATMOSPHERE_PRESSURE_BAR,
    greenhouseRanges: MOON_GREENHOUSE_K_RANGE
  });
  const climateK = clamp(baseK + greenhouseK, 30, 2000);
  const airMassIndex = computeAirMassIndex(params.atmosphere, params.pressureBar);
  return { climateK, greenhouseK, airMassIndex };
}

const MIN_SECONDARY_MASS_EARTH = 0.05;
const MIN_MOON_SECONDARY_MASS_EARTH = 0.005;
const EARTHLIKE_MIN_MASS_EARTH = 0.7;
const PRIMARY_RETENTION_MASS_EARTH = 2.2;
const PRIMARY_RETENTION_MAX_FLUX = 2.5;
const PRIMARY_RETENTION_MAX_TEQ_K = 600;
const MOON_EROSION_PENALTY = 0.12;

const drawScaledPressureBar = (
  rng: RNG,
  range: [number, number],
  scale: number,
  minScale = 0.25,
  maxScale = 1.8
): number => {
  const [minP, maxP] = range;
  const base = rng.range(minP, maxP);
  const clampedScale = clamp(scale, minScale, maxScale);
  return clamp(base * clampedScale, minP * 0.2, maxP * 2.0);
};

const scalePressureBar = (
  pressureBar: number,
  range: [number, number],
  scale: number,
  minScale = 0.25,
  maxScale = 1.8
): number => {
  const [minP, maxP] = range;
  const clampedScale = clamp(scale, minScale, maxScale);
  return clamp(pressureBar * clampedScale, minP * 0.2, maxP * 2.0);
};

const computeAtmosphereIndices = (params: {
  massEarth: number;
  gravityG: number;
  teqK: number;
  fluxEarth: number;
  tidalBonusK?: number;
  erosionBias?: number;
  massFloor?: number;
  massRange?: number;
}): {
  erosionIndex: number;
  heavyRetention: number;
  lightRetention: number;
  outgassingIndex: number;
} => {
  const massFloor = params.massFloor ?? 0.05;
  const massRange = params.massRange ?? 1.6;
  const massScore = clamp01((params.massEarth - massFloor) / massRange);
  const gravityScore = clamp01((params.gravityG - 0.12) / 1.0);
  const tempScore = clamp01((params.teqK - 160) / 320);
  const fluxScore = clamp01((params.fluxEarth - 0.6) / 6);
  const erosionIndex = clamp01(0.55 * tempScore + 0.45 * fluxScore + (params.erosionBias ?? 0));
  const heavyRetention = clamp01(0.62 * massScore + 0.38 * gravityScore - 0.5 * erosionIndex);
  const lightRetention = clamp01(0.85 * massScore + 0.55 * gravityScore - 0.9 * erosionIndex - 0.15);
  const tidalScore = clamp01((params.tidalBonusK ?? 0) / 140);
  const outgassingIndex = clamp01(0.2 + 0.55 * massScore + 0.25 * tidalScore - 0.15 * erosionIndex);

  return { erosionIndex, heavyRetention, lightRetention, outgassingIndex };
};

export function pickPlanetAlbedo(planetType: PlanetType): number {
  return DEFAULT_PLANET_ALBEDO[planetType];
}

export function canHoldAtmosphere(massEarth: number, gravityG: number): boolean {
  return gravityG >= 0.12 && massEarth >= MIN_SECONDARY_MASS_EARTH;
}

export function assignPlanetAtmosphere(
  rng: RNG,
  planetType: PlanetType,
  massEarth: number,
  gravityG: number,
  teqK: number,
  fluxEarth: number,
  derived: StellarDerived
): { atmosphere: AtmosphereType; pressureBar?: number } {
  if (planetType === 'GasGiant' || planetType === 'IceGiant' || planetType === 'SubNeptune') {
    const pressureBar = drawScaledPressureBar(
      rng,
      ATMOSPHERE_PRESSURE_BAR.H2He,
      0.9 + 0.2 * clamp01((massEarth - 10) / 200),
      0.7,
      1.3
    );
    return { atmosphere: 'H2He', pressureBar };
  }

  const flux = Math.max(0.01, fluxEarth);
  const indices = computeAtmosphereIndices({ massEarth, gravityG, teqK, fluxEarth: flux });

  if (!canHoldAtmosphere(massEarth, gravityG) || indices.heavyRetention < 0.08) {
    return { atmosphere: 'None' };
  }

  if (
    planetType === 'Terrestrial'
    && massEarth >= PRIMARY_RETENTION_MASS_EARTH
    && indices.lightRetention >= 0.7
    && flux <= PRIMARY_RETENTION_MAX_FLUX
    && teqK <= PRIMARY_RETENTION_MAX_TEQ_K
  ) {
    const scale = 0.3 + 0.6 * indices.lightRetention + 0.1 * clamp01((massEarth - PRIMARY_RETENTION_MASS_EARTH) / 4);
    const pressureBar = drawScaledPressureBar(rng, ATMOSPHERE_PRESSURE_BAR.H2He, scale, 0.2, 0.9);
    return { atmosphere: 'H2He', pressureBar };
  }

  // Proxy surface climate using a nominal 1 bar Earthlike greenhouse.
  const proxySurface = computePlanetClimate({ teqK, atmosphere: 'Earthlike', pressureBar: 1 }).climateK;

  const inHz = proxySurface >= 240 && proxySurface <= 320;
  const orbitInHz = derived.hzInnerAu <= derived.semiMajorAxisAu && derived.semiMajorAxisAu <= derived.hzOuterAu;

  const earthlikeEligible = planetType === 'Terrestrial'
    && massEarth >= EARTHLIKE_MIN_MASS_EARTH
    && indices.heavyRetention >= 0.55
    && indices.erosionIndex <= 0.55
    && inHz
    && orbitInHz;
  const earthlikeMassBias = clamp01(1 - Math.max(0, (massEarth - 1.2) / 2));
  const earthlikeChance = clamp01(
    0.25 + 0.5 * indices.outgassingIndex - 0.3 * indices.erosionIndex + 0.2 * earthlikeMassBias
  );

  if (earthlikeEligible && rng.next() < earthlikeChance) {
    const scale = 0.6 + 0.7 * indices.heavyRetention + 0.3 * indices.outgassingIndex - 0.2 * indices.erosionIndex;
    const pressureBar = drawScaledPressureBar(rng, ATMOSPHERE_PRESSURE_BAR.Earthlike, scale, 0.6, 1.6);
    return { atmosphere: 'Earthlike', pressureBar };
  }

  const co2Eligible = indices.outgassingIndex >= 0.35 && indices.heavyRetention >= 0.35;
  const hotBias = clamp01((teqK - 260) / 220 + (flux - 1) / 5);
  const co2Chance = clamp01(0.2 + 0.6 * hotBias + 0.2 * indices.outgassingIndex);
  if (co2Eligible && rng.next() < co2Chance) {
    const scale = 0.8 + 0.7 * indices.heavyRetention + 0.4 * indices.outgassingIndex;
    const pressureBar = drawScaledPressureBar(rng, ATMOSPHERE_PRESSURE_BAR.CO2, scale, 0.6, 1.8);
    return { atmosphere: 'CO2', pressureBar };
  }

  if (indices.heavyRetention < 0.15 && indices.outgassingIndex < 0.25) {
    return { atmosphere: 'None' };
  }

  const thinScale = 0.25 + 0.6 * indices.heavyRetention + 0.3 * indices.outgassingIndex;
  const pressureBar = drawScaledPressureBar(rng, ATMOSPHERE_PRESSURE_BAR.Thin, thinScale, 0.2, 1.2);
  return { atmosphere: 'Thin', pressureBar };
}

export function deriveClimateTag(
  planetType: PlanetType,
  climateK: number,
  atmosphere: AtmosphereType,
  airMassIndex?: number
): string | undefined {
  const airOk = airMassIndex === undefined || airMassIndex >= 0.45;
  if (planetType === 'Terrestrial') {
    if (climateK < 200) return 'IceWorld';
    if (climateK < 250) return 'Cold';
    if (climateK >= 275 && climateK <= 305 && atmosphere === 'Earthlike' && airOk) return 'Eden';
    if (climateK <= 700) return 'Desertic';
    return 'Volcanic';
  }
  if (planetType === 'GasGiant' || planetType === 'IceGiant') {
    if (climateK > 900) return 'HotGiant';
    if (climateK > 300) return 'WarmGiant';
    return 'ColdGiant';
  }
  if (planetType === 'Dwarf') {
    return climateK < 180 ? 'IcyDwarf' : 'RockyDwarf';
  }
  return undefined;
}

export function drawPlanetTypes(rng: RNG, planetCount: number, primaryType: SpectralType, metallicityFeH: number): PlanetTypePlan {
  if (planetCount <= 0) return [];

  const pGiant = (() => {
    if (primaryType === 'M') return clamp(0.04 * Math.exp(1.3 * metallicityFeH), 0.01, 0.12);
    if (primaryType === 'F' || primaryType === 'G' || primaryType === 'K') {
      return clamp(0.08 * Math.exp(1.6 * metallicityFeH), 0.03, 0.22);
    }
    return clamp(0.06 * Math.exp(1.5 * metallicityFeH), 0.03, 0.2);
  })();

  const gasBias = (() => {
    const spectralBonus = primaryType === 'F' || primaryType === 'G' ? 0.08 : primaryType === 'M' ? -0.08 : 0;
    const metallicityBonus = 0.25 * (metallicityFeH + 0.1);
    return clamp(0.35 + metallicityBonus + spectralBonus, 0.2, 0.75);
  })();

  let giantCount = 0;
  if (rng.next() < pGiant) {
    giantCount = 1 + (rng.next() < 0.35 ? 1 : 0);
  }

  const innerSlots = Math.round(planetCount * 0.55);
  let outerSlots = planetCount - innerSlots;

  const innerProbs: PlanetTypeProbs = { Terrestrial: 0.65, SubNeptune: 0.3, Dwarf: 0.05, IceGiant: 0, GasGiant: 0 };
  const outerGasWeight = clamp(0.02 + 0.08 * Math.exp(1.2 * metallicityFeH), 0.02, 0.12);
  const outerIceWeight = clamp(0.3 - outerGasWeight * 0.6, 0.15, 0.3);
  const outerProbs: PlanetTypeProbs = {
    Dwarf: 0.45,
    IceGiant: outerIceWeight,
    GasGiant: outerGasWeight,
    SubNeptune: 0.15,
    Terrestrial: 0.1
  };

  const plan: PlanetTypePlan = [];

  for (let i = 0; i < innerSlots; i++) {
    plan.push(pickFromProbTable(rng, innerProbs));
  }

  const outer: PlanetType[] = [];
  for (let i = 0; i < outerSlots; i++) {
    outer.push(pickFromProbTable(rng, outerProbs));
  }

  // Inject giants (replace first Dwarf/SubNeptune if needed).
  for (let g = 0; g < giantCount; g++) {
    const giantType: PlanetType = rng.next() < gasBias ? 'GasGiant' : 'IceGiant';
    let replaced = false;
    for (let j = 0; j < outer.length; j++) {
      if (outer[j] === 'Dwarf' || outer[j] === 'SubNeptune') {
        outer[j] = giantType;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      outer.push(giantType);
      outerSlots++;
    }
  }

  // Trim to planetCount if we overflow.
  const combined = plan.concat(outer);
  return combined.slice(0, planetCount);
}

export function buildPlanet(
  rng: RNG,
  planetType: PlanetType,
  semiMajorAxisAu: number,
  eccentricity: number,
  L_total: number,
  hzInnerAu: number,
  hzOuterAu: number
): PlanetData {
  const massEarth = samplePlanetMassEarth(rng, planetType);
  const radiusEarth = computePlanetRadiusEarth(rng, planetType, massEarth);
  const gravityG = computeGravityG(massEarth, radiusEarth);

  const albedo = pickPlanetAlbedo(planetType);
  const flux = computeFluxEarth(L_total, semiMajorAxisAu);
  const teqK = computeTeqK(flux, albedo);

  const derived: StellarDerived = { semiMajorAxisAu, hzInnerAu, hzOuterAu };
  const { atmosphere, pressureBar } = assignPlanetAtmosphere(rng, planetType, massEarth, gravityG, teqK, flux, derived);
  const { climateK, greenhouseK, airMassIndex } = computePlanetClimate({ teqK, atmosphere, pressureBar });
  const temperatureK = climateK;

  const climateTag = deriveClimateTag(planetType, climateK, atmosphere, airMassIndex);

  const planet: PlanetData = {
    type: planetType,
    semiMajorAxisAu,
    eccentricity,
    massEarth,
    radiusEarth,
    gravityG,
    albedo,
    teqK,
    atmosphere,
    greenhouseK,
    climateK,
    airMassIndex,
    temperatureK,
    moons: []
  };

  if (pressureBar !== undefined) {
    planet.pressureBar = pressureBar;
  }
  if (climateTag !== undefined) {
    planet.climateTag = climateTag;
  }

  return planet;
}

// ============================================================
// Moons (was: worldgen/stellar/moons.ts)
// ============================================================

export function drawRegularMoonCount(rng: RNG, planetType: PlanetType): number {
  switch (planetType) {
    case 'GasGiant':
      return rng.int(4, 8);
    case 'IceGiant':
      return rng.int(2, 6);
    case 'SubNeptune':
      return rng.int(0, 2);
    case 'Terrestrial':
      return rng.next() < 0.25 ? rng.int(1, 2) : 0;
    case 'Dwarf':
      return rng.next() < 0.15 ? 1 : 0;
  }
}

export function drawIrregularMoonCount(rng: RNG, planetType: PlanetType): number {
  switch (planetType) {
    case 'GasGiant':
      return rng.int(0, 4);
    case 'IceGiant':
      return rng.int(0, 3);
    case 'SubNeptune':
      return rng.int(0, 2);
    case 'Terrestrial':
      return rng.int(0, 1);
    case 'Dwarf':
      return rng.int(0, 1);
  }
}

export function drawMoonTypes(rng: RNG, planetType: PlanetType, regularCount: number, irregularCount: number): MoonType[] {
  const moons: MoonType[] = [];

  const maybeEden: () => MoonType | null = () => (rng.next() < 0.02 ? 'Eden' : null);

  for (let k = 1; k <= regularCount; k++) {
    if (planetType === 'GasGiant' || planetType === 'IceGiant') {
      const roll = rng.next();
      let t: MoonType;
      if (k === 1) {
        t = roll < 0.35 ? 'Volcanic' : roll < 0.8 ? 'Regular' : 'Icy';
      } else if (k === 2) {
        t = roll < 0.2 ? 'Volcanic' : roll < 0.7 ? 'Regular' : 'Icy';
      } else {
        t = roll < 0.05 ? 'Volcanic' : roll < 0.5 ? 'Regular' : 'Icy';
      }
      if (t === 'Regular') {
        const e = maybeEden();
        if (e) t = e;
      }
      moons.push(t);
      continue;
    }

    if (planetType === 'Terrestrial') {
      const roll = rng.next();
      moons.push(roll < 0.7 ? 'Regular' : roll < 0.95 ? 'Icy' : 'Eden');
      continue;
    }

    if (planetType === 'SubNeptune') {
      const roll = rng.next();
      moons.push(roll < 0.6 ? 'Regular' : roll < 0.95 ? 'Icy' : 'Volcanic');
      continue;
    }

    // Dwarf
    moons.push(rng.next() < 0.8 ? 'Icy' : 'Regular');
  }

  for (let k = 0; k < irregularCount; k++) {
    moons.push('Irregular');
  }

  return moons;
}

export function generateMoonOrbitDistancesRp(rng: RNG, regularCount: number, irregularCount: number): number[] {
  const out: number[] = [];

  if (regularCount > 0) {
    let d = rng.range(6, 12);
    out.push(d);
    for (let i = 2; i <= regularCount; i++) {
      d = d * rng.range(1.4, 2.0);
      d = Math.min(d, 80);
      out.push(d);
    }
  }

  for (let i = 0; i < irregularCount; i++) {
    out.push(rng.range(80, 400));
  }

  return out;
}

export function allocateMoonMassesEarth(rng: RNG, planetType: PlanetType, planetMassEarth: number, regularCount: number): number[] {
  if (regularCount <= 0) return [];

  const [fMin, fMax] = MOON_MASS_BUDGET_FRACTION[planetType];
  const fTotal = rng.range(fMin, fMax);
  const total = fTotal * planetMassEarth;
  if (total <= 0) return Array.from({ length: regularCount }, () => 0);

  const weights = randomUnitWeights(rng, regularCount);
  return weights.map(w => w * total);
}

export function computeMoonRadiusEarth(rng: RNG, massEarth: number): number {
  const r = Math.pow(Math.max(1e-12, massEarth), 0.3) * expNormalNoise(rng, 0.07);
  return clamp(r, MOON_RADIUS_EARTH_RANGE[0], MOON_RADIUS_EARTH_RANGE[1]);
}

export function computeMoonGravityG(massEarth: number, radiusEarth: number): number {
  return massEarth / (radiusEarth * radiusEarth);
}

export function canHoldMoonAtmosphere(massEarth: number, gravityG: number): boolean {
  return massEarth >= MIN_MOON_SECONDARY_MASS_EARTH || gravityG >= 0.08;
}

export function drawMoonPressureBar(
  rng: RNG,
  atmosphere: Exclude<AtmosphereType, 'H2He'>,
  gravityG: number
): number | undefined {
  if (atmosphere === 'None') return undefined;
  const [minP, maxP] = MOON_ATMOSPHERE_PRESSURE_BAR[atmosphere];
  const gravityScale = clamp(0.3 + gravityG * 0.9, 0.25, 1.1);
  return rng.range(minP, maxP) * gravityScale;
}

export function assignMoonAtmosphere(
  rng: RNG,
  params: {
    moonType: MoonType;
    massEarth: number;
    gravityG: number;
    teqK: number;
    fluxEarth: number;
    tidalBonusK: number;
  }
): { atmosphere: Exclude<AtmosphereType, 'H2He'>; finalMoonType: MoonType; pressureBar?: number } {
  const { moonType, massEarth, gravityG, teqK, fluxEarth, tidalBonusK } = params;
  if (moonType === 'Irregular') return { atmosphere: 'None', finalMoonType: moonType };

  const proxyTempK = teqK + tidalBonusK;
  const indices = computeAtmosphereIndices({
    massEarth,
    gravityG,
    teqK: proxyTempK,
    fluxEarth: Math.max(0.01, fluxEarth),
    tidalBonusK,
    erosionBias: MOON_EROSION_PENALTY,
    massFloor: 0.002,
    massRange: 0.02
  });

  if (!canHoldMoonAtmosphere(massEarth, gravityG) || indices.heavyRetention < 0.1) {
    const finalMoonType = moonType === 'Eden' || moonType === 'Volcanic' ? 'Regular' : moonType;
    return { atmosphere: 'None', finalMoonType };
  }

  if (moonType === 'Eden') {
    if (proxyTempK >= 240 && proxyTempK <= 320 && indices.heavyRetention >= 0.5 && indices.erosionIndex <= 0.55) {
      const scale = 0.7 + 0.7 * indices.heavyRetention + 0.3 * indices.outgassingIndex - 0.2 * indices.erosionIndex;
      const base = drawMoonPressureBar(rng, 'Earthlike', gravityG) ?? 1;
      const pressureBar = scalePressureBar(base, MOON_ATMOSPHERE_PRESSURE_BAR.Earthlike, scale, 0.5, 1.6);
      return { atmosphere: 'Earthlike', finalMoonType: 'Eden', pressureBar };
    }
    const scale = 0.25 + 0.6 * indices.heavyRetention + 0.3 * indices.outgassingIndex;
    const base = drawMoonPressureBar(rng, 'Thin', gravityG) ?? 0.02;
    const pressureBar = scalePressureBar(base, MOON_ATMOSPHERE_PRESSURE_BAR.Thin, scale, 0.2, 1.2);
    return { atmosphere: 'Thin', finalMoonType: 'Regular', pressureBar };
  }

  if (moonType === 'Volcanic') {
    if (indices.outgassingIndex >= 0.45 && indices.heavyRetention >= 0.2) {
      const scale = 0.8 + 0.6 * indices.heavyRetention + 0.4 * indices.outgassingIndex;
      const base = drawMoonPressureBar(rng, 'CO2', gravityG) ?? 0.5;
      const pressureBar = scalePressureBar(base, MOON_ATMOSPHERE_PRESSURE_BAR.CO2, scale, 0.5, 1.8);
      return { atmosphere: 'CO2', finalMoonType: 'Volcanic', pressureBar };
    }
    const scale = 0.25 + 0.6 * indices.heavyRetention + 0.3 * indices.outgassingIndex;
    const base = drawMoonPressureBar(rng, 'Thin', gravityG) ?? 0.02;
    const pressureBar = scalePressureBar(base, MOON_ATMOSPHERE_PRESSURE_BAR.Thin, scale, 0.2, 1.2);
    return { atmosphere: 'Thin', finalMoonType: 'Regular', pressureBar };
  }

  if (moonType === 'Icy') {
    if (indices.heavyRetention >= 0.25) {
      const scale = 0.25 + 0.6 * indices.heavyRetention + 0.3 * indices.outgassingIndex;
      const base = drawMoonPressureBar(rng, 'Thin', gravityG) ?? 0.02;
      const pressureBar = scalePressureBar(base, MOON_ATMOSPHERE_PRESSURE_BAR.Thin, scale, 0.2, 1.2);
      return { atmosphere: 'Thin', finalMoonType: 'Icy', pressureBar };
    }
    return { atmosphere: 'None', finalMoonType: 'Icy' };
  }

  if (indices.heavyRetention >= 0.25) {
    const scale = 0.25 + 0.6 * indices.heavyRetention + 0.3 * indices.outgassingIndex;
    const base = drawMoonPressureBar(rng, 'Thin', gravityG) ?? 0.02;
    const pressureBar = scalePressureBar(base, MOON_ATMOSPHERE_PRESSURE_BAR.Thin, scale, 0.2, 1.2);
    return { atmosphere: 'Thin', finalMoonType: 'Regular', pressureBar };
  }

  return { atmosphere: 'None', finalMoonType: 'Regular' };
}

export function tidalBonusK(rng: RNG, planetType: PlanetType, moonRank: number): number {
  if (planetType !== 'GasGiant' && planetType !== 'IceGiant') return 0;

  if (moonRank === 1) return rng.range(0, 120);
  if (moonRank === 2) return rng.range(0, 60);
  return rng.range(0, 20);
}

export function refineMoons(rng: RNG, planet: PlanetData, planetType: PlanetType, moonTypes: MoonType[], L_total: number): MoonData[] {
  if (moonTypes.length === 0) return [];

  const regular = moonTypes.filter(t => t !== 'Irregular');
  const irregular = moonTypes.filter(t => t === 'Irregular');

  const regularMasses = allocateMoonMassesEarth(rng, planetType, planet.massEarth, regular.length);
  const orbitDistances = generateMoonOrbitDistancesRp(rng, regular.length, irregular.length);

  const out: MoonData[] = [];

  const flux = computeFluxEarth(L_total, planet.semiMajorAxisAu);

  // Regulars first, then irregulars.
  let regularIndex = 0;
  for (let i = 0; i < moonTypes.length; i++) {
    const t0 = moonTypes[i];
    const orbitDistanceRp = orbitDistances[i] ?? rng.range(10, 80);

    const isRegular = t0 !== 'Irregular';
    const rank = isRegular ? Math.max(1, i + 1) : 0;

    const massEarth = isRegular
      ? clamp(
          regularMasses[Math.min(regularIndex, Math.max(0, regularMasses.length - 1))] ?? logUniform(rng, 1e-5, 0.02),
          1e-6,
          0.02
        )
      : logUniform(rng, 1e-5, 0.02);
    if (isRegular) regularIndex++;

    const radiusEarth = computeMoonRadiusEarth(rng, massEarth);
    const gravityG = computeMoonGravityG(massEarth, radiusEarth);

    const albedo = MOON_ALBEDO[t0];
    const teqK = computeTeqK(flux, albedo);

    const tidal = isRegular ? tidalBonusK(rng, planetType, rank) : 0;

    const { atmosphere, finalMoonType, pressureBar } = assignMoonAtmosphere(rng, {
      moonType: t0,
      massEarth,
      gravityG,
      teqK,
      fluxEarth: flux,
      tidalBonusK: tidal
    });
    const { climateK, greenhouseK, airMassIndex } = computeMoonClimate({
      teqK,
      atmosphere,
      pressureBar,
      tidalBonusK: tidal
    });
    const temperatureK = climateK;

    const moon: MoonData = {
      type: finalMoonType,
      orbitDistanceRp,
      massEarth,
      radiusEarth,
      gravityG,
      albedo,
      teqK,
      tidalBonusK: tidal,
      atmosphere,
      greenhouseK,
      climateK,
      airMassIndex,
      temperatureK
    };

    if (pressureBar !== undefined) {
      moon.pressureBar = pressureBar;
    }

    out.push(moon);
  }

  return out;
}

// ============================================================
// Generate stellar system (was: worldgen/stellar/generateStellarSystem.ts)
// ============================================================

export interface GenerateStellarSystemInput {
  worldSeed: number;
  systemId: string;
  systemPosition?: { x: number; y: number; z: number };
  galacticRadius?: number;
  params?: Partial<StellarSystemGenParams>;
  audit?: WorldgenAuditSink;
}

function mergeParams(p?: Partial<StellarSystemGenParams>): StellarSystemGenParams {
  return {
    ...DEFAULT_STELLAR_SYSTEM_GEN_PARAMS,
    ...(p || {})
  };
}

export function generateStellarSystem(input: GenerateStellarSystemInput): StarSystemAstro {
  const params = mergeParams(input.params);
  const seed = deriveSeed32(input.worldSeed, input.systemId, 'astro');
  const rng = new RNG(seed);
  const rngStateBefore = rng.getState();
  const radiusNorm = computeGalacticRadiusNorm(input.systemPosition, input.galacticRadius);
  const contextRng = new RNG(deriveSeed32(input.worldSeed, input.systemId, 'astro_context'));

  const { ageGyr: stellarAgeGyr, ageClass: stellarAgeClass } = drawStellarAge(contextRng, radiusNorm);

  // Phase A: discrete plan
  const spectralWeights = scaleSpectralWeightsForAge(stellarAgeClass);
  const primarySpectralType = weightedPick(rng, spectralWeights.map(x => ({ key: x.type, weight: x.weight })));

  const primaryMassRange = STELLAR_CLASS_BOUNDS[primarySpectralType].massSun;
  const primaryMassSun = rng.range(primaryMassRange[0], primaryMassRange[1]);

  const starCount = drawStarCount(rng, primarySpectralType);
  const companionCount = Math.max(0, starCount - 1);
  const companionMasses = drawCompanionMasses(rng, primaryMassSun, companionCount);
  const orbitRng = new RNG(deriveSeed32(seed, 'star_orbits'));
  const companionOrbits = drawCompanionOrbits(orbitRng, primaryMassSun, companionMasses, params);

  const metallicityFeH = drawMetallicityFeH(contextRng, radiusNorm);

  const lambda = PLANET_COUNT_LAMBDA_BY_PRIMARY[primarySpectralType];
  const planetCount = Math.max(0, Math.min(params.maxPlanets, poisson(rng, lambda)));

  const planetTypes = drawPlanetTypes(rng, planetCount, primarySpectralType, metallicityFeH);

  const moonsPlan: StellarSystemPlan['moons'] = [];
  for (const pt of planetTypes) {
    const regularCount = drawRegularMoonCount(rng, pt);
    const irregularCount = drawIrregularMoonCount(rng, pt);
    const moonTypes = drawMoonTypes(rng, pt, regularCount, irregularCount);
    moonsPlan.push(moonTypes);
  }

  // Phase B: continuous refinement
  const stars: StarData[] = [];
  stars.push(refineStar(rng, primarySpectralType, primaryMassSun, 'primary'));

  companionMasses.forEach((m, index) => {
    const t = typeFromMassSun(m);
    const refined = refineStar(rng, t, m, 'companion');
    const orbit = companionOrbits[index];
    stars.push(orbit ? { ...refined, orbit } : refined);
  });

  const luminosityTotalLSun = stars.reduce((sum, s) => sum + s.luminositySun, 0);
  const snowLineAu = computeSnowLineAu(luminosityTotalLSun);
  const { hzInnerAu, hzOuterAu } = computeHzAu(luminosityTotalLSun);

  // Orbits
  const relativeR = generateRelativeOrbitRadii(rng, planetCount, params);
  let semiMajorAxes = scaleOrbitsToSnowLine(rng, relativeR, planetCount, params, snowLineAu);
  semiMajorAxes = enforceOrbitCaps(semiMajorAxes, params);

  const planets: PlanetData[] = [];
  for (let i = 0; i < planetCount; i++) {
    const originalType = planetTypes[i] as PlanetType;
    const rawA = semiMajorAxes[i];
    const snapped = snapOrbitToType(rng, rawA, originalType, snowLineAu, params);

    const e = drawEccentricity(rng, snapped.planetType);

    const planet = buildPlanet(rng, snapped.planetType, snapped.aAu, e, luminosityTotalLSun, hzInnerAu, hzOuterAu);

    planet.moons = refineMoons(rng, planet, snapped.planetType, moonsPlan[i] || [], luminosityTotalLSun);
    planets.push(planet);
  }

  const orderedPlanets = sorted(planets, (a, b) => a.semiMajorAxisAu - b.semiMajorAxisAu);
  const rngStateAfter = rng.getState();

  const planetTypeCounts: Record<PlanetType, number> = {
    Terrestrial: 0,
    SubNeptune: 0,
    IceGiant: 0,
    GasGiant: 0,
    Dwarf: 0
  };
  orderedPlanets.forEach(planet => {
    planetTypeCounts[planet.type] += 1;
  });

  const astroHash = fnv1a32(JSON.stringify({ stars, planets: orderedPlanets }));

  input.audit?.({
    step: 'astro',
    kind: 'astro_generated',
    entityId: input.systemId,
    rngStateBefore,
    rngStateAfter,
    outputs: {
      seed,
      primarySpectralType,
      starCount,
      companionCount,
      metallicityFeH,
      stellarAgeGyr,
      stellarAgeClass,
      galacticRadiusNorm: radiusNorm,
      planetCount: orderedPlanets.length,
      planetTypes: orderedPlanets.map(planet => planet.type),
      planetTypeCounts,
      moonCountsByPlanet: orderedPlanets.map(planet => planet.moons?.length ?? 0),
      derived: {
        luminosityTotalLSun,
        snowLineAu,
        hzInnerAu,
        hzOuterAu
      },
      stars: stars.map(star => ({
        role: star.role,
        spectralType: star.spectralType,
        massSun: star.massSun,
        radiusSun: star.radiusSun,
        luminositySun: star.luminositySun,
        teffK: star.teffK,
        orbit: star.orbit
      })),
      astroHash
    }
  });

  return {
    seed,
    primarySpectralType,
    starCount,
    metallicityFeH,
    stellarAgeGyr,
    stellarAgeClass,
    derived: {
      luminosityTotalLSun,
      snowLineAu,
      hzInnerAu,
      hzOuterAu
    },
    stars,
    planets: orderedPlanets
  };
}
