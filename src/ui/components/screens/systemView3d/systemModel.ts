import { MathUtils } from 'three';
import type {
  AtmosphereType,
  MoonData,
  MoonType,
  PlanetData,
  PlanetType,
  StarData,
  StarOrbit
} from '../../../../shared/shared';
import { hashStringToAngle, hashStringToUnit } from '../systemViewLayout';
import {
  DAYS_PER_YEAR,
  DEFAULT_ORBIT_INNER_KM,
  DEFAULT_ORBIT_STEP_KM,
  EARTH_RADIUS_KM,
  KM_PER_AU,
  MAX_MOON_ORBIT_INCLINATION_DEG,
  MAX_PLANET_ORBIT_INCLINATION_DEG,
  MIN_MOON_ORBIT_INCLINATION_DEG,
  MIN_PLANET_ORBIT_INCLINATION_DEG,
  RADIUS_VISIBILITY_BONUS,
  SPIN_SCALE_EXPONENT
} from './config';

export type OrbitingMoon = {
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

export type OrbitingPlanet = {
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

export type OrbitingStar = {
  id: string;
  data: StarData;
  radius: number;
  radiusKm: number;
  tintColor: string;
  surfaceTintColor: string;
  seedKey: string;
  position: [number, number, number];
};

export type PlanetSource = (PlanetData & {
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

export type MoonSource = MoonData & {
  radiusKm?: number;
  moonType?: MoonType;
  orbitDistanceKm?: number;
  habitabilityScore?: number;
  id?: string;
  name?: string;
  isSolid?: boolean;
  size?: number;
};

export const computeOrbitalPeriodDays = (semiMajorAxisAu: number, massSun: number): number => {
  const safeA = Math.max(semiMajorAxisAu, 0.01);
  const safeMass = Math.max(massSun, 0.1);
  const periodYears = Math.sqrt((safeA * safeA * safeA) / safeMass);
  return Math.max(periodYears * DAYS_PER_YEAR, 1);
};

export const computeOrbitAngle = (baseAngle: number, periodDays: number, day: number): number => {
  if (!Number.isFinite(periodDays) || periodDays <= 0) return baseAngle;
  return MathUtils.euclideanModulo(baseAngle + (day * Math.PI * 2) / periodDays, Math.PI * 2);
};

export const computeInclinedOrbitPosition = (
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

export const createFallbackStarOrbit = (seedKey: string, index: number, primaryMassSun: number): StarOrbit => {
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

export const getPlanetRadiusKm = (planet: PlanetSource): number => {
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

export const getPlanetType = (planet: PlanetSource): PlanetType => {
  if (planet.planetType) return planet.planetType;
  if ('type' in planet) return planet.type as PlanetType;
  const planetClass = 'class' in planet ? planet.class : undefined;
  if (planetClass === 'gas_giant') return 'GasGiant';
  if (planetClass === 'ice_giant') return 'IceGiant';
  return 'Terrestrial';
};

export const getSemiMajorAxisKm = (planet: PlanetSource, index: number): number => {
  if (typeof planet.semiMajorAxisKm === 'number') return planet.semiMajorAxisKm;
  const fallback = DEFAULT_ORBIT_INNER_KM + DEFAULT_ORBIT_STEP_KM * index;
  if (typeof (planet as PlanetData).semiMajorAxisAu === 'number') {
    return (planet as PlanetData).semiMajorAxisAu * KM_PER_AU;
  }
  return fallback;
};

export const getPlanetOrbitInclinationDeg = (planetId: string): number =>
  MathUtils.lerp(
    MIN_PLANET_ORBIT_INCLINATION_DEG,
    MAX_PLANET_ORBIT_INCLINATION_DEG,
    hashStringToUnit(`${planetId}-inclination`)
  );

export const getPlanetOrbitAscendingNodeDeg = (planetId: string): number =>
  hashStringToUnit(`${planetId}-node`) * 360;

export const getMoonOrbitInclinationDeg = (moonId: string): number =>
  MathUtils.lerp(
    MIN_MOON_ORBIT_INCLINATION_DEG,
    MAX_MOON_ORBIT_INCLINATION_DEG,
    hashStringToUnit(`${moonId}-inclination`)
  );

export const getMoonOrbitAscendingNodeDeg = (moonId: string): number =>
  hashStringToUnit(`${moonId}-node`) * 360;

export const getMoonRadiusKm = (moon: MoonSource): number => {
  if (typeof moon.radiusKm === 'number') {
    return Math.max(moon.radiusKm, 0.02);
  }
  if (typeof moon.radiusEarth === 'number') {
    return Math.max(moon.radiusEarth, 0.02) * EARTH_RADIUS_KM;
  }
  if (typeof moon.size === 'number') {
    return Math.max(moon.size, 0.02) * EARTH_RADIUS_KM;
  }
  return EARTH_RADIUS_KM * 0.18;
};

export const getMoonType = (moon: MoonSource): MoonType => moon.moonType ?? moon.type;

export const getMoonOrbitKm = (moon: MoonSource, planetRadiusKm: number): number => {
  if (typeof moon.orbitDistanceKm === 'number') return moon.orbitDistanceKm;
  if (typeof (moon as MoonData).orbitDistanceRp === 'number') {
    return (moon as MoonData).orbitDistanceRp * planetRadiusKm;
  }
  return planetRadiusKm * 4.5;
};

export const getSpinScaleFromRadius = (
  radius: number,
  referenceRadius: number,
  minScale: number,
  maxScale: number
): number => {
  const ratio = MathUtils.clamp(referenceRadius / Math.max(radius, 0.001), 0.1, 8);
  const eased = Math.pow(ratio, SPIN_SCALE_EXPONENT);
  return MathUtils.clamp(eased, minScale, maxScale);
};

export const getStarLightIntensityForRadius = (radius: number): number =>
  MathUtils.clamp(MathUtils.clamp(1.6 + radius * 0.65, 1.6, 5.2) * 12, 12, 75);

export const buildPlanetModel = (
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

export const applyPlanetOrbitSpacing = (
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

export const applyMoonOrbitSpacing = (
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
