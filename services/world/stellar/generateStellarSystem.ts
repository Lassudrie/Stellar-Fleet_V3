import { RNG } from '../../../engine/rng';
import {
  PlanetType,
  StarSystemAstro,
  StellarSystemGenParams,
  StellarSystemPlan
} from '../../../types';
import {
  DEFAULT_STELLAR_SYSTEM_GEN_PARAMS,
  PLANET_COUNT_LAMBDA_BY_PRIMARY,
  SPECTRAL_WEIGHTS,
  STELLAR_CLASS_BOUNDS
} from './constants';
import { deriveSeed32, poisson, weightedPick } from './random';
import { drawCompanionMasses, drawStarCount, refineStar, typeFromMassSun } from './stars';
import {
  buildPlanet,
  computeHzAu,
  computeSnowLineAu,
  drawMetallicityFeH,
  drawPlanetTypes,
  enforceOrbitCaps,
  generateRelativeOrbitRadii,
  scaleOrbitsToSnowLine,
  snapOrbitToType,
  drawEccentricity
} from './planets';
import { drawIrregularMoonCount, drawMoonTypes, drawRegularMoonCount, refineMoons } from './moons';

export interface GenerateStellarSystemInput {
  worldSeed: number;
  systemId: string;
  params?: Partial<StellarSystemGenParams>;
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

  // Phase A: discrete plan
  const primarySpectralType = weightedPick(
    rng,
    SPECTRAL_WEIGHTS.map(x => ({ key: x.type, weight: x.weight }))
  );

  const primaryMassRange = STELLAR_CLASS_BOUNDS[primarySpectralType].massSun;
  const primaryMassSun = rng.range(primaryMassRange[0], primaryMassRange[1]);

  const starCount = drawStarCount(rng, primarySpectralType);
  const companionCount = Math.max(0, starCount - 1);
  const companionMasses = drawCompanionMasses(rng, primaryMassSun, companionCount);

  const metallicityFeH = drawMetallicityFeH(rng);

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
  const stars = [];
  stars.push(refineStar(rng, primarySpectralType, primaryMassSun, 'primary'));

  for (const m of companionMasses) {
    const t = typeFromMassSun(m);
    stars.push(refineStar(rng, t, m, 'companion'));
  }

  const luminosityTotalLSun = stars.reduce((sum, s) => sum + s.luminositySun, 0);
  const snowLineAu = computeSnowLineAu(luminosityTotalLSun);
  const { hzInnerAu, hzOuterAu } = computeHzAu(luminosityTotalLSun);

  // Orbits
  const relativeR = generateRelativeOrbitRadii(rng, planetCount, params);
  let semiMajorAxes = scaleOrbitsToSnowLine(rng, relativeR, planetCount, params, snowLineAu);
  semiMajorAxes = enforceOrbitCaps(semiMajorAxes, params);

  const planets = [];
  for (let i = 0; i < planetCount; i++) {
    const originalType = planetTypes[i] as PlanetType;
    const rawA = semiMajorAxes[i];
    const snapped = snapOrbitToType(rng, rawA, originalType, snowLineAu, params);

    const e = drawEccentricity(rng, snapped.planetType);

    const planet = buildPlanet(
      rng,
      snapped.planetType,
      snapped.aAu,
      e,
      luminosityTotalLSun,
      hzInnerAu,
      hzOuterAu
    );

    planet.moons = refineMoons(rng, planet, snapped.planetType, moonsPlan[i] || [], luminosityTotalLSun);
    planets.push(planet);
  }

  return {
    seed,
    primarySpectralType,
    starCount,
    metallicityFeH,
    derived: {
      luminosityTotalLSun,
      snowLineAu,
      hzInnerAu,
      hzOuterAu
    },
    stars,
    planets
  };
}
