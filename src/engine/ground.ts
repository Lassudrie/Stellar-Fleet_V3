import { GROUND_UNIT_STATS } from '../content/data/groundUnits';
import type {
  Army,
  Biome,
  FactionId,
  GameState,
  GroundBuilding,
  GroundUnitType,
  HexCoord,
  PlanetSurfaceMap,
  SettlementControlState
} from '../shared/shared';
import { FeatureBits, sorted } from '../shared/shared';
import { RNG } from './rng';
import { generateSurfaceMapForState, hashJoin32, isPassable, neighborsAxial } from './planetSurface';

// ----------------------------
// Utils (was: ground/utils.ts)
// ----------------------------

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const hexKey = (coord: HexCoord): string => `${coord.q}|${coord.r}`;

// Wrap-safe modulo for wrapX maps.
const mod = (n: number, m: number): number => {
  if (m === 0) return 0;
  return ((n % m) + m) % m;
};

/**
 * Normalizes a coordinate for a map with optional wrapX. Returns null if out-of-bounds on r,
 * or on q when wrapX is false.
 */
const normalizeCoord = (coord: HexCoord, w: number, h: number, wrapX: boolean): HexCoord | null => {
  if (w <= 0 || h <= 0) return null;
  const r = coord.r;
  if (r < 0 || r >= h) return null;
  const q = wrapX ? mod(coord.q, w) : coord.q;
  if (q < 0 || q >= w) return null;
  return { q, r };
};

const axialToCube = (coord: HexCoord): { x: number; y: number; z: number } => {
  const x = coord.q;
  const z = coord.r;
  const y = -x - z;
  return { x, y, z };
};

const cubeToAxial = (cube: { x: number; y: number; z: number }): HexCoord => ({ q: cube.x, r: cube.z });

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

export const hexDistance = (a: HexCoord, b: HexCoord, w: number, wrapX: boolean): number => {
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

const adjustTargetForWrap = (from: HexCoord, to: HexCoord, w: number, wrapX: boolean): HexCoord => {
  if (!wrapX || w <= 0) return to;
  const dqRaw = to.q - from.q;
  const modded = mod(dqRaw, w);
  const alt = modded > w / 2 ? modded - w : modded;
  return { q: from.q + alt, r: to.r };
};

export const lineOfSight = (params: {
  from: HexCoord;
  to: HexCoord;
  map: PlanetSurfaceMap;
  isBlocked: (coord: HexCoord) => boolean;
}): boolean => {
  const { from, to, map, isBlocked } = params;
  const { w, h, wrapX } = map.descriptor.config;
  const fromNorm = normalizeCoord(from, w, h, wrapX);
  const toNorm = normalizeCoord(to, w, h, wrapX);
  if (!fromNorm || !toNorm) return false;

  // For wrapX maps, unroll "to" so that dq is the minimal delta before rasterization.
  // We still normalize sampled points back into [0..w) for tile access and blockers.
  const toUnwrapped = adjustTargetForWrap(fromNorm, toNorm, w, wrapX);

  const a = axialToCube(fromNorm);
  const b = axialToCube(toUnwrapped);
  const dist = hexDistance(fromNorm, toUnwrapped, w, false);
  if (dist <= 1) return true;

  for (let i = 1; i < dist; i += 1) {
    const t = dist === 0 ? 0 : i / dist;
    const cube = cubeRound(cubeLerp(a, b, t));
    const axial = cubeToAxial(cube);
    const norm = normalizeCoord(axial, w, h, wrapX);
    if (!norm) return false;
    if (isBlocked(norm)) return false;
  }
  return true;
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

export const deriveTerrainTypeFromSurfaceMap = (map: PlanetSurfaceMap, buildings: GroundBuilding[], coord: HexCoord): TerrainType => {
  const { w, h, wrapX } = map.descriptor.config;
  const norm = normalizeCoord(coord, w, h, wrapX);
  if (!norm) return 'Open';
  const { q, r } = norm;

  const hasBuilding = buildings.some(b => b.surfacePos.bodyId === map.bodyId && b.surfacePos.q === q && b.surfacePos.r === r);
  if (hasBuilding) return 'Urban';

  const hasSettlement = map.settlements.some(s => s.coord.q === q && s.coord.r === r);
  if (hasSettlement) return 'Urban';

  const tile = map.tiles[r * w + q];
  if (!tile) return 'Open';
  return biomeToTerrainType(tile.biome);
};

export const deriveTerrainType = (state: GameState, bodyId: string, coord: HexCoord): TerrainType => {
  const buildings = state.groundBuildings ?? [];
  const surfaceMap = generateSurfaceMapForState(state, bodyId);
  if (surfaceMap) return deriveTerrainTypeFromSurfaceMap(surfaceMap, buildings, coord);

  // Fallback when surface map is unavailable: urban buildings only.
  const hasBuilding = buildings.some(b => b.surfacePos.bodyId === bodyId && b.surfacePos.q === coord.q && b.surfacePos.r === coord.r);
  return hasBuilding ? 'Urban' : 'Open';
};

export const isUrbanHex = (map: PlanetSurfaceMap, buildings: GroundBuilding[], coord: HexCoord): boolean => {
  const { w, h, wrapX } = map.descriptor.config;
  const norm = normalizeCoord(coord, w, h, wrapX);
  if (!norm) return false;
  const { q, r } = norm;
  if (buildings.some(b => b.surfacePos.bodyId === map.bodyId && b.surfacePos.q === q && b.surfacePos.r === r)) return true;
  return map.settlements.some(s => s.coord.q === q && s.coord.r === r);
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
  w: number;
  h: number;
  wrapX: boolean;
  zocByFactionId: Map<FactionId, Uint8Array>;
}

const forEachCoordInRange = (
  center: HexCoord,
  range: number,
  w: number,
  h: number,
  wrapX: boolean,
  cb: (coord: HexCoord) => void
) => {
  if (range <= 0) return;
  for (let dq = -range; dq <= range; dq += 1) {
    const rMin = Math.max(-range, -dq - range);
    const rMax = Math.min(range, -dq + range);
    for (let dr = rMin; dr <= rMax; dr += 1) {
      const coord = normalizeCoord({ q: center.q + dq, r: center.r + dr }, w, h, wrapX);
      if (!coord) continue;
      cb(coord);
    }
  }
};

export const computeZocSnapshotFromArmies = (params: {
  bodyId: string;
  w: number;
  h: number;
  wrapX: boolean;
  armies: Army[];
}): ZocSnapshot => {
  const { bodyId, w, h, wrapX, armies } = params;
  const size = w * h;
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
    const norm = normalizeCoord({ q: army.surfacePos.q, r: army.surfacePos.r }, w, h, wrapX);
    if (!norm) continue;
    const arr = getArr(army.factionId);
    forEachCoordInRange(norm, Math.max(0, Math.floor(army.projectionRange)), w, h, wrapX, coord => {
      arr[coord.r * w + coord.q] = 1;
    });
  }

  return { bodyId, w, h, wrapX, zocByFactionId };
};

export const isInEnemyZoc = (snapshot: ZocSnapshot, coord: HexCoord, ownFactionId: FactionId): boolean => {
  const norm = normalizeCoord(coord, snapshot.w, snapshot.h, snapshot.wrapX);
  if (!norm) return false;
  const idx = norm.r * snapshot.w + norm.q;
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
  const { w, h, wrapX } = map.descriptor.config;
  const size = w * h;
  const dist = new Uint16Array(size);
  dist.fill(INF);

  const queueQ = new Int32Array(size);
  const queueR = new Int32Array(size);
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
  for (const s of map.settlements) {
    const control = settlementControl?.[s.id];
    const controller = control?.factionId ?? s.factionId ?? null;
    if (controller !== factionId) continue;
    const norm = normalizeCoord(s.coord, w, h, wrapX);
    if (!norm) continue;
    enqueue(norm, 0);
  }

  for (const b of buildings) {
    if (b.factionId !== factionId) continue;
    if (b.surfacePos.bodyId !== map.bodyId) continue;
    if (b.tags && !b.tags.includes('supply_node')) continue;
    const norm = normalizeCoord({ q: b.surfacePos.q, r: b.surfacePos.r }, w, h, wrapX);
    if (!norm) continue;
    enqueue(norm, 0);
  }

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
  const { w, h, wrapX } = bodyMap.descriptor.config;
  const norm = normalizeCoord(coord, w, h, wrapX);
  if (!norm) return false;
  const idx = norm.r * w + norm.q;
  const d = distanceMap[idx];
  return d <= radius;
};

// --------------------------------
// Pathfinding (was: ground/pathfinding.ts)
// --------------------------------

type Node = { q: number; r: number; cost: number };

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
    // Tie-break for determinism: cost, then r, then q.
    if (a.cost !== b.cost) return a.cost < b.cost;
    if (a.r !== b.r) return a.r < b.r;
    return a.q < b.q;
  }
}

export interface FindPathParams {
  from: HexCoord;
  to: HexCoord;
  w: number;
  h: number;
  wrapX: boolean;
  isBlocked: (coord: HexCoord) => boolean;
  stepCostCenti: (from: HexCoord, to: HexCoord) => number; // includes ZOC modifiers etc.
}

export interface PathResult {
  path: HexCoord[]; // includes start and end
  costCenti: number;
}

export interface ReachableParams {
  from: HexCoord;
  w: number;
  h: number;
  wrapX: boolean;
  isBlocked: (coord: HexCoord) => boolean;
  stepCostCenti: (from: HexCoord, to: HexCoord) => number;
  maxCostCenti: number;
  canExpand?: (coord: HexCoord) => boolean;
}

export const computeReachable = (params: ReachableParams): Map<string, number> => {
  const { from, w, h, wrapX, isBlocked, stepCostCenti, maxCostCenti, canExpand } = params;
  const startKey = hexKey(from);
  const dist = new Map<string, number>();
  dist.set(startKey, 0);

  const heap = new MinHeap();
  heap.push({ q: from.q, r: from.r, cost: 0 });

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const curCoord: HexCoord = { q: cur.q, r: cur.r };
    const curKey = hexKey(curCoord);
    const best = dist.get(curKey);
    if (best === undefined || cur.cost !== best) continue;
    if (cur.cost > maxCostCenti) continue;

    if (canExpand && !canExpand(curCoord)) continue;

    const ns = neighborsAxial(curCoord, w, h, wrapX);
    for (const n of ns) {
      const nKey = hexKey(n);
      if (nKey !== startKey && isBlocked(n)) continue;
      const step = stepCostCenti(curCoord, n);
      if (!Number.isFinite(step) || step <= 0) continue;
      const nextCost = cur.cost + step;
      if (nextCost > maxCostCenti) continue;
      const known = dist.get(nKey);
      if (known === undefined || nextCost < known) {
        dist.set(nKey, nextCost);
        heap.push({ q: n.q, r: n.r, cost: nextCost });
      }
    }
  }

  return dist;
};

export const findPathWithCost = (params: FindPathParams): PathResult | null => {
  const { from, to, w, h, wrapX, isBlocked, stepCostCenti } = params;
  const startKey = hexKey(from);
  const goalKey = hexKey(to);

  const dist = new Map<string, number>();
  const prev = new Map<string, HexCoord>();
  dist.set(startKey, 0);

  const heap = new MinHeap();
  heap.push({ q: from.q, r: from.r, cost: 0 });

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const curCoord: HexCoord = { q: cur.q, r: cur.r };
    const curKey = hexKey(curCoord);
    const best = dist.get(curKey);
    if (best === undefined || cur.cost !== best) continue;
    if (curKey === goalKey) break;

    const ns = neighborsAxial(curCoord, w, h, wrapX);
    for (const n of ns) {
      const nKey = hexKey(n);
      if (nKey !== goalKey && isBlocked(n)) continue;
      const step = stepCostCenti(curCoord, n);
      if (!Number.isFinite(step) || step <= 0) continue;
      const nextCost = cur.cost + step;
      const known = dist.get(nKey);
      if (known === undefined || nextCost < known) {
        dist.set(nKey, nextCost);
        prev.set(nKey, curCoord);
        heap.push({ q: n.q, r: n.r, cost: nextCost });
      }
    }
  }

  const total = dist.get(goalKey);
  if (total === undefined) return null;

  // Reconstruct
  const path: HexCoord[] = [];
  let cur: HexCoord = to;
  path.push(cur);
  while (hexKey(cur) !== startKey) {
    const p = prev.get(hexKey(cur));
    if (!p) break;
    cur = p;
    path.push(cur);
  }
  path.reverse();

  // Ensure start present
  if (path.length === 0 || hexKey(path[0]) !== startKey) {
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
  from: HexCoord;
  to: HexCoord;
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
  to: HexCoord;
  supplied: boolean;
  zocSnapshot: ZocSnapshot | null;
  getOccupants: (coord: HexCoord) => Army[];
  stackingCap?: number;
}): MoveExecutionResult => {
  const { state, army, to, supplied, zocSnapshot, getOccupants } = params;
  const stackingCap = params.stackingCap ?? STACKING_CAP;
  const map = generateSurfaceMapForState(state, army.containerId);
  const mpEff = computeEffectiveMP(army, supplied);

  const fromRaw: HexCoord = army.surfacePos ? { q: army.surfacePos.q, r: army.surfacePos.r } : to;

  if (!map || !army.surfacePos) {
    return {
      moved: false,
      from: fromRaw,
      to: fromRaw,
      steps: 0,
      mpEff: 0,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }
  const { w, h, wrapX } = map.descriptor.config;

  const fromNorm = normalizeCoord(fromRaw, w, h, wrapX);
  if (!fromNorm) {
    return {
      moved: false,
      from: fromRaw,
      to: fromRaw,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }

  const toNorm = normalizeCoord(to, w, h, wrapX);
  if (!toNorm) {
    return {
      moved: false,
      from: fromNorm,
      to: fromNorm,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }

  const from: HexCoord = fromNorm;
  const target: HexCoord = toNorm;
  const mpCenti = mpEff * 100;

  const tile = map.tiles[target.r * w + target.q];
  const isAmphibious = GROUND_UNIT_STATS[army.unitType].tags?.includes('amphibious') ?? false;
  const isWaterBiome = (biome: Biome): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';
  const isPassableForArmy = (biome: Biome): boolean => isPassable(biome) || (isAmphibious && isWaterBiome(biome));
  if (!tile || !isPassableForArmy(tile.biome)) {
    return {
      moved: false,
      from,
      to: from,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      enteredEnemyZoc: false,
      fatigueDelta: 0,
      updatedArmy: army
    };
  }

  const isPassableAt = (c: HexCoord): boolean => {
    const tileAt = map.tiles[c.r * w + c.q];
    return !!tileAt && isPassableForArmy(tileAt.biome);
  };

  const isEnemyOccupied = (coord: HexCoord): boolean => getOccupants(coord).some(o => o.factionId !== army.factionId);
  const friendlyCount = (coord: HexCoord): number => getOccupants(coord).filter(o => o.factionId === army.factionId).length;

  const size = w * h;
  const urbanMask = new Uint8Array(size);
  const buildings = state.groundBuildings ?? [];

  for (const s of map.settlements) {
    const norm = normalizeCoord(s.coord, w, h, wrapX);
    if (!norm) continue;
    urbanMask[norm.r * w + norm.q] = 1;
  }
  for (const b of buildings) {
    if (b.surfacePos.bodyId !== map.bodyId) continue;
    const norm = normalizeCoord({ q: b.surfacePos.q, r: b.surfacePos.r }, w, h, wrapX);
    if (!norm) continue;
    urbanMask[norm.r * w + norm.q] = 1;
  }

  const terrainCache: Array<TerrainType | null> = new Array(size).fill(null);
  const baseCostCacheCenti = new Int32Array(size);

  const getTerrainTypeAt = (c: HexCoord): TerrainType => {
    const idx = c.r * w + c.q;
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

  const getBaseMoveCostCenti = (c: HexCoord): number => {
    const idx = c.r * w + c.q;
    const cached = baseCostCacheCenti[idx];
    if (cached !== 0) return cached;
    const terrain = getTerrainTypeAt(c);
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

  const stepCostCenti = (_from: HexCoord, b: HexCoord): number => {
    let cost = getBaseMoveCostCenti(b);
    if (friendlyCount(b) > 0) cost *= 2;
    return cost;
  };

  const pathResult = findPathWithCost({
    from,
    to: target,
    w,
    h,
    wrapX,
    isBlocked: c => !isPassableAt(c) || isEnemyOccupied(c),
    stepCostCenti
  });

  if (!pathResult || pathResult.path.length <= 1) {
    return {
      moved: false,
      from,
      to: from,
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

  const updatedArmy: Army = moved
    ? {
        ...army,
        surfacePos: { bodyId: army.containerId, q: pos.q, r: pos.r },
        fatigue: clamp(army.fatigue + fatigue, 0, 1),
        ...(army.posture === 'prepared_defense' ? { posture: 'normal', postureSetTurn: undefined } : {})
      }
    : army;

  return {
    moved,
    from,
    to: pos,
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

export const computeCoverFactorAtCoord = (map: PlanetSurfaceMap, buildings: GroundBuilding[], coord: HexCoord): number => {
  if (isUrbanHex(map, buildings, coord)) return 1.25;
  const { w, h, wrapX } = map.descriptor.config;
  const norm = normalizeCoord(coord, w, h, wrapX);
  if (!norm) return 1.05;
  const tile = map.tiles[norm.r * w + norm.q];
  if (!tile) return 1.05;
  return coverFactorForBiome(tile.biome);
};

export const computeFortifFactorAtCoord = (buildings: GroundBuilding[], bodyId: string, coord: HexCoord): number => {
  let factor = 1;
  for (const b of buildings) {
    if (b.surfacePos.bodyId !== bodyId) continue;
    if (b.surfacePos.q !== coord.q || b.surfacePos.r !== coord.r) continue;
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
  from: HexCoord;
  to: HexCoord;
}): boolean => {
  const { map, buildings, from, to } = params;
  return lineOfSight({
    from,
    to,
    map,
    isBlocked: coord => {
      if (isUrbanHex(map, buildings, coord)) return true;
      const { w, h, wrapX } = map.descriptor.config;
      const norm = normalizeCoord(coord, w, h, wrapX);
      if (!norm) return true;
      const tile = map.tiles[norm.r * w + norm.q];
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
  bombardedKeys?: Set<string> | null;
}): EngagementPreview => {
  const { rngAtk, rngDef, map, buildings, attackers, defender } = params;
  const bombardedKeys = params.bombardedKeys ?? null;
  const defenderArmy = defender.army;
  const defenderPos = defenderArmy.surfacePos ? { q: defenderArmy.surfacePos.q, r: defenderArmy.surfacePos.r } : { q: 0, r: 0 };
  const defenderTerrain = deriveTerrainTypeFromSurfaceMap(map, buildings, defenderPos);
  const coverFactor = computeCoverFactorAtCoord(map, buildings, defenderPos);
  const fortifFactor = computeFortifFactorAtCoord(buildings, map.bodyId, defenderPos);
  const { w, h, wrapX } = map.descriptor.config;
  const isBombardedAt = (coord: HexCoord): boolean => {
    if (!bombardedKeys) return false;
    const norm = normalizeCoord(coord, w, h, wrapX);
    if (!norm) return false;
    return bombardedKeys.has(hexKey(norm));
  };

  const attackerEntries = attackers.map(attacker => {
    const pos = attacker.army.surfacePos ? { q: attacker.army.surfacePos.q, r: attacker.army.surfacePos.r } : { q: 0, r: 0 };
    const terrain = deriveTerrainTypeFromSurfaceMap(map, buildings, pos);
    const basePower = computeAttackPowerBase({
      army: attacker.army,
      terrainType: terrain,
      supplied: attacker.supplied,
      stackingFactor: attacker.stackingFactor,
      frontAssault: attacker.frontAssault
    }) * (isBombardedAt(pos) ? BOMBARD_COMBAT_MULT : 1);
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
  }) * (isBombardedAt(defenderPos) ? BOMBARD_COMBAT_MULT : 1);
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
  bombardedKeys?: Set<string> | null;
}): EngagementPreview => {
  return computeEngagementMetrics({
    rngAtk: 1,
    rngDef: 1,
    map: params.map,
    buildings: params.buildings,
    attackers: params.attackers,
    defender: params.defender,
    turn: params.turn,
    bombardedKeys: params.bombardedKeys
  });
};

export const resolveEngagement = (params: {
  turn: number;
  map: PlanetSurfaceMap;
  buildings: GroundBuilding[];
  attackers: EngagementParticipant[];
  defender: EngagementParticipant;
  bombardedKeys?: Set<string> | null;
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
    bombardedKeys: params.bombardedKeys
  });

  const { w, h, wrapX } = params.map.descriptor.config;
  const isBombardedAt = (coord: HexCoord | null | undefined): boolean => {
    if (!params.bombardedKeys || !coord) return false;
    const norm = normalizeCoord(coord, w, h, wrapX);
    if (!norm) return false;
    return params.bombardedKeys.has(hexKey(norm));
  };

  const attackersAfter = params.attackers.map(attacker => {
    const losses = metrics.lossesByAttackerId[attacker.army.id] ?? 0;
    const coord = attacker.army.surfacePos ? { q: attacker.army.surfacePos.q, r: attacker.army.surfacePos.r } : null;
    return applyCombatLosses(attacker.army, losses, params.turn, { bombarded: isBombardedAt(coord) });
  });
  const defenderCoord = params.defender.army.surfacePos
    ? { q: params.defender.army.surfacePos.q, r: params.defender.army.surfacePos.r }
    : null;
  const defenderAfter = applyCombatLosses(params.defender.army, metrics.lossesDef, params.turn, { bombarded: isBombardedAt(defenderCoord) });

  return {
    ...metrics,
    attackersAfter,
    defenderAfter
  };
};
