import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { sanitizeArmies } from '../../army';
import { pruneBattles } from '../../systems/battle/detection';

export const phaseCleanup = (state: GameState, ctx: TurnContext): GameState => {
  // 1) Prune old battles first (deterministic)
  const activeBattles = pruneBattles(state.battles, state.day);

  // 2) Sanitize armies (remove invalid references)
  const { armies: sanitizedArmies, logs: sanitizationLogs } = sanitizeArmies({
    ...state,
    battles: activeBattles
  });

  const newLogs = [...state.logs];

  for (const txt of sanitizationLogs) {
    newLogs.push({
      id: ctx.rng.id('log'),
      day: state.day,
      text: txt,
      type: 'info'
    });
  }

  // 3) Clear invalid ship->army links (ghost carriedArmyId)
  const validArmyIds = new Set(sanitizedArmies.map(a => a.id));
  let clearedLinks = 0;

  const cleanedFleets = state.fleets.map(fleet => {
    let changed = false;

    const ships = fleet.ships.map(ship => {
      if (ship.carriedArmyId && !validArmyIds.has(ship.carriedArmyId)) {
        changed = true;
        clearedLinks++;
        return { ...ship, carriedArmyId: null };
      }
      return ship;
    });

    return changed ? { ...fleet, ships } : fleet;
  });

  if (clearedLinks > 0) {
    newLogs.push({
      id: ctx.rng.id('log'),
      day: state.day,
      text: `[SYSTEM] Cleared ${clearedLinks} invalid carriedArmyId references from ships.`,
      type: 'info'
    });
  }

  // 4) Return updated state
  return {
    ...state,
    battles: activeBattles,
    armies: sanitizedArmies,
    fleets: cleanedFleets,
    logs: newLogs
  };
};
