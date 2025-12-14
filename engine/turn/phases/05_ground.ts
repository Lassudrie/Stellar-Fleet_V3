import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { resolveGroundConflict } from '../../conquest';

export const phaseGround = (state: GameState, ctx: TurnContext): GameState => {
  let nextState = state;
  const newLogs = [...state.logs];

  // Faction color map for visual ownership tinting
  const factionColorById = new Map<string, string>(
    (state.factions || []).map(f => [f.id, f.color])
  );

  // 1) Resolve ground conflicts in deterministic order
  const sortedSystems = [...state.systems].sort((a, b) => a.id.localeCompare(b.id));
  const systemUpdates = new Map<string, any>();
  const armiesToRemove = new Set<string>();

  for (const system of sortedSystems) {
    const result = resolveGroundConflict(system, nextState);
    if (!result) continue;

    newLogs.push({
      id: ctx.rng.id('log'),
      day: nextState.day,
      text: result.logEntry,
      type: 'combat'
    });

    if (result.conquestOccurred && result.winnerFactionId && result.winnerFactionId !== 'draw') {
      const newOwnerId = result.winnerFactionId;
      const newColor = factionColorById.get(newOwnerId) || system.color;

      systemUpdates.set(system.id, {
        ...system,
        ownerFactionId: newOwnerId,
        color: newColor,
        captureTurn: nextState.day
      });
    }

    result.armiesDestroyed.forEach(armyId => armiesToRemove.add(armyId));
  }

  // 2) Apply system updates
  if (systemUpdates.size > 0) {
    nextState = {
      ...nextState,
      systems: nextState.systems.map(sys => systemUpdates.get(sys.id) || sys)
    };
  }

  // 3) Remove destroyed armies
  if (armiesToRemove.size > 0) {
    nextState = {
      ...nextState,
      armies: nextState.armies.filter(army => !armiesToRemove.has(army.id))
    };
  }

  // 4) Return updated state with logs
  return {
    ...nextState,
    logs: newLogs
  };
};
