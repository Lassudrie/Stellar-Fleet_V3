import { StarSystem, PlanetBody } from '../../shared/types';
import { getDefaultSolidPlanet, getPlanetById } from '../../engine/planets';

export interface SurfaceNavContext {
  system: StarSystem;
  body: PlanetBody;
}

interface ResolveSurfaceContextArgs {
  systems: StarSystem[];
  preferredSystemId?: string | null;
  bodyId?: string | null;
}

export const resolveSurfaceContext = ({
  systems,
  preferredSystemId,
  bodyId
}: ResolveSurfaceContextArgs): SurfaceNavContext | null => {
  if (bodyId) {
    const match = getPlanetById(systems, bodyId);
    if (match && match.planet.isSolid) {
      return { system: match.system, body: match.planet };
    }
  }

  if (preferredSystemId) {
    const system = systems.find(entry => entry.id === preferredSystemId);
    if (system) {
      const fallback = getDefaultSolidPlanet(system);
      if (fallback) return { system, body: fallback };
    }
  }

  for (const system of systems) {
    const fallback = getDefaultSolidPlanet(system);
    if (fallback) return { system, body: fallback };
  }

  return null;
};
