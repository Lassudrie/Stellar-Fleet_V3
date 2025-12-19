import { RNG } from '../../../engine/rng';
import { AtmosphereType, MoonData, MoonType, PlanetData, PlanetType } from '../../../types';
import {
  MOON_ALBEDO,
  MOON_GREENHOUSE_OFFSETS_K,
  MOON_MASS_BUDGET_FRACTION,
  MOON_RADIUS_EARTH_RANGE
} from './constants';
import { clamp, expNormalNoise, logUniform, randomUnitWeights } from './random';
import { computeFluxEarth, computeTeqK } from './planets';

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

export function drawMoonTypes(
  rng: RNG,
  planetType: PlanetType,
  regularCount: number,
  irregularCount: number
): MoonType[] {
  const moons: MoonType[] = [];

  const maybeEden = (): MoonType | null => (rng.next() < 0.02 ? 'Eden' : null);

  for (let k = 1; k <= regularCount; k++) {
    if (planetType === 'GasGiant' || planetType === 'IceGiant') {
      const roll = rng.next();
      let t: MoonType;
      if (k === 1) {
        t = roll < 0.35 ? 'Volcanic' : roll < 0.80 ? 'Regular' : 'Icy';
      } else if (k === 2) {
        t = roll < 0.20 ? 'Volcanic' : roll < 0.70 ? 'Regular' : 'Icy';
      } else {
        t = roll < 0.05 ? 'Volcanic' : roll < 0.50 ? 'Regular' : 'Icy';
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
      moons.push(roll < 0.70 ? 'Regular' : roll < 0.95 ? 'Icy' : 'Eden');
      continue;
    }

    if (planetType === 'SubNeptune') {
      const roll = rng.next();
      moons.push(roll < 0.60 ? 'Regular' : roll < 0.95 ? 'Icy' : 'Volcanic');
      continue;
    }

    // Dwarf
    moons.push(rng.next() < 0.80 ? 'Icy' : 'Regular');
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

export function allocateMoonMassesEarth(
  rng: RNG,
  planetType: PlanetType,
  planetMassEarth: number,
  regularCount: number
): number[] {
  if (regularCount <= 0) return [];

  const [fMin, fMax] = MOON_MASS_BUDGET_FRACTION[planetType];
  const fTotal = rng.range(fMin, fMax);
  const total = fTotal * planetMassEarth;
  if (total <= 0) return Array.from({ length: regularCount }, () => 0);

  const weights = randomUnitWeights(rng, regularCount);
  return weights.map(w => w * total);
}

export function computeMoonRadiusEarth(rng: RNG, massEarth: number): number {
  const r = Math.pow(Math.max(1e-12, massEarth), 0.30) * expNormalNoise(rng, 0.07);
  return clamp(r, MOON_RADIUS_EARTH_RANGE[0], MOON_RADIUS_EARTH_RANGE[1]);
}

export function computeGravityG(massEarth: number, radiusEarth: number): number {
  return massEarth / (radiusEarth * radiusEarth);
}

export function canHoldMoonAtmosphere(massEarth: number, gravityG: number): boolean {
  return massEarth >= 0.01 || gravityG >= 0.18;
}

export function assignMoonAtmosphere(
  rng: RNG,
  moonType: MoonType,
  canHold: boolean,
  temperatureK: number
): { atmosphere: Exclude<AtmosphereType, 'H2He'>; finalMoonType: MoonType } {
  if (moonType === 'Irregular') return { atmosphere: 'None', finalMoonType: moonType };

  if (moonType === 'Eden') {
    if (canHold && temperatureK >= 240 && temperatureK <= 320) {
      return { atmosphere: 'Earthlike', finalMoonType: 'Eden' };
    }
    return { atmosphere: 'Thin', finalMoonType: 'Regular' };
  }

  if (moonType === 'Volcanic') {
    if (canHold) return { atmosphere: 'CO2', finalMoonType: 'Volcanic' };
    return { atmosphere: 'Thin', finalMoonType: 'Regular' };
  }

  if (moonType === 'Icy') {
    return { atmosphere: canHold ? 'Thin' : 'None', finalMoonType: 'Icy' };
  }

  // Regular
  return { atmosphere: canHold ? 'Thin' : 'None', finalMoonType: 'Regular' };
}

export function tidalBonusK(rng: RNG, planetType: PlanetType, moonRank: number): number {
  if (planetType !== 'GasGiant' && planetType !== 'IceGiant') return 0;

  if (moonRank === 1) return rng.range(0, 120);
  if (moonRank === 2) return rng.range(0, 60);
  return rng.range(0, 20);
}

export function refineMoons(
  rng: RNG,
  planet: PlanetData,
  planetType: PlanetType,
  moonTypes: MoonType[],
  L_total: number
): MoonData[] {
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
    const gravityG = computeGravityG(massEarth, radiusEarth);

    const albedo = MOON_ALBEDO[t0];
    const teqK = computeTeqK(flux, albedo);

    const tidal = isRegular ? tidalBonusK(rng, planetType, rank) : 0;
    const provisionalT = clamp(teqK + tidal, 30, 2000);

    const canHold = canHoldMoonAtmosphere(massEarth, gravityG);
    const { atmosphere, finalMoonType } = assignMoonAtmosphere(rng, t0, canHold, provisionalT);
    const temperatureK = clamp(provisionalT + MOON_GREENHOUSE_OFFSETS_K[atmosphere], 30, 2000);

    out.push({
      type: finalMoonType,
      orbitDistanceRp,
      massEarth,
      radiusEarth,
      gravityG,
      albedo,
      teqK,
      tidalBonusK: tidal,
      atmosphere,
      temperatureK
    });
  }

  return out;
}
