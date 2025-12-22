import {
  FactionId,
  PlanetBody,
  PlanetBodyType,
  PlanetClass,
  PlanetData,
  StarSystem,
  StarSystemAstro
} from '../shared/types';

export interface PlanetBodySeed {
  id?: string;
  name?: string;
  bodyType?: PlanetBodyType;
  class?: PlanetClass;
  ownerFactionId?: FactionId | null;
  size?: number;
}

const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const MOON_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const formatPlanetIndex = (index: number): string => ROMAN_NUMERALS[index] ?? `${index + 1}`;

const formatMoonIndex = (index: number): string => MOON_LETTERS[index] ?? `${index + 1}`;

export const derivePlanetClass = (planetType: PlanetData['type']): PlanetClass => {
  if (planetType === 'GasGiant') return 'gas_giant';
  if (planetType === 'IceGiant') return 'ice_giant';
  return 'solid';
};

const buildPlanetName = (systemName: string, index: number): string => `${systemName} ${formatPlanetIndex(index)}`;

const buildMoonName = (planetName: string, index: number): string => `${planetName} ${formatMoonIndex(index)}`;

const ensureUniqueId = (baseId: string, used: Set<string>): string => {
  if (!used.has(baseId)) return baseId;
  let suffix = 2;
  while (used.has(`${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
};

const normalizeSeed = (
  seed: PlanetBodySeed,
  defaults: PlanetBody
): PlanetBody => {
  const bodyType = seed.bodyType ?? defaults.bodyType;
  const planetClass = seed.class ?? defaults.class;
  const ownerFactionId = seed.ownerFactionId ?? defaults.ownerFactionId ?? null;
  const size = typeof seed.size === 'number' && Number.isFinite(seed.size) ? seed.size : defaults.size;
  const name = seed.name ?? defaults.name;

  return {
    ...defaults,
    bodyType,
    class: planetClass,
    ownerFactionId,
    size,
    name,
    isSolid: planetClass === 'solid'
  };
};

export const buildPlanetBodies = (
  system: { id: string; name: string; ownerFactionId: FactionId | null },
  astro?: StarSystemAstro,
  overrides: PlanetBodySeed[] = []
): PlanetBody[] => {
  const usedIds = new Set<string>();
  const bodies: PlanetBody[] = [];

  const planets = astro?.planets ? [...astro.planets].sort((a, b) => a.semiMajorAxisAu - b.semiMajorAxisAu) : [];

  planets.forEach((planet, planetIndex) => {
    const planetId = `planet-${system.id}-${planetIndex + 1}`;
    const planetName = buildPlanetName(system.name, planetIndex);
    const planetClass = derivePlanetClass(planet.type);
    const ownerFactionId = system.ownerFactionId ?? null;
    const planetBody: PlanetBody = {
      id: planetId,
      systemId: system.id,
      name: planetName,
      bodyType: 'planet',
      class: planetClass,
      ownerFactionId,
      size: planet.radiusEarth,
      isSolid: planetClass === 'solid'
    };
    bodies.push(planetBody);
    usedIds.add(planetId);

    const moons = planet.moons ? [...planet.moons].sort((a, b) => a.orbitDistanceRp - b.orbitDistanceRp) : [];
    moons.forEach((moon, moonIndex) => {
      const moonId = `moon-${system.id}-${planetIndex + 1}-${moonIndex + 1}`;
      const moonName = buildMoonName(planetName, moonIndex);
      const moonBody: PlanetBody = {
        id: moonId,
        systemId: system.id,
        name: moonName,
        bodyType: 'moon',
        class: 'solid',
        ownerFactionId,
        size: moon.radiusEarth,
        isSolid: true
      };
      bodies.push(moonBody);
      usedIds.add(moonId);
    });
  });

  overrides.forEach((seed, index) => {
    const baseType: PlanetBodyType = seed.bodyType ?? 'planet';
    const baseId = seed.id ?? `${baseType}-${system.id}-custom-${index + 1}`;
    const resolvedId = ensureUniqueId(baseId, usedIds);

    const fallback: PlanetBody = {
      id: resolvedId,
      systemId: system.id,
      name: seed.name ?? `${system.name} ${baseType === 'moon' ? 'Moon' : 'Planet'} ${index + 1}`,
      bodyType: baseType,
      class: seed.class ?? 'solid',
      ownerFactionId: seed.ownerFactionId ?? system.ownerFactionId ?? null,
      size: typeof seed.size === 'number' && Number.isFinite(seed.size) ? seed.size : 1,
      isSolid: (seed.class ?? 'solid') === 'solid'
    };

    const existingIndex = bodies.findIndex(body => body.id === resolvedId);
    if (existingIndex >= 0) {
      bodies[existingIndex] = normalizeSeed(seed, bodies[existingIndex]);
    } else {
      bodies.push(normalizeSeed(seed, fallback));
      usedIds.add(resolvedId);
    }
  });

  if (!bodies.some(body => body.isSolid)) {
    const fallbackId = ensureUniqueId(`planet-${system.id}-fallback`, usedIds);
    bodies.push({
      id: fallbackId,
      systemId: system.id,
      name: `${system.name} Outpost`,
      bodyType: 'planet',
      class: 'solid',
      ownerFactionId: system.ownerFactionId ?? null,
      size: 1,
      isSolid: true
    });
  }

  return bodies;
};

export const normalizePlanetBodies = (
  system: { id: string; name: string; ownerFactionId: FactionId | null },
  rawPlanets: unknown,
  astro?: StarSystemAstro
): PlanetBody[] => {
  if (!Array.isArray(rawPlanets) || rawPlanets.length === 0) {
    return buildPlanetBodies(system, astro);
  }

  const normalized: PlanetBody[] = [];

  rawPlanets.forEach((entry, index) => {
    const item = entry as Partial<PlanetBody>;
    if (!item || typeof item !== 'object') return;
    if (typeof item.id !== 'string' || item.id.length === 0) return;

    const bodyType: PlanetBodyType = item.bodyType === 'moon' ? 'moon' : 'planet';
    const planetClass: PlanetClass =
      item.class === 'gas_giant' || item.class === 'ice_giant' ? item.class : 'solid';
    const size = typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 1;
    const name = typeof item.name === 'string' && item.name.length > 0
      ? item.name
      : `${system.name} ${bodyType === 'moon' ? 'Moon' : 'Planet'} ${index + 1}`;

    normalized.push({
      id: item.id,
      systemId: typeof item.systemId === 'string' && item.systemId.length > 0 ? item.systemId : system.id,
      name,
      bodyType,
      class: planetClass,
      ownerFactionId: item.ownerFactionId ?? null,
      size,
      isSolid: planetClass === 'solid'
    });
  });

  if (normalized.length === 0 || !normalized.some(body => body.isSolid)) {
    return buildPlanetBodies(system, astro);
  }

  return normalized;
};

export const getPlanetById = (systems: StarSystem[], planetId: string): { system: StarSystem; planet: PlanetBody } | null => {
  for (const system of systems) {
    const planet = system.planets.find(body => body.id === planetId);
    if (planet) return { system, planet };
  }
  return null;
};

export const getSystemByPlanetId = (systems: StarSystem[], planetId: string): StarSystem | null => {
  const match = getPlanetById(systems, planetId);
  return match ? match.system : null;
};

export const getSolidPlanets = (system: StarSystem): PlanetBody[] =>
  system.planets.filter(body => body.isSolid);

export const getDefaultSolidPlanet = (system: StarSystem): PlanetBody | null => {
  const solids = getSolidPlanets(system);
  if (solids.length === 0) return null;
  return [...solids].sort((a, b) => a.id.localeCompare(b.id))[0];
};
