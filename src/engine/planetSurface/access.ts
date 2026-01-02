import type { GameState, MoonData, PlanetData, PlanetSurfaceDescriptor, PlanetSurfaceMap, PlanetSurfaceTile } from '../../shared/types';
import { getPlanetById } from '../planets';
import { generateSurfaceMap } from './generateSurfaceMap';

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

export const generateSurfaceMapForState = (
  state: GameState,
  bodyId: string
): PlanetSurfaceMap | null => {
  const descriptor = getSurfaceDescriptor(state, bodyId);
  if (!descriptor) return null;
  const astro = getAstroForBody(state, bodyId, descriptor);
  if (!astro) return null;

  return generateSurfaceMap({
    systemId: astro.systemId,
    bodyId,
    descriptor,
    planetData: astro.planetData,
    moonData: astro.moonData,
    ownerFactionId: astro.ownerFactionId
  });
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

