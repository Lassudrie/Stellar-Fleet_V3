import type { Army, GameState, HexCoord } from '../../shared/types';
import { GROUND_UNIT_STATS } from '../../content/data/groundUnits';
import { generateSurfaceMapForState } from '../planetSurface/access';
import { isPassable } from '../planetSurface/validation';
import { deriveTerrainType, MOVE_COST } from './terrain';
import { clamp } from './utils';
import { findPathWithCost } from './pathfinding';
import type { ZocSnapshot } from './zoc';
import { isInEnemyZoc } from './zoc';

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
      moved: false, from, to: from, steps: 0, mpEff, mpUsedCenti: 0, used75pct: false, fatigueDelta: 0, touchedCost3: false, updatedArmy: army
    };
  }
  const tile = map.tiles[to.r * w + to.q];
  if (!tile || !isPassable(tile.biome)) {
    return {
      moved: false, from, to: from, steps: 0, mpEff, mpUsedCenti: 0, used75pct: false, fatigueDelta: 0, touchedCost3: false, updatedArmy: army
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
    isBlocked: (c) => isOccupied(c),
    stepCostCenti
  });

  if (!pathResult || pathResult.path.length <= 1) {
    return {
      moved: false, from, to: from, steps: 0, mpEff, mpUsedCenti: 0, used75pct: false, fatigueDelta: 0, touchedCost3: false, updatedArmy: army
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

