import type { Army, GameState, HexCoord } from '../../shared/types';
import { generateSurfaceMapForState } from '../planetSurface/access';
import { neighborsAxial } from '../planetSurface/hex';
import { isPassable } from '../planetSurface/validation';
import type { ZocSnapshot } from './zoc';
import { isInEnemyZoc } from './zoc';
import { clamp } from './utils';

export type BreakOutcome =
  | { type: 'retreat'; to: HexCoord }
  | { type: 'overrun' };

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

  const compare = (a: { coord: HexCoord; inEnemy: boolean; pressure: number }, b: { coord: HexCoord; inEnemy: boolean; pressure: number }) => {
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

