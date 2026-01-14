import { GROUND_UNIT_STATS } from '../content/data/groundUnits';
import type {
  Army,
  Biome,
  FactionId,
  GameState,
  GroundBuilding,
  GroundUnitType,
  PlanetSurfaceMap,
  SettlementControlState,
  SurfacePos
} from '../shared/shared';
import { FeatureBits, sorted } from '../shared/shared';
import { RNG } from './rng';
import {
  generateSurfaceMapForState,
  getSurfaceTileCoordFromId,
  getSurfaceTileDir,
  getSurfaceTileNeighbors,
  hashJoin32,
  isPassable,
  resolveSurfaceTileId
} from './planetSurface';

// ----------------------------
// Utils (was: ground/utils.ts)
// ----------------------------

type TileId = number;

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const tileKey = (tileId: TileId): string => `${tileId}`;

// Wrap-safe modulo for wrapX maps.
const mod = (n: number, m: number): number => {
  if (m === 0) return 0;
  return ((n % m) + m) % m;
};

/**
 * Normalizes a coordinate for a map with optional wrapX. Returns null if out-of-bounds on r,
 * or on q when wrapX is false.
 */
const axialToCube = (coord: { q: number; r: number }): { x: number; y: number; z: number } => {
  const x = coord.q;
  const z = coord.r;
  const y = -x - z;
  return { x, y, z };
};

const cubeToAxial = (cube: { x: number; y: number; z: number }): { q: number; r: number } => ({ q: cube.x, r: cube.z });

const cubeRound = (cube: { x: number; y: number; z: number }): { x: number; y: number; z: number } => {
  let rx = Math.round(cube.x);
  let ry = Math.round(cube.y);
  let rz = Math.round(cube.z);

  const dx = Math.abs(rx - cube.x);
  const dy = Math.abs(ry - cube.y);
  const dz = Math.abs(rz - cube.z);

  if (dx > dy && dx > dz) {
    rx = -ry - rz;
  } else if (dy > dz) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { x: rx, y: ry, z: rz };
};

const cubeLerp = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t
});

const hexDistance = (a: { q: number; r: number }, b: { q: number; r: number }, w: number, wrapX: boolean): number => {
  const dqRaw = b.q - a.q;
  const dq = wrapX && w > 0
    ? (() => {
        const modded = mod(dqRaw, w);
        const alt = modded > w / 2 ? modded - w : modded;
        return alt;
      })()
    : dqRaw;
  const dr = b.r - a.r;
  const ds = -dq - dr;
  return Math.floor((Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2);
};

const adjustTargetForWrap = (from: { q: number; r: number }, to: { q: number; r: number }, w: number, wrapX: boolean): { q: number; r: number } => {
  if (!wrapX || w <= 0) return to;
  const dqRaw = to.q - from.q;
  const modded = mod(dqRaw, w);
  const alt = modded > w / 2 ? modded - w : modded;
  return { q: from.q + alt, r: to.r };
};

export const lineOfSight = (params: {
  fromTileId: TileId;
  toTileId: TileId;
  map: PlanetSurfaceMap;
  isBlocked: (tileId: TileId) => boolean;
}): boolean => {
  const { fromTileId, toTileId, map, isBlocked } = params;
  if (fromTileId === toTileId) return true;

  const fromCoord = getSurfaceTileCoordFromId(map.descriptor, fromTileId);
  const toCoord = getSurfaceTileCoordFromId(map.descriptor, toTileId);

  if (fromCoord && toCoord && 'w' in map.descriptor.config) {
    const { w, wrapX } = map.descriptor.config;
    const toUnwrapped = adjustTargetForWrap(fromCoord, toCoord, w, wrapX ?? false);
    const a = axialToCube(fromCoord);
    const b = axialToCube(toUnwrapped);
    const dist = hexDistance(fromCoord, toUnwrapped, w, false);
    if (dist <= 1) return true;

    for (let i = 1; i < dist; i += 1) {
      const t = dist === 0 ? 0 : i / dist;
      const cube = cubeRound(cubeLerp(a, b, t));
      const axial = cubeToAxial(cube);
      const tileId = resolveSurfaceTileId(map.descriptor, { bodyId: map.bodyId, q: axial.q, r: axial.r });
      if (tileId === null) return false;
      if (isBlocked(tileId)) return false;
    }
    return true;
  }

  const targetDir = getSurfaceTileDir(map.descriptor, toTileId);
  if (!targetDir) return false;
  let current = fromTileId;
  const visited = new Set<TileId>();

  for (let step = 0; step < 128; step += 1) {
    if (current === toTileId) return true;
    visited.add(current);
    const ns = getSurfaceTileNeighbors(map.descriptor, current);
    let best = -1;
    let bestDot = -Infinity;
    for (const next of ns) {
      if (visited.has(next)) continue;
      const dir = getSurfaceTileDir(map.descriptor, next);
      if (!dir) continue;
      const dot = dir.x * targetDir.x + dir.y * targetDir.y + dir.z * targetDir.z;
      if (dot > bestDot) {
        bestDot = dot;
        best = next;
      }
    }
    if (best < 0) return false;
    if (isBlocked(best)) return false;
    current = best;
  }
  return false;
};

export const tileDistance = (map: PlanetSurfaceMap, fromTileId: TileId, toTileId: TileId): number => {
  if (fromTileId === toTileId) return 0;
  const fromCoord = getSurfaceTileCoordFromId(map.descriptor, fromTileId);
  const toCoord = getSurfaceTileCoordFromId(map.descriptor, toTileId);
  if (fromCoord && toCoord && 'w' in map.descriptor.config) {
    const { w, wrapX } = map.descriptor.config;
    return hexDistance(fromCoord, toCoord, w, wrapX ?? false);
  }

  const tileCount = map.tiles.length;
  if (fromTileId < 0 || toTileId < 0 || fromTileId >= tileCount || toTileId >= tileCount) {
    return Number.POSITIVE_INFINITY;
  }

  const dist = new Int16Array(tileCount);
  dist.fill(-1);
  const queue = new Int32Array(tileCount);
  let head = 0;
  let tail = 0;
  dist[fromTileId] = 0;
  queue[tail++] = fromTileId;

  while (head < tail) {
    const cur = queue[head++];
    const d = dist[cur];
    if (cur === toTileId) return d;
    const ns = getSurfaceTileNeighbors(map.descriptor, cur);
    for (const next of ns) {
      if (next < 0 || next >= tileCount) continue;
      if (dist[next] !== -1) continue;
      dist[next] = d + 1;
      queue[tail++] = next;
    }
  }

  return Number.POSITIVE_INFINITY;
};

// -----------------------------
// Random (was: ground/random.ts)
// -----------------------------

export const rollTriangularCentered = (rng: RNG, epsilon: number): number => {
  const u1 = rng.next();
  const u2 = rng.next();
  const t = u1 + u2 - 1; // [-1, 1]
  return 1 + t * epsilon;
};

// --------------------------------
// Terrain (was: ground/terrain.ts)
// --------------------------------

export type TerrainType = 'Open' | 'Forest' | 'Hills' | 'Mountains' | 'Urban' | 'Swamp' | 'Desert' | 'Coastal';

// --- Normative tables (Ground Surface Combat V1) ---
// NOTE: Values here are the source of truth for engine behavior and tests.
// If you change them, update docs/specs/ground-surface-combat-v1.md and tests.

export const K_TERRAIN_BASE: Record<TerrainType, number> = {
  Open: 1.0,
  Forest: 0.9,
  Hills: 0.95,
  Mountains: 0.85,
  Urban: 0.9,
  Swamp: 0.8,
  Desert: 0.9,
  Coastal: 1.0
};

export const MOVE_COST: Record<TerrainType, number> = {
  Open: 1,
  Forest: 2,
  Hills: 2,
  Mountains: 3,
  Urban: 2,
  Swamp: 3,
  Desert: 2,
  Coastal: 2
};

// -------------------------
// Ground V2 constants
// -------------------------

export const STACKING_PENALTY_PER_EXTRA = 0.10;
export const STACKING_FREE_SLOTS = 2;
export const STACKING_CAP = 10;
export const MAX_UNITS_PER_SIDE = 100;

export const SUPPLY_RADIUS = 6;
export const SUPPLY_FACTOR_SUPPLIED = 1.0;
export const SUPPLY_FACTOR_UNSUPPLIED = 0.7;
export const SUPPLY_PENALTY_ATK = 0.20;
export const SUPPLY_PENALTY_DEF = 0.20;

export const RNG_EPSILON = 0.08;
export const ENGAGEMENT_LETHALITY = 0.35;
export const ENGAGEMENT_LOSS_CAP = 0.35;
export const CONDITION_LOSS_COEFF = 0.60;
export const MORALE_LOSS_COEFF = 0.60;
export const BREAK_THRESHOLD = 0.25;
export const RALLY_THRESHOLD = 0.40;
export const ROUTED_ATK_MULT = 0.70;
export const ROUTED_DEF_MULT = 0.70;
export const ROUTED_MP_MULT = 0.50;
export const FRONT_ASSAULT_MULT = 0.85;
export const FATIGUE_MOVE_PER_HEX = 0.02;
export const FATIGUE_COMBAT_ADD = 0.10;
export const FATIGUE_RECOVERY = 0.15;
export const FATIGUE_FACTOR_MIN = 0.50;
export const MORALE_RECOVERY = 0.20;
export const CONDITION_RECOVERY = 0.05;
export const POST_BATTLE_MORALE_CAP = 0.35;
export const POST_BATTLE_FATIGUE_ADD = 0.15;
export const PREPARED_DEFENSE_MULT = 1.2;
export const LANDING_BASE = 0.10;
export const LANDING_VAR = 0.15;
export const LANDING_MAX = 0.60;
export const ORBIT_CONTESTED_LANDING_PENALTY = 0.10;
export const BOMBARD_LANDING_PENALTY = 0.05;
export const AO_COEFF = 0.15;
export const AO_LANDING_COEFF = 0.05;
export const AO_LANDING_MAX = 0.15;

export const BOMBARD_COMBAT_MULT = 0.9;
export const BOMBARD_COMBAT_CONDITION_LOSS = 0.05;

export const deriveRoutedAfterMorale = (army: Army, morale: number): boolean => {
  const moraleClamped = clamp(morale, 0, 1);
  const wasRouted = army.routed === true || army.morale < BREAK_THRESHOLD;
  return wasRouted ? moraleClamped < RALLY_THRESHOLD : moraleClamped < BREAK_THRESHOLD;
};

export const isRouted = (army: Army): boolean => army.routed === true || army.morale < BREAK_THRESHOLD;

export const isPreparedDefenseActive = (army: Army, turn?: number): boolean => {
  if (army.posture !== 'prepared_defense') return false;
  const postureSetTurn = army.postureSetTurn;
  if (typeof postureSetTurn !== 'number' || !Number.isFinite(postureSetTurn)) return true;
  if (typeof turn !== 'number' || !Number.isFinite(turn)) return true;
  return turn > postureSetTurn;
};

export const computeStackingFactor = (index: number): number => {
  if (index < STACKING_FREE_SLOTS) return 1;
  const penalty = STACKING_PENALTY_PER_EXTRA * (index - (STACKING_FREE_SLOTS - 1));
  return Math.max(0, 1 - penalty);
};

export const computeStackingFactors = (occupancy: Map<string, string[]>): Map<string, number> => {
  const factors = new Map<string, number>();
  occupancy.forEach(ids => {
    const ordered = sorted(ids, (a, b) => a.localeCompare(b));
    ordered.forEach((id, index) => {
      factors.set(id, computeStackingFactor(index));
    });
  });
  return factors;
};

export const biomeToTerrainType = (biome: Biome): TerrainType => {
  switch (biome) {
    case 'desert':
    case 'ash_desert':
    case 'vitrified':
    case 'oxidized':
    case 'fossil_basin':
      return 'Desert';
    case 'coast':
      return 'Coastal';
    case 'forest':
    case 'rainforest':
    case 'taiga':
      return 'Forest';
    case 'mountain':
    case 'volcanic':
    case 'lava_flats':
      return 'Mountains';
    case 'rocky':
    case 'cratered':
    case 'fractured_ice':
    case 'cryovolcanic':
    case 'thermal_polygons':
    case 'chemical_erosion':
      return 'Hills';
    case 'grassland':
    case 'tundra':
    case 'ice':
    case 'dusty_ice':
    case 'compressed_plateau':
      return 'Open';
    case 'lake':
      return 'Coastal';
    case 'ocean':
      return 'Coastal'; // Ocean is impassable; TerrainType used only for display/affinity.
    default:
      return 'Open';
  }
};

export const deriveTerrainTypeFromSurfaceMap = (map: PlanetSurfaceMap, buildings: GroundBuilding[], tileId: TileId): TerrainType => {
  if (!Number.isFinite(tileId)) return 'Open';
  const idx = Math.floor(tileId);
  if (idx < 0 || idx >= map.tiles.length) return 'Open';

  const hasBuilding = buildings.some(b => b.surfacePos.bodyId === map.bodyId && resolveSurfaceTileId(map.descriptor, b.surfacePos) === idx);
  if (hasBuilding) return 'Urban';

  const hasSettlement = map.settlements.some(s => s.tileId === idx);
  if (hasSettlement) return 'Urban';

  const tile = map.tiles[idx];
  if (!tile) return 'Open';
  return biomeToTerrainType(tile.biome);
};

export const deriveTerrainType = (state: GameState, bodyId: string, tileId: TileId): TerrainType => {
  const buildings = state.groundBuildings ?? [];
  const surfaceMap = generateSurfaceMapForState(state, bodyId);
  if (surfaceMap) return deriveTerrainTypeFromSurfaceMap(surfaceMap, buildings, tileId);

  const hasBuilding = buildings.some(b => b.surfacePos.bodyId === bodyId && b.surfacePos.tileId === tileId);
  return hasBuilding ? 'Urban' : 'Open';
};

export const isUrbanHex = (map: PlanetSurfaceMap, buildings: GroundBuilding[], tileId: TileId): boolean => {
  if (!Number.isFinite(tileId)) return false;
  const idx = Math.floor(tileId);
  if (idx < 0 || idx >= map.tiles.length) return false;
  if (buildings.some(b => b.surfacePos.bodyId === map.bodyId && resolveSurfaceTileId(map.descriptor, b.surfacePos) === idx)) return true;
  return map.settlements.some(s => s.tileId === idx);
};

export const coverFactorForBiome = (biome: Biome): number => {
  switch (biome) {
    case 'desert':
    case 'ash_desert':
    case 'vitrified':
    case 'oxidized':
    case 'fossil_basin':
    case 'rocky':
    case 'cratered':
      return 1.0;
    case 'grassland':
    case 'coast':
    case 'lake':
    case 'dusty_ice':
    case 'compressed_plateau':
      return 1.05;
    case 'tundra':
    case 'taiga':
    case 'fractured_ice':
    case 'thermal_polygons':
    case 'chemical_erosion':
      return 1.1;
    case 'forest':
      return 1.15;
    case 'rainforest':
      return 1.2;
    case 'mountain':
    case 'volcanic':
    case 'lava_flats':
      return 1.25;
    default:
      return 1.05;
  }
};

export const isLosBlockingBiome = (biome: Biome): boolean => {
  switch (biome) {
    case 'mountain':
    case 'volcanic':
    case 'lava_flats':
      return true;
    default:
      return false;
  }
};

// -----------------------
// ZOC (was: ground/zoc.ts)
// -----------------------

export interface ZocSnapshot {
  bodyId: string;
  tileCount: number;
  zocByFactionId: Map<FactionId, Uint8Array>;
}

const forEachTileInRange = (
  centerTileId: TileId,
  range: number,
  map: PlanetSurfaceMap,
  cb: (tileId: TileId) => void
) => {
  if (range < 0) return;
  const tileCount = map.tiles.length;
  if (centerTileId < 0 || centerTileId >= tileCount) return;
  const visited = new Int16Array(tileCount);
  visited.fill(-1);
  const queue = new Int32Array(tileCount);
  let head = 0;
  let tail = 0;
  visited[centerTileId] = 0;
  queue[tail++] = centerTileId;

  while (head < tail) {
    const tileId = queue[head++];
    const dist = visited[tileId];
    if (dist > range) continue;
    cb(tileId);
    if (dist === range) continue;
    const ns = getSurfaceTileNeighbors(map.descriptor, tileId);
    for (const next of ns) {
      if (next < 0 || next >= tileCount) continue;
      if (visited[next] !== -1) continue;
      visited[next] = dist + 1;
      queue[tail++] = next;
    }
  }
};

export const computeZocSnapshotFromArmies = (params: {
  bodyId: string;
  map: PlanetSurfaceMap;
  armies: Army[];
}): ZocSnapshot => {
  const { bodyId, map, armies } = params;
  const size = map.tiles.length;
  const zocByFactionId = new Map<FactionId, Uint8Array>();

  const getArr = (factionId: FactionId): Uint8Array => {
    const existing = zocByFactionId.get(factionId);
    if (existing) return existing;
    const arr = new Uint8Array(size);
    zocByFactionId.set(factionId, arr);
    return arr;
  };

  for (const army of armies) {
    if (army.state !== 'DEPLOYED') continue;
    if (army.containerId !== bodyId) continue;
    if (!army.surfacePos) continue;
    if (army.members <= 0) continue;
    if (isRouted(army)) continue;
    const tileId = resolveSurfaceTileId(map.descriptor, army.surfacePos);
    if (tileId === null) continue;
    const arr = getArr(army.factionId);
    forEachTileInRange(tileId, Math.max(0, Math.floor(army.projectionRange)), map, idx => {
      arr[idx] = 1;
    });
  }

  return { bodyId, tileCount: size, zocByFactionId };
};

export const isInEnemyZoc = (snapshot: ZocSnapshot, tileId: TileId, ownFactionId: FactionId): boolean => {
  if (!Number.isFinite(tileId)) return false;
  const idx = Math.floor(tileId);
  if (idx < 0 || idx >= snapshot.tileCount) return false;
  for (const [factionId, arr] of snapshot.zocByFactionId.entries()) {
    if (factionId === ownFactionId) continue;
    if (arr[idx]) return true;
  }
  return false;
};

// ---------------------------
// Supply (was: ground/supply.ts)
// ---------------------------

const INF = 0xffff;

export const computeSupplyDistanceMapFromSurfaceMap = (
  map: PlanetSurfaceMap,
  buildings: GroundBuilding[],
  settlementControl: Record<string, SettlementControlState> | undefined,
  factionId: FactionId
): Uint16Array => {
  const size = map.tiles.length;
  const dist = new Uint16Array(size);
  dist.fill(INF);

  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  const enqueue = (tileId: number, d: number) => {
    if (tileId < 0 || tileId >= size) return;
    if (d >= INF) return;
    if (dist[tileId] <= d) return;
    dist[tileId] = d;
    queue[tail] = tileId;
    tail += 1;
  };

  // Supply sources: settlements controlled by faction + ground buildings controlled by faction
  for (const s of map.settlements) {
    const control = settlementControl?.[s.id];
    const controller = control?.factionId ?? s.factionId ?? null;
    if (controller !== factionId) continue;
    enqueue(s.tileId, 0);
  }

  for (const b of buildings) {
    if (b.factionId !== factionId) continue;
    if (b.surfacePos.bodyId !== map.bodyId) continue;
    if (b.tags && !b.tags.includes('supply_node')) continue;
    const tileId = resolveSurfaceTileId(map.descriptor, b.surfacePos);
    if (tileId === null) continue;
    enqueue(tileId, 0);
  }

  // If no sources, leave INF everywhere.
  while (head < tail) {
    const baseTileId = queue[head++];
    const baseDist = dist[baseTileId];
    const nextDist = baseDist + 1;
    if (nextDist >= INF) continue;

    const ns = getSurfaceTileNeighbors(map.descriptor, baseTileId);
    for (const n of ns) {
      const tile = map.tiles[n];
      if (!tile) continue;
      if (!isPassable(tile.biome)) continue;
      enqueue(n, nextDist);
    }
  }

  return dist;
};

export const isSupplied = (distanceMap: Uint16Array | null, tileId: TileId, bodyMap: PlanetSurfaceMap, radius = SUPPLY_RADIUS): boolean => {
  if (!distanceMap) return false;
  if (!Number.isFinite(tileId)) return false;
  const idx = Math.floor(tileId);
  if (idx < 0 || idx >= bodyMap.tiles.length) return false;
  const d = distanceMap[idx];
  return d !== INF && d <= radius;
};

// --------------------------------
// Pathfinding (was: ground/pathfinding.ts)
// --------------------------------

type Node = { tileId: TileId; cost: number };

class MinHeap {
  private heap: Node[] = [];

  push(node: Node) {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): Node | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  get size() {
    return this.heap.length;
  }

  private bubbleUp(i: number) {
    let idx = i;
    while (idx > 0) {
      const p = (idx - 1) >> 1;
      if (this.less(this.heap[p], this.heap[idx])) break;
      [this.heap[p], this.heap[idx]] = [this.heap[idx], this.heap[p]];
      idx = p;
    }
  }

  private bubbleDown(i: number) {
    const n = this.heap.length;
    let idx = i;
    let moved = true;
    while (moved) {
      moved = false;
      const l = idx * 2 + 1;
      const r = l + 1;
      let best = idx;
      if (l < n && !this.less(this.heap[best], this.heap[l])) best = l;
      if (r < n && !this.less(this.heap[best], this.heap[r])) best = r;
      if (best !== idx) {
        [this.heap[best], this.heap[idx]] = [this.heap[idx], this.heap[best]];
        idx = best;
        moved = true;
      }
    }
  }

  private less(a: Node, b: Node): boolean {
    // Tie-break for determinism: cost, then tileId.
    if (a.cost !== b.cost) return a.cost < b.cost;
    return a.tileId < b.tileId;
  }
}

export interface FindPathParams {
  map: PlanetSurfaceMap;
  fromTileId: TileId;
  toTileId: TileId;
  isBlocked: (tileId: TileId) => boolean;
  stepCostCenti: (from: TileId, to: TileId) => number; // includes ZOC modifiers etc.
}

export interface PathResult {
  path: TileId[]; // includes start and end
  costCenti: number;
}

export interface ReachableParams {
  map: PlanetSurfaceMap;
  fromTileId: TileId;
  isBlocked: (tileId: TileId) => boolean;
  stepCostCenti: (from: TileId, to: TileId) => number;
  maxCostCenti: number;
  canExpand?: (tileId: TileId) => boolean;
}

export const computeReachable = (params: ReachableParams): Map<TileId, number> => {
  const { map, fromTileId, isBlocked, stepCostCenti, maxCostCenti, canExpand } = params;
  const dist = new Map<TileId, number>();
  dist.set(fromTileId, 0);

  const heap = new MinHeap();
  heap.push({ tileId: fromTileId, cost: 0 });

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const curTileId = cur.tileId;
    const best = dist.get(curTileId);
    if (best === undefined || cur.cost !== best) continue;
    if (cur.cost > maxCostCenti) continue;

    if (canExpand && !canExpand(curTileId)) continue;

    const ns = getSurfaceTileNeighbors(map.descriptor, curTileId);
    for (const n of ns) {
      if (n !== fromTileId && isBlocked(n)) continue;
      const step = stepCostCenti(curTileId, n);
      if (!Number.isFinite(step) || step <= 0) continue;
      const nextCost = cur.cost + step;
      if (nextCost > maxCostCenti) continue;
      const known = dist.get(n);
      if (known === undefined || nextCost < known) {
        dist.set(n, nextCost);
        heap.push({ tileId: n, cost: nextCost });
      }
    }
  }

  return dist;
};

export const findPathWithCost = (params: FindPathParams): PathResult | null => {
  const { map, fromTileId, toTileId, isBlocked, stepCostCenti } = params;
  if (fromTileId === toTileId) return { path: [fromTileId], costCenti: 0 };

  const dist = new Map<TileId, number>();
  const prev = new Map<TileId, TileId>();
  dist.set(fromTileId, 0);

  const heap = new MinHeap();
  heap.push({ tileId: fromTileId, cost: 0 });

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const curTileId = cur.tileId;
    const best = dist.get(curTileId);
    if (best === undefined || cur.cost !== best) continue;
    if (curTileId === toTileId) break;

    const ns = getSurfaceTileNeighbors(map.descriptor, curTileId);
    for (const n of ns) {
      if (n !== toTileId && isBlocked(n)) continue;
      const step = stepCostCenti(curTileId, n);
      if (!Number.isFinite(step) || step <= 0) continue;
      const nextCost = cur.cost + step;
      const known = dist.get(n);
      if (known === undefined || nextCost < known) {
        dist.set(n, nextCost);
        prev.set(n, curTileId);
        heap.push({ tileId: n, cost: nextCost });
      }
    }
  }

  const total = dist.get(toTileId);
  if (total === undefined) return null;

  // Reconstruct
  const path: TileId[] = [];
  let cur: TileId = toTileId;
  path.push(cur);
  while (cur !== fromTileId) {
    const p = prev.get(cur);
    if (p === undefined) break;
    cur = p;
    path.push(cur);
  }
  path.reverse();

  // Ensure start present
  if (path.length === 0 || path[0] !== fromTileId) {
    return null;
  }

  return { path, costCenti: total };
};

// --------------------------------
// K model (was: ground/k.ts)
// --------------------------------

export interface SituationFlags {
  preparedDefense?: boolean;
  encirclement?: boolean;
  spent75pctMp?: boolean;
  amphibiousOrAirborneAssault?: boolean;
}

export interface StatusFlags {
  outOfSupply?: boolean;
  fatigueExtreme?: boolean;
  moraleCritical?: boolean;
}

export interface KBreakdown {
  kTerrainBase: number;
  kAffinity: number;
  kTerrain: number;
  situation: Array<{ label: string; k: number }>;
  kSituationRaw: number;
  kSituationClamped: number;
  status: Array<{ label: string; k: number }>;
  kStatusRaw: number;
  kStatusClamped: number;
  kRaw: number;
  kFinal: number;
}

const affinityOrDefault = (unitType: GroundUnitType, terrain: TerrainType): number => {
  const raw = GROUND_UNIT_STATS[unitType].terrainCombatAffinity[terrain];
  return clamp(raw ?? 1, 0.7, 1.3);
};

export const computeKBreakdown = (params: {
  unitType: GroundUnitType;
  terrainType: TerrainType;
  situation?: SituationFlags;
  status?: StatusFlags;
}): KBreakdown => {
  const { unitType, terrainType } = params;
  const situationFlags = params.situation ?? {};
  const statusFlags = params.status ?? {};

  const kTerrainBase = K_TERRAIN_BASE[terrainType];
  const kAffinity = affinityOrDefault(unitType, terrainType);
  const kTerrain = kTerrainBase * kAffinity;

  const situation: Array<{ label: string; k: number }> = [];
  if (situationFlags.preparedDefense) situation.push({ label: 'prepared_defense', k: PREPARED_DEFENSE_MULT });
  if (situationFlags.encirclement) situation.push({ label: 'encirclement', k: 1.4 });
  if (situationFlags.spent75pctMp) situation.push({ label: 'spent_75pct_mp', k: 0.9 });
  if (situationFlags.amphibiousOrAirborneAssault) situation.push({ label: 'amphibious_or_airborne', k: 0.7 });
  const kSituationRaw = situation.reduce((acc, x) => acc * x.k, 1);
  const kSituationClamped = clamp(kSituationRaw, 0.7, 1.6);

  const status: Array<{ label: string; k: number }> = [];
  // Status flags are penalties only (operational readiness).
  if (statusFlags.outOfSupply) status.push({ label: 'out_of_supply', k: 0.6 });
  if (statusFlags.fatigueExtreme) status.push({ label: 'fatigue_extreme', k: 0.5 });
  if (statusFlags.moraleCritical) status.push({ label: 'moral_critical', k: 0.7 });
  const kStatusRaw = status.reduce((acc, x) => acc * x.k, 1);
  const kStatusClamped = clamp(kStatusRaw, 0.4, 1.0);

  const kRaw = kTerrain * kSituationClamped * kStatusClamped;
  const kFinal = clamp(kRaw, 0.5, 1.8);

  return {
    kTerrainBase,
    kAffinity,
    kTerrain,
    situation,
    kSituationRaw,
    kSituationClamped,
    status,
    kStatusRaw,
    kStatusClamped,
    kRaw,
    kFinal
  };
};

// -----------------------------------
// Movement (was: ground/movement.ts)
// -----------------------------------

export const computeEffectiveMP = (army: Army, supplied: boolean): number => {
  const base = GROUND_UNIT_STATS[army.unitType].baseMP;
  const supplyFactor = supplied ? SUPPLY_FACTOR_SUPPLIED : SUPPLY_FACTOR_UNSUPPLIED;
  const fatigueFactor = clamp(1 - army.fatigue, FATIGUE_FACTOR_MIN, 1);
  const routedFactor = isRouted(army) ? ROUTED_MP_MULT : 1;
  const mp = Math.floor(base * army.condition * supplyFactor * fatigueFactor * routedFactor);
  if (army.members > 0 && army.condition > 0) return Math.max(1, mp);
  return Math.max(0, mp);
};

export const clampAffinity = (v: number | undefined): number => clamp(v ?? 1, 0.7, 1.3);

export interface MoveExecutionResult {
  moved: boolean;
  fromTileId: TileId;
  toTileId: TileId;
  steps: number;
  mpEff: number;
  mpUsedCenti: number;
  enteredEnemyZoc: boolean;
  fatigueDelta: number;
  updatedArmy: Army;
}

export const executeMoveOrder = (params: {
  state: GameState;
  army: Army;
  toTileId: TileId;
  supplied: boolean;
  zocSnapshot: ZocSnapshot | null;
  getOccupants: (tileId: TileId) => Army[];
  stackingCap?: number;
}): MoveExecutionResult => {
  const { state, army, toTileId, supplied, zocSnapshot, getOccupants } = params;
  const stackingCap = params.stackingCap ?? STACKING_CAP;
  const map = generateSurfaceMapForState(state, army.containerId);
  const mpEff = computeEffectiveMP(army, supplied);

  if (!map || !army.surfacePos) {
    return {
      moved: false,
      fromTileId: toTileId,
      toTileId: toTileId,
      steps: 0,
      mpEff: 0,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }
  const fromRawTileId = resolveSurfaceTileId(map.descriptor, army.surfacePos);
  if (fromRawTileId === null || fromRawTileId < 0 || fromRawTileId >= map.tiles.length) {
    return {
      moved: false,
      fromTileId: toTileId,
      toTileId: toTileId,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }

  if (!Number.isFinite(toTileId) || toTileId < 0 || toTileId >= map.tiles.length) {
    return {
      moved: false,
      fromTileId: fromRawTileId,
      toTileId: fromRawTileId,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }

  const from: TileId = fromRawTileId;
  const target: TileId = Math.floor(toTileId);
  const mpCenti = mpEff * 100;

  const tile = map.tiles[target];
  const isAmphibious = GROUND_UNIT_STATS[army.unitType].tags?.includes('amphibious') ?? false;
  const isWaterBiome = (biome: Biome): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';
  const isPassableForArmy = (biome: Biome): boolean => isPassable(biome) || (isAmphibious && isWaterBiome(biome));
  if (!tile || !isPassableForArmy(tile.biome)) {
    return {
      moved: false,
      fromTileId: from,
      toTileId: from,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }

  const isPassableAt = (tileId: TileId): boolean => {
    const tileAt = map.tiles[tileId];
    return !!tileAt && isPassableForArmy(tileAt.biome);
  };

  const isEnemyOccupied = (tileId: TileId): boolean => getOccupants(tileId).some(o => o.factionId !== army.factionId);
  const friendlyCount = (tileId: TileId): number => getOccupants(tileId).filter(o => o.factionId === army.factionId).length;

  const size = map.tiles.length;
  const urbanMask = new Uint8Array(size);
  const buildings = state.groundBuildings ?? [];

  for (const s of map.settlements) {
    if (s.tileId < 0 || s.tileId >= size) continue;
    urbanMask[s.tileId] = 1;
  }
  for (const b of buildings) {
    if (b.surfacePos.bodyId !== map.bodyId) continue;
    const tileId = resolveSurfaceTileId(map.descriptor, b.surfacePos);
    if (tileId === null) continue;
    urbanMask[tileId] = 1;
  }

  const terrainCache: Array<TerrainType | null> = new Array(size).fill(null);
  const baseCostCacheCenti = new Int32Array(size);

  const getTerrainTypeAt = (tileId: TileId): TerrainType => {
    const idx = tileId;
    const cached = terrainCache[idx];
    if (cached) return cached;
    let terrain: TerrainType;
    if (urbanMask[idx]) {
      terrain = 'Urban';
    } else {
      const tileAt = map.tiles[idx];
      terrain = tileAt ? biomeToTerrainType(tileAt.biome) : 'Open';
    }
    terrainCache[idx] = terrain;
    return terrain;
  };

  const getBaseMoveCostCenti = (tileId: TileId): number => {
    const idx = tileId;
    const cached = baseCostCacheCenti[idx];
    if (cached !== 0) return cached;
    const terrain = getTerrainTypeAt(tileId);
    const tileAt = map.tiles[idx];
    const featureBits = tileAt?.featureBits ?? 0;
    const hasRoad = (featureBits & FeatureBits.Road) !== 0;
    const hasRiver = (featureBits & FeatureBits.River) !== 0;

    // V2: roads reduce terrain cost to 1; rivers add +1 after roads.
    const baseCost = hasRoad ? 1 : MOVE_COST[terrain];
    const affinityRaw = GROUND_UNIT_STATS[army.unitType].terrainMoveAffinity[terrain];
    const affinity = clampAffinity(affinityRaw);
    let cost = Math.max(1, Math.round(baseCost * affinity * 100));
    if (hasRiver) cost += 100;
    baseCostCacheCenti[idx] = cost;
    return cost;
  };

  const stepCostCenti = (_from: TileId, b: TileId): number => {
    let cost = getBaseMoveCostCenti(b);
    if (friendlyCount(b) > 0) cost *= 2;
    return cost;
  };

  const pathResult = findPathWithCost({
    map,
    fromTileId: from,
    toTileId: target,
    isBlocked: tileId => !isPassableAt(tileId) || isEnemyOccupied(tileId),
    stepCostCenti
  });

  if (!pathResult || pathResult.path.length <= 1) {
    return {
      moved: false,
      fromTileId: from,
      toTileId: from,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }

  // Execute as far as MP allows (may stop before target).
  let mpUsedCenti = 0;
  let steps = 0;
  let pos = from;
  let enteredEnemyZoc = false;

  for (let i = 1; i < pathResult.path.length; i += 1) {
    const next = pathResult.path[i];
    const isTarget = i === pathResult.path.length - 1;
    const nextFriendlyCount = friendlyCount(next);
    if (!isPassableAt(next)) break;
    if (isEnemyOccupied(next)) break;
    if (isTarget && nextFriendlyCount >= stackingCap) break;
    const cost = stepCostCenti(pos, next);
    if (mpUsedCenti + cost > mpCenti) break;
    mpUsedCenti += cost;
    steps += 1;
    pos = next;
    if (zocSnapshot && isInEnemyZoc(zocSnapshot, next, army.factionId)) {
      enteredEnemyZoc = true;
      break;
    }
  }

  const moved = steps > 0;
  const fatigue = steps === 0 ? 0 : Math.min(FATIGUE_MOVE_PER_HEX * steps, 0.4);

  const toSurfacePos = (tileId: TileId): SurfacePos => {
    const coord = getSurfaceTileCoordFromId(map.descriptor, tileId);
    return coord ? { bodyId: army.containerId, tileId, q: coord.q, r: coord.r } : { bodyId: army.containerId, tileId };
  };

  const updatedArmy: Army = moved
    ? {
        ...army,
        surfacePos: toSurfacePos(pos),
        fatigue: clamp(army.fatigue + fatigue, 0, 1),
        ...(army.posture === 'prepared_defense' ? { posture: 'normal', postureSetTurn: undefined } : {})
      }
    : army;

  return {
    moved,
    fromTileId: from,
    toTileId: pos,
    steps,
    mpEff,
    mpUsedCenti,
    enteredEnemyZoc,
    fatigueDelta: fatigue,
    updatedArmy
  };
};

// ------------------------------
// Combat (Ground V2)
// ------------------------------

export interface EngagementParticipant {
  army: Army;
  supplied: boolean;
  stackingFactor: number;
  frontAssault?: boolean;
}

export interface EngagementPreview {
  attackerIds: string[];
  defenderId: string;
  rngAtk: number;
  rngDef: number;
  attackPower: number;
  defensePower: number;
  lossRateDef: number;
  lossRateAtk: number;
  lossesDef: number;
  lossesAtkTotal: number;
  lossesByAttackerId: Record<string, number>;
}

export interface EngagementResult extends EngagementPreview {
  attackersAfter: Army[];
  defenderAfter: Army;
}

export const computeCoverFactorAtCoord = (map: PlanetSurfaceMap, buildings: GroundBuilding[], tileId: TileId): number => {
  if (isUrbanHex(map, buildings, tileId)) return 1.25;
  if (!Number.isFinite(tileId)) return 1.05;
  const idx = Math.floor(tileId);
  if (idx < 0 || idx >= map.tiles.length) return 1.05;
  const tile = map.tiles[idx];
  if (!tile) return 1.05;
  return coverFactorForBiome(tile.biome);
};

export const computeFortifFactorAtCoord = (map: PlanetSurfaceMap, buildings: GroundBuilding[], tileId: TileId): number => {
  let factor = 1;
  for (const b of buildings) {
    if (b.surfacePos.bodyId !== map.bodyId) continue;
    const bTileId = resolveSurfaceTileId(map.descriptor, b.surfacePos);
    if (bTileId === null || bTileId !== tileId) continue;
    if (b.tags?.includes('bunker') || b.type === 'bunker') {
      factor = Math.max(factor, 1.25);
      continue;
    }
    if (b.tags?.includes('fortification_light') || b.type === 'fortification') {
      factor = Math.max(factor, 1.10);
    }
  }
  return factor;
};

export const hasLineOfSight = (params: {
  map: PlanetSurfaceMap;
  buildings: GroundBuilding[];
  fromTileId: TileId;
  toTileId: TileId;
}): boolean => {
  const { map, buildings, fromTileId, toTileId } = params;
  return lineOfSight({
    fromTileId,
    toTileId,
    map,
    isBlocked: tileId => {
      if (isUrbanHex(map, buildings, tileId)) return true;
      if (tileId < 0 || tileId >= map.tiles.length) return true;
      const tile = map.tiles[tileId];
      if (!tile) return true;
      return isLosBlockingBiome(tile.biome);
    }
  });
};

const combatAffinity = (unitType: GroundUnitType, terrain: TerrainType): number => {
  const raw = GROUND_UNIT_STATS[unitType].terrainCombatAffinity[terrain];
  return clamp(raw ?? 1, 0.7, 1.3);
};

const moraleFactor = (army: Army): number => clamp(army.morale, 0, 1);
const fatigueFactor = (army: Army): number => clamp(1 - army.fatigue, FATIGUE_FACTOR_MIN, 1);
const supplyAtkFactor = (supplied: boolean): number => supplied ? 1 : (1 - SUPPLY_PENALTY_ATK);
const supplyDefFactor = (supplied: boolean): number => supplied ? 1 : (1 - SUPPLY_PENALTY_DEF);

const computeAttackPowerBase = (params: {
  army: Army;
  terrainType: TerrainType;
  supplied: boolean;
  stackingFactor: number;
  frontAssault?: boolean;
}): number => {
  const { army, terrainType, supplied, stackingFactor, frontAssault } = params;
  if (army.members <= 0) return 0;
  const terrainFactor = combatAffinity(army.unitType, terrainType);
  const base =
    army.members *
    army.attack *
    clamp(army.condition, 0, 1) *
    moraleFactor(army) *
    terrainFactor *
    supplyAtkFactor(supplied) *
    fatigueFactor(army) *
    clamp(stackingFactor, 0, 1);
  const routedMult = isRouted(army) ? ROUTED_ATK_MULT : 1;
  const assaultMult = frontAssault ? FRONT_ASSAULT_MULT : 1;
  return base * routedMult * assaultMult;
};

const computeDefensePowerBase = (params: {
  army: Army;
  terrainType: TerrainType;
  supplied: boolean;
  stackingFactor: number;
  turn?: number;
}): number => {
  const { army, terrainType, supplied, stackingFactor } = params;
  if (army.members <= 0) return 0;
  const terrainFactor = combatAffinity(army.unitType, terrainType);
  const base =
    army.members *
    army.defense *
    clamp(army.condition, 0, 1) *
    moraleFactor(army) *
    terrainFactor *
    supplyDefFactor(supplied) *
    fatigueFactor(army) *
    clamp(stackingFactor, 0, 1);
  const routed = isRouted(army);
  const routedMult = routed ? ROUTED_DEF_MULT : 1;
  const preparedDefenseMult = !routed && isPreparedDefenseActive(army, params.turn) ? PREPARED_DEFENSE_MULT : 1;
  return base * routedMult * preparedDefenseMult;
};

const distributeLosses = (
  totalLoss: number,
  entries: Array<{ id: string; weight: number; max: number }>
): Record<string, number> => {
  const losses: Record<string, number> = {};
  if (totalLoss <= 0) {
    entries.forEach(entry => {
      losses[entry.id] = 0;
    });
    return losses;
  }
  const valid = entries.filter(entry => entry.weight > 0 && entry.max > 0);
  if (valid.length === 0) {
    entries.forEach(entry => {
      losses[entry.id] = 0;
    });
    return losses;
  }
  const totalWeight = valid.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    entries.forEach(entry => {
      losses[entry.id] = 0;
    });
    return losses;
  }

  let allocated = 0;
  const fractional: Array<{ id: string; frac: number; capacity: number }> = [];

  valid.forEach(entry => {
    const raw = (totalLoss * entry.weight) / totalWeight;
    let baseLoss = Math.floor(raw);
    baseLoss = Math.min(baseLoss, entry.max);
    losses[entry.id] = baseLoss;
    allocated += baseLoss;
    fractional.push({ id: entry.id, frac: raw - Math.floor(raw), capacity: entry.max - baseLoss });
  });

  entries.forEach(entry => {
    if (losses[entry.id] === undefined) losses[entry.id] = 0;
  });

  let remaining = totalLoss - allocated;
  if (remaining <= 0) return losses;

  const sortedFractional = sorted(fractional, (a, b) => {
    if (a.frac !== b.frac) return b.frac - a.frac;
    return a.id.localeCompare(b.id);
  });

  let idx = 0;
  while (remaining > 0 && sortedFractional.some(entry => entry.capacity > 0)) {
    const entry = sortedFractional[idx % sortedFractional.length];
    idx += 1;
    if (entry.capacity <= 0) continue;
    losses[entry.id] += 1;
    entry.capacity -= 1;
    remaining -= 1;
  }

  return losses;
};

const applyCombatLosses = (army: Army, losses: number, turn: number, params?: { bombarded?: boolean }): Army => {
  const membersBefore = Math.max(0, army.members);
  const clampedLosses = Math.min(membersBefore, Math.max(0, losses));
  const membersAfter = Math.max(0, membersBefore - clampedLosses);
  const lossRatio = membersBefore > 0 ? clampedLosses / membersBefore : 0;
  const bombardConditionLoss = params?.bombarded ? BOMBARD_COMBAT_CONDITION_LOSS : 0;
  const conditionAfter = clamp(army.condition - CONDITION_LOSS_COEFF * lossRatio - bombardConditionLoss, 0, 1);
  const moraleAfter = clamp(army.morale - MORALE_LOSS_COEFF * lossRatio, 0, 1);
  const routedAfter = deriveRoutedAfterMorale(army, moraleAfter);
  const fatigueAfter = clamp(army.fatigue + FATIGUE_COMBAT_ADD, 0, 1);
  return {
    ...army,
    members: membersAfter,
    condition: conditionAfter,
    morale: moraleAfter,
    routed: routedAfter,
    fatigue: fatigueAfter,
    lastCombatTurn: turn
  };
};

const computeEngagementMetrics = (params: {
  rngAtk: number;
  rngDef: number;
  map: PlanetSurfaceMap;
  buildings: GroundBuilding[];
  attackers: EngagementParticipant[];
  defender: EngagementParticipant;
  turn?: number;
  bombardedTileIds?: Set<number> | null;
}): EngagementPreview => {
  const { rngAtk, rngDef, map, buildings, attackers, defender } = params;
  const bombardedTileIds = params.bombardedTileIds ?? null;
  const defenderArmy = defender.army;
  const defenderTileId = defenderArmy.surfacePos
    ? resolveSurfaceTileId(map.descriptor, defenderArmy.surfacePos)
    : null;
  const safeDefenderTileId = defenderTileId ?? 0;
  const defenderTerrain = deriveTerrainTypeFromSurfaceMap(map, buildings, safeDefenderTileId);
  const coverFactor = computeCoverFactorAtCoord(map, buildings, safeDefenderTileId);
  const fortifFactor = computeFortifFactorAtCoord(map, buildings, safeDefenderTileId);
  const isBombardedAt = (tileId: TileId | null | undefined): boolean => {
    if (!bombardedTileIds || tileId === null || tileId === undefined) return false;
    return bombardedTileIds.has(tileId);
  };

  const attackerEntries = attackers.map(attacker => {
    const posTileId = attacker.army.surfacePos
      ? resolveSurfaceTileId(map.descriptor, attacker.army.surfacePos)
      : null;
    const terrain = deriveTerrainTypeFromSurfaceMap(map, buildings, posTileId ?? 0);
    const basePower = computeAttackPowerBase({
      army: attacker.army,
      terrainType: terrain,
      supplied: attacker.supplied,
      stackingFactor: attacker.stackingFactor,
      frontAssault: attacker.frontAssault
    }) * (isBombardedAt(posTileId) ? BOMBARD_COMBAT_MULT : 1);
    return { id: attacker.army.id, members: attacker.army.members, basePower };
  });

  const totalBaseAttack = attackerEntries.reduce((sum, entry) => sum + entry.basePower, 0);
  const attackPower = totalBaseAttack * rngAtk;

  const defenseBase = computeDefensePowerBase({
    army: defenderArmy,
    terrainType: defenderTerrain,
    supplied: defender.supplied,
    stackingFactor: defender.stackingFactor,
    turn: params.turn
  }) * (isBombardedAt(defenderTileId) ? BOMBARD_COMBAT_MULT : 1);
  const defensePower = defenseBase * coverFactor * fortifFactor * rngDef;

  const totalPower = attackPower + defensePower;
  const lossRateDef = totalPower > 0 ? clamp(ENGAGEMENT_LETHALITY * (attackPower / totalPower), 0, ENGAGEMENT_LOSS_CAP) : 0;
  const lossRateAtk = totalPower > 0 ? clamp(ENGAGEMENT_LETHALITY * (defensePower / totalPower), 0, ENGAGEMENT_LOSS_CAP) : 0;

  const lossesDef = Math.min(defenderArmy.members, Math.round(defenderArmy.members * lossRateDef));
  const totalAttackerMembers = attackerEntries.reduce((sum, entry) => sum + entry.members, 0);
  const lossesAtkTotal = Math.min(totalAttackerMembers, Math.round(totalAttackerMembers * lossRateAtk));

  const distributionWeights =
    totalBaseAttack > 0
      ? attackerEntries.map(entry => ({ id: entry.id, weight: entry.basePower, max: entry.members }))
      : attackerEntries.map(entry => ({ id: entry.id, weight: entry.members, max: entry.members }));
  const lossesByAttackerId = distributeLosses(lossesAtkTotal, distributionWeights);

  return {
    attackerIds: attackerEntries.map(entry => entry.id),
    defenderId: defenderArmy.id,
    rngAtk,
    rngDef,
    attackPower,
    defensePower,
    lossRateDef,
    lossRateAtk,
    lossesDef,
    lossesAtkTotal,
    lossesByAttackerId
  };
};

export const previewEngagement = (params: {
  map: PlanetSurfaceMap;
  buildings: GroundBuilding[];
  attackers: EngagementParticipant[];
  defender: EngagementParticipant;
  turn?: number;
  bombardedTileIds?: Set<number> | null;
}): EngagementPreview => {
  return computeEngagementMetrics({
    rngAtk: 1,
    rngDef: 1,
    map: params.map,
    buildings: params.buildings,
    attackers: params.attackers,
    defender: params.defender,
    turn: params.turn,
    bombardedTileIds: params.bombardedTileIds
  });
};

export const resolveEngagement = (params: {
  turn: number;
  map: PlanetSurfaceMap;
  buildings: GroundBuilding[];
  attackers: EngagementParticipant[];
  defender: EngagementParticipant;
  bombardedTileIds?: Set<number> | null;
}): EngagementResult => {
  const attackerIds = sorted(
    params.attackers.map(attacker => attacker.army.id),
    (a, b) => a.localeCompare(b)
  );
  const seed = hashJoin32(params.turn, params.defender.army.id, ...attackerIds, 'ground');
  const rng = new RNG(seed);
  const rngAtk = rollTriangularCentered(rng, RNG_EPSILON);
  const rngDef = rollTriangularCentered(rng, RNG_EPSILON);

  const metrics = computeEngagementMetrics({
    rngAtk,
    rngDef,
    map: params.map,
    buildings: params.buildings,
    attackers: params.attackers,
    defender: params.defender,
    turn: params.turn,
    bombardedTileIds: params.bombardedTileIds
  });

  const isBombardedAt = (tileId: TileId | null | undefined): boolean => {
    if (!params.bombardedTileIds || tileId === null || tileId === undefined) return false;
    return params.bombardedTileIds.has(tileId);
  };

  const attackersAfter = params.attackers.map(attacker => {
    const losses = metrics.lossesByAttackerId[attacker.army.id] ?? 0;
    const tileId = attacker.army.surfacePos
      ? resolveSurfaceTileId(params.map.descriptor, attacker.army.surfacePos)
      : null;
    return applyCombatLosses(attacker.army, losses, params.turn, { bombarded: isBombardedAt(tileId) });
  });
  const defenderTileId = params.defender.army.surfacePos
    ? resolveSurfaceTileId(params.map.descriptor, params.defender.army.surfacePos)
    : null;
  const defenderAfter = applyCombatLosses(params.defender.army, metrics.lossesDef, params.turn, { bombarded: isBombardedAt(defenderTileId) });

  return {
    ...metrics,
    attackersAfter,
    defenderAfter
  };
};
