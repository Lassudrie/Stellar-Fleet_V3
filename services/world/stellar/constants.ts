import {
  AtmosphereType,
  MoonType,
  PlanetType,
  SpectralType,
  StellarClassBounds,
  StellarMultiplicityByPrimaryType,
  StellarSystemGenParams,
  WeightedSpectralType
} from '../../../types';

export const DEFAULT_STELLAR_SYSTEM_GEN_PARAMS: StellarSystemGenParams = {
  maxPlanets: 10,
  maxSemiMajorAxisAu: 60,
  minSemiMajorAxisAu: 0.04,
  innerSlotRatio: 0.55,
  hotGiantChance: 0.10,
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
  M: 0.30,
  K: 0.40,
  G: 0.50,
  F: 0.55,
  A: 0.60,
  B: 0.70,
  O: 0.80
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

export const GREENHOUSE_OFFSETS_K: Record<AtmosphereType, number> = {
  None: 0,
  Thin: 8,
  Earthlike: 33,
  CO2: 60,
  H2He: 90
};

export const MOON_GREENHOUSE_OFFSETS_K: Record<Exclude<AtmosphereType, 'H2He'>, number> = {
  None: 0,
  Thin: 5,
  Earthlike: 25,
  CO2: 40
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

export const DEFAULT_PLANET_ALBEDO: Record<PlanetType, number> = {
  Terrestrial: 0.30,
  SubNeptune: 0.45,
  IceGiant: 0.60,
  GasGiant: 0.50,
  Dwarf: 0.55
};

export const MOON_MASS_BUDGET_FRACTION: Record<PlanetType, [number, number]> = {
  GasGiant: [2e-4, 1e-3],
  IceGiant: [1e-4, 6e-4],
  SubNeptune: [0, 2e-4],
  Terrestrial: [0, 3e-4],
  Dwarf: [0, 1e-4]
};
