import type { AtmosphereType, MoonData, PlanetData } from '../../shared/types';

export type SurfaceClass = 'airless' | 'icy' | 'temperate' | 'hot' | 'dense';

export interface SurfaceParams {
  surfaceClass: SurfaceClass;
  waterFraction: number;     // 0..1
  reliefScale: number;       // >0
  humidityFactor: number;    // 0..1
  latGradientK: number;      // >0
  lapseRateK: number;        // K per "elev unit" above sea level
  craterIntensity: number;   // 0..1
  volcanismIndex: number;    // 0..1
  riversEnabled: boolean;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

const atmosphereDensityFactor = (atm: AtmosphereType): number => {
  switch (atm) {
    case 'None': return 0;
    case 'Thin': return 0.25;
    case 'Earthlike': return 0.6;
    case 'CO2': return 0.8;
    case 'H2He': return 1.0;
    default: return 0.4;
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
  const density = atmosphereDensityFactor(moon.atmosphere);
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

