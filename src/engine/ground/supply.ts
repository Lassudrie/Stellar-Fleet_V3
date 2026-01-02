import type { FactionId, GameState, GroundBuilding, HexCoord, PlanetSurfaceMap } from '../../shared/types';
import { generateSurfaceMapForState } from '../planetSurface/access';
import { neighborsAxial } from '../planetSurface/hex';
import { isPassable } from '../planetSurface/validation';

export const SUPPLY_RADIUS = 6;

const INF = 0xffff;

export const computeSupplyDistanceMapForBody = (
  state: GameState,
  bodyId: string,
  factionId: FactionId
): Uint16Array | null => {
  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;
  return computeSupplyDistanceMapFromSurfaceMap(map, state.groundBuildings ?? [], factionId);
};

export const computeSupplyDistanceMapFromSurfaceMap = (
  map: PlanetSurfaceMap,
  buildings: GroundBuilding[],
  factionId: FactionId
): Uint16Array => {
  const { w, h, wrapX } = map.descriptor.config;
  const size = w * h;
  const dist = new Uint16Array(size);
  dist.fill(INF);

  const queueQ = new Int16Array(size);
  const queueR = new Int16Array(size);
  let head = 0;
  let tail = 0;

  const enqueue = (coord: HexCoord, d: number) => {
    const idx = coord.r * w + coord.q;
    if (d >= INF) return;
    if (dist[idx] <= d) return;
    dist[idx] = d;
    queueQ[tail] = coord.q;
    queueR[tail] = coord.r;
    tail += 1;
  };

  // Supply sources: settlements controlled by faction + ground buildings controlled by faction
  map.settlements.forEach(s => {
    if (s.factionId !== factionId) return;
    const coord = s.coord;
    if (coord.q < 0 || coord.q >= w || coord.r < 0 || coord.r >= h) return;
    enqueue(coord, 0);
  });

  buildings.forEach(b => {
    if (b.factionId !== factionId) return;
    if (b.surfacePos.bodyId !== map.bodyId) return;
    const q = b.surfacePos.q;
    const r = b.surfacePos.r;
    if (q < 0 || q >= w || r < 0 || r >= h) return;
    enqueue({ q, r }, 0);
  });

  // If no sources, leave INF everywhere.
  while (head < tail) {
    const q = queueQ[head];
    const r = queueR[head];
    head += 1;
    const baseIdx = r * w + q;
    const baseDist = dist[baseIdx];
    const nextDist = (baseDist + 1) as number;
    if (nextDist >= INF) continue;

    const ns = neighborsAxial({ q, r }, w, h, wrapX);
    for (const n of ns) {
      const tile = map.tiles[n.r * w + n.q];
      if (!tile) continue;
      if (!isPassable(tile.biome)) continue;
      enqueue(n, nextDist);
    }
  }

  return dist;
};

export const isSupplied = (distanceMap: Uint16Array | null, coord: HexCoord, bodyMap: PlanetSurfaceMap, radius = SUPPLY_RADIUS): boolean => {
  if (!distanceMap) return false;
  const { w } = bodyMap.descriptor.config;
  const idx = coord.r * w + coord.q;
  const d = distanceMap[idx] ?? INF;
  return d <= radius;
};

