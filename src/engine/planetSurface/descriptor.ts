import type { PlanetBody, PlanetSurfaceConfig, PlanetSurfaceDescriptor } from '../../shared/types';
import { hashJoin32 } from './hash32';

export const DEFAULT_PLANET_SURFACE_GENERATOR_VERSION = 2;

const clampInt = (x: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(x)));

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const deriveSurfaceSeed = (params: {
  gameSeed: number;
  systemId: string;
  bodyId: string;
  generatorVersion: number;
}): number => {
  const { gameSeed, systemId, bodyId, generatorVersion } = params;
  return hashJoin32(gameSeed, systemId, bodyId, 'surface', `v${generatorVersion}`);
};

export const computeDefaultSurfaceConfig = (body: PlanetBody, generatorVersion = DEFAULT_PLANET_SURFACE_GENERATOR_VERSION): PlanetSurfaceConfig => {
  // size is radiusEarth for generated bodies, default to 1
  const size = typeof body.size === 'number' && Number.isFinite(body.size) ? Math.max(0.1, body.size) : 1;
  const w = clampInt(60 * Math.sqrt(size), 64, 128);
  const h = clampInt(w / 2, 32, 64);

  return {
    w,
    h,
    wrapX: true,
    generatorVersion
  };
};

export const parseAstroRefFromBodyId = (
  systemId: string,
  bodyId: string
): { planetIndex: number; moonIndex?: number } | undefined => {
  // Canonical IDs used by engine/planets.ts:
  // - planet-${systemId}-${planetIndex+1}
  // - moon-${systemId}-${planetIndex+1}-${moonIndex+1}
  const safeSystemId = escapeRegExp(systemId);

  const planetMatch = new RegExp(`^planet-${safeSystemId}-(\\d+)$`).exec(bodyId);
  if (planetMatch) {
    const planetIndex = Number(planetMatch[1]) - 1;
    if (Number.isFinite(planetIndex) && planetIndex >= 0) return { planetIndex };
    return undefined;
  }

  const moonMatch = new RegExp(`^moon-${safeSystemId}-(\\d+)-(\\d+)$`).exec(bodyId);
  if (moonMatch) {
    const planetIndex = Number(moonMatch[1]) - 1;
    const moonIndex = Number(moonMatch[2]) - 1;
    if (Number.isFinite(planetIndex) && planetIndex >= 0 && Number.isFinite(moonIndex) && moonIndex >= 0) {
      return { planetIndex, moonIndex };
    }
  }

  return undefined;
};

export const createPlanetSurfaceDescriptor = (params: {
  gameSeed: number;
  systemId: string;
  body: PlanetBody;
  generatorVersion?: number;
}): PlanetSurfaceDescriptor => {
  const generatorVersion = params.generatorVersion ?? DEFAULT_PLANET_SURFACE_GENERATOR_VERSION;
  const config = computeDefaultSurfaceConfig(params.body, generatorVersion);
  const seed = deriveSurfaceSeed({
    gameSeed: params.gameSeed,
    systemId: params.systemId,
    bodyId: params.body.id,
    generatorVersion
  });

  const astroRef = parseAstroRefFromBodyId(params.systemId, params.body.id);

  return {
    seed,
    config,
    // Contract requires an astroRef; fall back deterministically for custom bodies.
    astroRef: astroRef ?? { planetIndex: 0 }
  };
};

