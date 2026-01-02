import { GROUND_UNIT_STATS } from '../content/data/groundUnits';
import type {
  Army,
  Biome,
  FactionId,
  GameState,
  GroundBuilding,
  GroundUnitType,
  HexCoord,
  PlanetSurfaceMap
} from '../shared/shared';
import { RNG } from './rng';
import { generateSurfaceMapForState, getTileAt, hashJoin32, isPassable, neighborsAxial } from './planetSurface';

// ----------------------------
// Utils (was: ground/utils.ts)
// ----------------------------

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const hexKey = (coord: HexCoord): string => `${coord.q}|${coord.r}`;

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
  Urban: 1.05,
  Swamp: 0.9,
  Desert: 0.95,
  Coastal: 0.95
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

export const biomeToTerrainType = (biome: Biome): TerrainType => {
  switch (biome) {
    case 'desert':
      return 'Desert';
    case 'coast':
      return 'Coastal';
    case 'forest':
    case 'rainforest':
    case 'taiga':
      return 'Forest';
    case 'mountain':
    case 'volcanic':
      return 'Mountains';
    case 'rocky':
    case 'cratered':
      return 'Hills';
    case 'grassland':
    case 'tundra':
    case 'ice':
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
  const q = wrapX ? ((coord.q % w) + w) % w : coord.q;
  const r = coord.r;
  if (r < 0 || r >= h) return 'Open';
  if (!wrapX && (q < 0 || q >= w)) return 'Open';

  const hasBuilding = buildings.some(b => b.surfacePos.bodyId === map.bodyId && b.surfacePos.q === q && b.surfacePos.r === r);
  if (hasBuilding) return 'Urban';

  const hasSettlement = map.settlements.some(s => s.coord.q === q && s.coord.r === r);
  if (hasSettlement) return 'Urban';

  const tile = map.tiles[r * w + q];
  if (!tile) return 'Open';
  return biomeToTerrainType(tile.biome);
};

export const deriveTerrainType = (state: GameState, bodyId: string, coord: HexCoord): TerrainType => {
  // Urban if settlement or building exists on the tile.
  const buildings = state.groundBuildings ?? [];
  const hasBuilding = buildings.some(b => b.surfacePos.bodyId === bodyId && b.surfacePos.q === coord.q && b.surfacePos.r === coord.r);
  if (hasBuilding) return 'Urban';

  const surfaceMap = generateSurfaceMapForState(state, bodyId);
  const hasSettlement = surfaceMap?.settlements?.some(s => s.coord.q === coord.q && s.coord.r === coord.r);
  if (hasSettlement) return 'Urban';

  const tileResult = getTileAt(state, bodyId, coord.q, coord.r);
  if (!tileResult) return 'Open';
  return biomeToTerrainType(tileResult.tile.biome);
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

  armies.forEach(army => {
    if (army.state !== 'DEPLOYED') return;
    if (army.containerId !== bodyId) return;
    if (!army.surfacePos) return;
    if (army.members <= 0) return;
    if (army.condition < 0.3) return;
    const q = army.surfacePos.q;
    const r = army.surfacePos.r;
    if (q < 0 || q >= w || r < 0 || r >= h) return;
    const arr = getArr(army.factionId);
    const ns = neighborsAxial({ q, r }, w, h, wrapX);
    for (const n of ns) {
      arr[n.r * w + n.q] = 1;
    }
  });

  return { bodyId, w, h, wrapX, zocByFactionId };
};

export const computeZocSnapshotForBody = (state: GameState, bodyId: string, armies: Army[]): ZocSnapshot | null => {
  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;
  const { w, h, wrapX } = map.descriptor.config;
  return computeZocSnapshotFromArmies({ bodyId, w, h, wrapX, armies });
};

export const isInEnemyZoc = (snapshot: ZocSnapshot, coord: HexCoord, ownFactionId: FactionId): boolean => {
  const idx = coord.r * snapshot.w + coord.q;
  for (const [factionId, arr] of snapshot.zocByFactionId.entries()) {
    if (factionId === ownFactionId) continue;
    if (arr[idx]) return true;
  }
  return false;
};

// -------------------------------------
// Break outcome (was: ground/breakOutcome.ts)
// -------------------------------------

export type BreakOutcome = { type: 'retreat'; to: HexCoord } | { type: 'overrun' };

export const chooseDefenderRetreat = (params: {
  state: GameState;
  defender: Army;
  from: HexCoord;
  zocSnapshot: ZocSnapshot | null;
  isOccupied: (coord: HexCoord) => boolean;
}): BreakOutcome => {
  const { state, defender, from, zocSnapshot, isOccupied } = params;
  const map = generateSurfaceMapForState(state, defender.containerId);
  if (!map) return { type: 'overrun' };
  const { w, h, wrapX } = map.descriptor.config;

  const candidates = neighborsAxial(from, w, h, wrapX)
    .filter(c => {
      const tile = map.tiles[c.r * w + c.q];
      if (!tile || !isPassable(tile.biome)) return false;
      if (isOccupied(c)) return false;
      return true;
    })
    .map(c => {
      const inEnemy = zocSnapshot ? isInEnemyZoc(zocSnapshot, c, defender.factionId) : false;
      // Pressure heuristic: count adjacent enemy-zoc tiles.
      let pressure = 0;
      if (zocSnapshot) {
        const ns = neighborsAxial(c, w, h, wrapX);
        for (const n of ns) {
          if (isInEnemyZoc(zocSnapshot, n, defender.factionId)) pressure += 1;
        }
      }
      return { coord: c, inEnemy, pressure };
    });

  if (candidates.length === 0) return { type: 'overrun' };

  const compare = (
    a: { coord: HexCoord; inEnemy: boolean; pressure: number },
    b: { coord: HexCoord; inEnemy: boolean; pressure: number }
  ) => {
    // Prefer out of enemy ZOC, then lower pressure, then stable (r, q).
    if (a.inEnemy !== b.inEnemy) return a.inEnemy ? 1 : -1;
    if (a.pressure !== b.pressure) return a.pressure - b.pressure;
    if (a.coord.r !== b.coord.r) return a.coord.r - b.coord.r;
    return a.coord.q - b.coord.q;
  };

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i];
    if (compare(c, best) < 0) best = c;
  }

  return { type: 'retreat', to: best.coord };
};

export const applyOverrunPenalty = (army: Army): Army => {
  // Deterministic penalty when no retreat is possible.
  const extraLoss = Math.max(1, Math.floor(army.members * 0.1));
  const members = Math.max(0, army.members - extraLoss);
  const condition = clamp(army.condition - 0.05, 0, 1);
  return { ...army, members, condition };
};

// ---------------------------
// Supply (was: ground/supply.ts)
// ---------------------------

export const SUPPLY_RADIUS = 6;

const INF = 0xffff;

export const computeSupplyDistanceMapForBody = (state: GameState, bodyId: string, factionId: FactionId): Uint16Array | null => {
  const map = generateSurfaceMapForState(state, bodyId);
  if (!map) return null;
  return computeSupplyDistanceMapFromSurfaceMap(map, state.groundBuildings ?? [], factionId);
};

export const computeSupplyDistanceMapFromSurfaceMap = (map: PlanetSurfaceMap, buildings: GroundBuilding[], factionId: FactionId): Uint16Array => {
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
}

export const computeReachable = (params: ReachableParams): Map<string, number> => {
  const { from, w, h, wrapX, isBlocked, stepCostCenti, maxCostCenti } = params;
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
  spent75pctMp?: boolean;
  amphibiousOrAirborneAssault?: boolean;
}

export interface StatusFlags {
  outOfSupply?: boolean;
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
  if (situationFlags.spent75pctMp) situation.push({ label: 'spent_75pct_mp', k: 0.9 });
  if (situationFlags.amphibiousOrAirborneAssault) situation.push({ label: 'amphibious_or_airborne', k: 0.7 });
  const kSituationRaw = situation.reduce((acc, x) => acc * x.k, 1);
  const kSituationClamped = clamp(kSituationRaw, 0.7, 1.6);

  const status: Array<{ label: string; k: number }> = [];
  // NOTE: This is the minimal operational status flag required by the movement model.
  // If you have a canonical Ki table, update this constant + tests/spec.
  if (statusFlags.outOfSupply) status.push({ label: 'out_of_supply', k: 0.85 });
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

export const SUPPLY_FACTOR_SUPPLIED = 1.0;
export const SUPPLY_FACTOR_UNSUPPLIED = 0.7;

export const computeEffectiveMP = (army: Army, supplied: boolean): number => {
  const base = GROUND_UNIT_STATS[army.unitType].baseMP;
  const supplyFactor = supplied ? SUPPLY_FACTOR_SUPPLIED : SUPPLY_FACTOR_UNSUPPLIED;
  const mp = Math.floor(base * army.condition * supplyFactor);
  if (army.members > 0 && army.condition > 0) return Math.max(1, mp);
  return Math.max(0, mp);
};

const clampAffinity = (v: number | undefined): number => clamp(v ?? 1, 0.7, 1.3);

export interface MoveExecutionResult {
  moved: boolean;
  from: HexCoord;
  to: HexCoord;
  steps: number;
  mpEff: number;
  mpUsedCenti: number;
  used75pct: boolean;
  fatigueDelta: number;
  touchedCost3: boolean;
  updatedArmy: Army;
}

export const executeMoveOrder = (params: {
  state: GameState;
  army: Army;
  to: HexCoord;
  supplied: boolean;
  zocSnapshot: ZocSnapshot | null;
  isOccupied: (coord: HexCoord) => boolean;
}): MoveExecutionResult => {
  const { state, army, to, supplied, zocSnapshot, isOccupied } = params;
  const map = generateSurfaceMapForState(state, army.containerId);
  if (!map || !army.surfacePos) {
    return {
      moved: false,
      from: to,
      to,
      steps: 0,
      mpEff: 0,
      mpUsedCenti: 0,
      used75pct: false,
      fatigueDelta: 0,
      touchedCost3: false,
      updatedArmy: army
    };
  }
  const { w, h, wrapX } = map.descriptor.config;

  const from: HexCoord = { q: army.surfacePos.q, r: army.surfacePos.r };
  const mpEff = computeEffectiveMP(army, supplied);
  const mpCenti = mpEff * 100;

  const inBounds = (c: HexCoord) => c.q >= 0 && c.q < w && c.r >= 0 && c.r < h;
  if (!inBounds(to)) {
    return {
      moved: false,
      from,
      to: from,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      used75pct: false,
      fatigueDelta: 0,
      touchedCost3: false,
      updatedArmy: army
    };
  }
  const tile = map.tiles[to.r * w + to.q];
  if (!tile || !isPassable(tile.biome)) {
    return {
      moved: false,
      from,
      to: from,
      steps: 0,
      mpEff,
      mpUsedCenti: 0,
      used75pct: false,
      fatigueDelta: 0,
      touchedCost3: false,
      updatedArmy: army
    };
  }

  const stepCostCenti = (a: HexCoord, b: HexCoord): number => {
    const terrain = deriveTerrainType(state, army.containerId, b);
    const baseCost = MOVE_COST[terrain];
    const affinityRaw = GROUND_UNIT_STATS[army.unitType].terrainMoveAffinity[terrain];
    const affinity = clampAffinity(affinityRaw);
    let cost = Math.round(baseCost * affinity * 100);

    if (zocSnapshot) {
      const curEnemy = isInEnemyZoc(zocSnapshot, a, army.factionId);
      const nextEnemy = isInEnemyZoc(zocSnapshot, b, army.factionId);
      if (!curEnemy && nextEnemy) cost += 100;
      if (curEnemy && !nextEnemy) cost += 100;
    }

    return cost;
  };

  const pathResult = findPathWithCost({
    from,
    to,
    w,
    h,
    wrapX,
    isBlocked: c => isOccupied(c),
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
      used75pct: false,
      fatigueDelta: 0,
      touchedCost3: false,
      updatedArmy: army
    };
  }

  // Execute as far as MP allows (may stop before target).
  let mpUsedCenti = 0;
  let steps = 0;
  let pos = from;
  let touchedCost3 = false;

  for (let i = 1; i < pathResult.path.length; i += 1) {
    const next = pathResult.path[i];
    // Collision/no-stacking guard: if the next hex is occupied at execution time, stop immediately
    // on the previous hex (do not spend MP for the blocked step).
    if (isOccupied(next)) break;
    const cost = stepCostCenti(pos, next);
    if (mpUsedCenti + cost > mpCenti) break;
    mpUsedCenti += cost;
    steps += 1;
    const terrain = deriveTerrainType(state, army.containerId, next);
    if (MOVE_COST[terrain] >= 3) touchedCost3 = true;
    pos = next;
  }

  const moved = steps > 0;
  const mpUsedRatio = mpCenti > 0 ? mpUsedCenti / mpCenti : 0;
  const used75pct = mpUsedRatio >= 0.75;

  // Fatigue
  let fatigue = 0.02 * steps;
  if (touchedCost3) fatigue *= 1.5;
  if (!supplied) fatigue *= 1.5;
  fatigue = clamp(fatigue, 0, 1);

  const updatedArmy: Army = moved
    ? {
        ...army,
        surfacePos: { bodyId: army.containerId, q: pos.q, r: pos.r },
        condition: clamp(army.condition - fatigue, 0, 1)
      }
    : army;

  return {
    moved,
    from,
    to: pos,
    steps,
    mpEff,
    mpUsedCenti,
    used75pct,
    fatigueDelta: fatigue,
    touchedCost3,
    updatedArmy
  };
};

// ------------------------------
// Combat (was: ground/combat.ts)
// ------------------------------

export interface EngagementContext {
  turn: number;
  terrainType: TerrainType; // terrain of defender hex
  attackerSituation?: SituationFlags;
  defenderSituation?: SituationFlags;
  attackerStatus?: StatusFlags;
  defenderStatus?: StatusFlags;
}

export interface EngagementResult {
  attackerId: string;
  defenderId: string;
  attackerFactionId: FactionId;
  defenderFactionId: FactionId;
  terrainType: TerrainType;

  // Core metrics
  srAtt: number;
  srDef: number;
  kAtt: KBreakdown;
  kDef: KBreakdown;
  ra: number;
  rd: number;
  attackEff: number;
  defenseEff: number;
  r: number;

  // Losses
  pDef: number;
  pAtt: number;
  lossesDef: number;
  lossesAtt: number;

  // Condition deltas
  dCDef: number;
  dCAtt: number;

  // Break
  breakScore: number;
  advantage: number;
  breakChance: number;
  breakRoll: number;
  defenderBroke: boolean;

  // Updated units
  attackerAfter: Army;
  defenderAfter: Army;
}

export type EngagementPreview = Omit<EngagementResult, 'breakRoll' | 'defenderBroke' | 'attackerAfter' | 'defenderAfter'>;

const computeSR = (army: Army): number => {
  if (army.maxMembers <= 0) return 0;
  return clamp(army.members / army.maxMembers, 0, 1);
};

const computeLosses = (members: number, p: number): number => {
  if (members <= 0) return 0;
  if (p <= 0) return 0;
  const raw = Math.floor(members * p);
  return Math.max(1, raw);
};

export const previewEngagement = (attacker: Army, defender: Army, ctx: EngagementContext): EngagementPreview => {
  const srAtt = computeSR(attacker);
  const srDef = computeSR(defender);
  const kAtt = computeKBreakdown({
    unitType: attacker.unitType,
    terrainType: ctx.terrainType,
    situation: ctx.attackerSituation,
    status: ctx.attackerStatus
  });
  const kDef = computeKBreakdown({
    unitType: defender.unitType,
    terrainType: ctx.terrainType,
    situation: ctx.defenderSituation,
    status: ctx.defenderStatus
  });

  const ra = 1;
  const rd = 1;
  const attackEff = attacker.attack * srAtt * attacker.condition * kAtt.kFinal * ra;
  const defenseEff = defender.defense * srDef * defender.condition * kDef.kFinal * rd;
  const r = defenseEff > 0 ? attackEff / defenseEff : Infinity;

  const pDef = clamp(0.05 * r, 0.02, 0.3);
  const pAtt = clamp(0.04 / r, 0.01, 0.25);

  const lossesDef = computeLosses(defender.members, pDef);
  const lossesAtt = computeLosses(attacker.members, pAtt);

  const defenderMembersAfter = Math.max(0, defender.members - lossesDef);

  const dCDef = clamp(0.1 * r, 0.03, 0.25);
  const dCAtt = clamp(0.08 / r, 0.02, 0.2);

  const defenderConditionAfter = clamp(defender.condition - dCDef, 0, 1);
  // Preview break evaluation uses updated defender SR/condition (mirrors resolver sans RNG).
  const srDefAfter = defender.maxMembers > 0 ? clamp(defenderMembersAfter / defender.maxMembers, 0, 1) : 0;
  const breakScore = (1 - srDefAfter) * 0.6 + (1 - defenderConditionAfter) * 0.4;
  const advantage = clamp(r >= 2.5 ? 1.0 : r - 1.1, 0.0, 1.0);
  const breakChance = clamp(breakScore * (0.15 + 0.55 * advantage), 0.0, 0.85);

  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerFactionId: attacker.factionId,
    defenderFactionId: defender.factionId,
    terrainType: ctx.terrainType,
    srAtt,
    srDef,
    kAtt,
    kDef,
    ra,
    rd,
    attackEff,
    defenseEff,
    r,
    pDef,
    pAtt,
    lossesDef,
    lossesAtt,
    dCDef,
    dCAtt,
    breakScore,
    advantage,
    breakChance
  };
};

export const resolveEngagement = (attacker: Army, defender: Army, ctx: EngagementContext): EngagementResult => {
  const seed = hashJoin32(ctx.turn, attacker.id, defender.id, 'ground');
  const rng = new RNG(seed);

  const srAtt = computeSR(attacker);
  const srDef = computeSR(defender);

  const kAtt = computeKBreakdown({
    unitType: attacker.unitType,
    terrainType: ctx.terrainType,
    situation: ctx.attackerSituation,
    status: ctx.attackerStatus
  });
  const kDef = computeKBreakdown({
    unitType: defender.unitType,
    terrainType: ctx.terrainType,
    situation: ctx.defenderSituation,
    status: ctx.defenderStatus
  });

  const epsilon = 0.08;
  const ra = rollTriangularCentered(rng, epsilon);
  const rd = rollTriangularCentered(rng, epsilon);

  const attackEff = attacker.attack * srAtt * attacker.condition * kAtt.kFinal * ra;
  const defenseEff = defender.defense * srDef * defender.condition * kDef.kFinal * rd;
  const r = defenseEff > 0 ? attackEff / defenseEff : Infinity;

  const pDef = clamp(0.05 * r, 0.02, 0.3);
  const pAtt = clamp(0.04 / r, 0.01, 0.25);

  const lossesDef = computeLosses(defender.members, pDef);
  const lossesAtt = computeLosses(attacker.members, pAtt);

  const defenderMembersAfter = Math.max(0, defender.members - lossesDef);
  const attackerMembersAfter = Math.max(0, attacker.members - lossesAtt);

  const dCDef = clamp(0.1 * r, 0.03, 0.25);
  const dCAtt = clamp(0.08 / r, 0.02, 0.2);

  const defenderConditionAfter = clamp(defender.condition - dCDef, 0, 1);
  const attackerConditionAfter = clamp(attacker.condition - dCAtt, 0, 1);

  // Break evaluation uses updated defender SR/condition per spec intent.
  const srDefAfter = defender.maxMembers > 0 ? clamp(defenderMembersAfter / defender.maxMembers, 0, 1) : 0;
  const breakScore = (1 - srDefAfter) * 0.6 + (1 - defenderConditionAfter) * 0.4;
  const advantage = clamp(r >= 2.5 ? 1.0 : r - 1.1, 0.0, 1.0);
  const breakChance = clamp(breakScore * (0.15 + 0.55 * advantage), 0.0, 0.85);

  const forcedBreak = defenderConditionAfter <= 0.2 || srDefAfter <= 0.15;
  const breakRoll = rng.next();
  const defenderBroke = forcedBreak || breakRoll < breakChance;

  const attackerAfter: Army = {
    ...attacker,
    members: attackerMembersAfter,
    condition: attackerConditionAfter
  };
  const defenderAfter: Army = {
    ...defender,
    members: defenderMembersAfter,
    condition: defenderConditionAfter
  };

  return {
    attackerId: attacker.id,
    defenderId: defender.id,
    attackerFactionId: attacker.factionId,
    defenderFactionId: defender.factionId,
    terrainType: ctx.terrainType,
    srAtt,
    srDef,
    kAtt,
    kDef,
    ra,
    rd,
    attackEff,
    defenseEff,
    r,
    pDef,
    pAtt,
    lossesDef,
    lossesAtt,
    dCDef,
    dCAtt,
    breakScore,
    advantage,
    breakChance,
    breakRoll,
    defenderBroke,
    attackerAfter,
    defenderAfter
  };
};

