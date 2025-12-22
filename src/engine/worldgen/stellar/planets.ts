import { RNG } from '../../rng';
import {
  AtmosphereType,
  PlanetData,
  PlanetType,
  PlanetTypePlan,
  PlanetTypeProbs,
  StellarDerived,
  StellarSystemGenParams
} from '../../../shared/types';
import {
  ATMOSPHERE_PRESSURE_BAR,
  DEFAULT_PLANET_ALBEDO,
  GREENHOUSE_OFFSETS_K,
  PLANET_MASS_EARTH_RANGE,
  PLANET_RADIUS_EARTH_CLAMP
} from './constants';
import { clamp, expNormalNoise, logUniform, normal, pickFromProbTable } from './random';

export function drawMetallicityFeH(rng: RNG): number {
  return rng.range(-0.6, 0.3);
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

export function computeTemperatureK(teqK: number, atmosphere: AtmosphereType): number {
  const t = teqK + GREENHOUSE_OFFSETS_K[atmosphere];
  return clamp(t, 30, 2000);
}

export function pickPlanetAlbedo(planetType: PlanetType): number {
  return DEFAULT_PLANET_ALBEDO[planetType];
}

export function canHoldAtmosphere(massEarth: number, gravityG: number): boolean {
  return gravityG >= 0.25 && massEarth >= 0.08;
}

export function assignPlanetAtmosphere(
  rng: RNG,
  planetType: PlanetType,
  massEarth: number,
  gravityG: number,
  teqK: number,
  derived: StellarDerived
): { atmosphere: AtmosphereType; pressureBar?: number } {
  const canHold = canHoldAtmosphere(massEarth, gravityG);

  if (planetType === 'GasGiant' || planetType === 'IceGiant' || planetType === 'SubNeptune') {
    const pressureBar = rng.range(ATMOSPHERE_PRESSURE_BAR.H2He[0], ATMOSPHERE_PRESSURE_BAR.H2He[1]);
    return { atmosphere: 'H2He', pressureBar };
  }

  if (planetType === 'Dwarf') {
    if (canHold && teqK > 80) {
      const pressureBar = rng.range(ATMOSPHERE_PRESSURE_BAR.Thin[0], ATMOSPHERE_PRESSURE_BAR.Thin[1]);
      return { atmosphere: 'Thin', pressureBar };
    }
    return { atmosphere: 'None' };
  }

  // Terrestrial
  if (!canHold) return { atmosphere: 'None' };

  // Use the same simplified logic: use teq + Earth greenhouse as a proxy for surface.
  const proxySurface = teqK + GREENHOUSE_OFFSETS_K.Earthlike;

  const inHz = proxySurface >= 240 && proxySurface <= 320;
  const orbitInHz = derived.hzInnerAu <= derived.semiMajorAxisAu && derived.semiMajorAxisAu <= derived.hzOuterAu;

  if (inHz && orbitInHz) {
    if (rng.next() < 0.4) {
      const pressureBar = rng.range(ATMOSPHERE_PRESSURE_BAR.Earthlike[0], ATMOSPHERE_PRESSURE_BAR.Earthlike[1]);
      return { atmosphere: 'Earthlike', pressureBar };
    }
    const pressureBar = rng.range(ATMOSPHERE_PRESSURE_BAR.Thin[0], ATMOSPHERE_PRESSURE_BAR.Thin[1]);
    return { atmosphere: 'Thin', pressureBar };
  }

  if (teqK > 330) {
    if (rng.next() < 0.5) {
      const pressureBar = rng.range(ATMOSPHERE_PRESSURE_BAR.CO2[0], ATMOSPHERE_PRESSURE_BAR.CO2[1]);
      return { atmosphere: 'CO2', pressureBar };
    }
    const pressureBar = rng.range(ATMOSPHERE_PRESSURE_BAR.Thin[0], ATMOSPHERE_PRESSURE_BAR.Thin[1]);
    return { atmosphere: 'Thin', pressureBar };
  }

  const pressureBar = rng.range(ATMOSPHERE_PRESSURE_BAR.Thin[0], ATMOSPHERE_PRESSURE_BAR.Thin[1]);
  return { atmosphere: 'Thin', pressureBar };
}

export function deriveClimateTag(planetType: PlanetType, temperatureK: number, atmosphere: AtmosphereType): string | undefined {
  if (planetType === 'Terrestrial') {
    if (temperatureK < 180) return 'IceWorld';
    if (temperatureK < 240) return 'Cold';
    if (temperatureK <= 320 && atmosphere === 'Earthlike') return 'Eden';
    if (temperatureK <= 700) return 'Desertic';
    return 'Volcanic';
  }
  if (planetType === 'GasGiant' || planetType === 'IceGiant') {
    if (temperatureK > 800) return 'HotGiant';
    if (temperatureK > 250) return 'WarmGiant';
    return 'ColdGiant';
  }
  if (planetType === 'Dwarf') {
    return temperatureK < 170 ? 'IcyDwarf' : 'RockyDwarf';
  }
  return undefined;
}

export function drawPlanetTypes(
  rng: RNG,
  planetCount: number,
  primaryType: 'M' | 'K' | 'G' | 'F' | 'A' | 'B' | 'O',
  metallicityFeH: number
): PlanetTypePlan {
  if (planetCount <= 0) return [];

  const pGiant = (() => {
    if (primaryType === 'M') return clamp(0.03 * Math.exp(1.3 * metallicityFeH), 0.01, 0.10);
    if (primaryType === 'F' || primaryType === 'G' || primaryType === 'K') return clamp(0.06 * Math.exp(1.6 * metallicityFeH), 0.02, 0.20);
    return clamp(0.05 * Math.exp(1.5 * metallicityFeH), 0.02, 0.18);
  })();

  let giantCount = 0;
  if (rng.next() < pGiant) {
    giantCount = 1 + (rng.next() < 0.35 ? 1 : 0);
  }

  const innerSlots = Math.round(planetCount * 0.55);
  let outerSlots = planetCount - innerSlots;

  const innerProbs: PlanetTypeProbs = { Terrestrial: 0.65, SubNeptune: 0.30, Dwarf: 0.05, IceGiant: 0, GasGiant: 0 };
  const outerProbs: PlanetTypeProbs = { Dwarf: 0.45, IceGiant: 0.30, SubNeptune: 0.15, Terrestrial: 0.10, GasGiant: 0 };

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
    const giantType = rng.next() < 0.60 ? 'GasGiant' : 'IceGiant';
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
  const { atmosphere, pressureBar } = assignPlanetAtmosphere(rng, planetType, massEarth, gravityG, teqK, derived);
  const temperatureK = computeTemperatureK(teqK, atmosphere);

  const climateTag = deriveClimateTag(planetType, temperatureK, atmosphere);

  return {
    type: planetType,
    semiMajorAxisAu,
    eccentricity,
    massEarth,
    radiusEarth,
    gravityG,
    albedo,
    teqK,
    atmosphere,
    pressureBar,
    temperatureK,
    climateTag,
    moons: []
  };
}
