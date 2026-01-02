import type { Biome, GameState, PlanetSurfaceDescriptor, SurfacePos } from '../../shared/types';
import { fnv1a32 } from './hash32';
import { generateSurfaceMapForState } from './access';

export const isInsideGrid = (pos: SurfacePos, descriptor: PlanetSurfaceDescriptor): boolean => {
  const { w, h } = descriptor.config;
  return pos.q >= 0 && pos.q < w && pos.r >= 0 && pos.r < h;
};

const isWaterBiome = (b: Biome): boolean => b === 'ocean' || b === 'coast' || b === 'lake';

export const isPassable = (biome: Biome): boolean => !isWaterBiome(biome);

export const isBuildable = (biome: Biome): boolean => (
  !isWaterBiome(biome) &&
  biome !== 'mountain' &&
  biome !== 'ice'
);

const axialDirs = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
] as const;

const wrapQ = (q: number, w: number, wrapX: boolean): number => {
  if (!wrapX) return q;
  const m = q % w;
  return m < 0 ? m + w : m;
};

const axialRing = (center: { q: number; r: number }, radius: number): Array<{ q: number; r: number }> => {
  if (radius <= 0) return [center];
  const results: Array<{ q: number; r: number }> = [];
  // Start at direction 4 * radius (south-west)
  let q = center.q + axialDirs[4].q * radius;
  let r = center.r + axialDirs[4].r * radius;
  for (let side = 0; side < 6; side += 1) {
    const d = axialDirs[side];
    for (let step = 0; step < radius; step += 1) {
      results.push({ q, r });
      q += d.q;
      r += d.r;
    }
  }
  return results;
};

export const relocateSurfacePosDeterministic = (params: {
  state: GameState;
  entityId: string;
  kind: 'army' | 'building';
  bodyId: string;
  origin: { q: number; r: number };
  predicate: (biome: Biome, q: number, r: number) => boolean;
  isOccupied?: (q: number, r: number) => boolean;
}): SurfacePos | null => {
  const { state, entityId, bodyId } = params;
  const descriptor = state.planetSurfaceDescriptorsByBodyId?.[bodyId];
  if (!descriptor) return null;
  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;

  const { w, h, wrapX } = descriptor.config;
  const inBounds = (q: number, r: number) => q >= 0 && q < w && r >= 0 && r < h;
  const occupied = params.isOccupied ?? (() => false);

  const maxRadius = w + h;
  for (let radius = 0; radius <= maxRadius; radius += 1) {
    const ring = axialRing(params.origin, radius);
    const candidates: Array<{ q: number; r: number; score: number }> = [];
    for (const c of ring) {
      const q = wrapQ(c.q, w, wrapX);
      const r = c.r;
      if (!inBounds(q, r)) continue;
      if (occupied(q, r)) continue;
      const biome = map.tiles[r * w + q].biome;
      if (!params.predicate(biome, q, r)) continue;
      const score = fnv1a32(`${entityId}|${bodyId}|${q}|${r}`) >>> 0;
      candidates.push({ q, r, score });
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => a.score - b.score);
    return { bodyId, q: candidates[0].q, r: candidates[0].r };
  }

  // Fallback: scan whole map
  let best: { q: number; r: number; score: number } | null = null;
  for (let r = 0; r < h; r += 1) {
    for (let q = 0; q < w; q += 1) {
      if (occupied(q, r)) continue;
      const biome = map.tiles[r * w + q].biome;
      if (!params.predicate(biome, q, r)) continue;
      const score = fnv1a32(`${entityId}|${bodyId}|${q}|${r}`) >>> 0;
      if (!best || score < best.score) best = { q, r, score };
    }
  }
  return best ? { bodyId, q: best.q, r: best.r } : null;
};

