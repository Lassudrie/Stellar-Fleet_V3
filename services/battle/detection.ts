
import { GameState, Battle, FactionId } from '../../types';
import { RNG } from '../../engine/rng';
import { CAPTURE_RANGE } from '../../data/static';
import { distSq } from '../../engine/math/vec3';

/**
 * Scans the galaxy for contested systems.
 * Rule: A battle starts if at least two DIFFERENT factions have fleets within range.
 */
export const detectNewBattles = (state: GameState, rng: RNG): Battle[] => {
  const newBattles: Battle[] = [];
  
  const activeBattleSystemIds = new Set(
    state.battles
      .filter(b => b.status !== 'resolved')
      .map(b => b.systemId)
  );

  state.systems.forEach(system => {
    if (activeBattleSystemIds.has(system.id)) return;

    // Find fleets in this system
    const fleetsInSystem = state.fleets.filter(f => 
      f.ships.length > 0 &&
      distSq(f.position, system.position) <= CAPTURE_RANGE * CAPTURE_RANGE
    );

    // Identify factions present
    const presentFactionIds = new Set<string>();
    fleetsInSystem.forEach(f => presentFactionIds.add(f.factionId));

    // If more than one faction is present, it's a battle
    if (presentFactionIds.size > 1) {
      // Create a new Battle
      const battleId = rng.id('battle');
      const involvedFleetIds = fleetsInSystem.map(f => f.id).sort();

      const battle: Battle = {
        id: battleId,
        systemId: system.id,
        turnCreated: state.day,
        status: 'scheduled',
        involvedFleetIds: involvedFleetIds,
        logs: [`Battle detected at ${system.name}. Factions involved: ${Array.from(presentFactionIds).join(', ')}.`]
      };

      newBattles.push(battle);
    }
  });

  return newBattles;
};

export const pruneBattles = (battles: Battle[], currentDay: number): Battle[] => {
  const KEEP_HISTORY = 5; 
  return battles.filter(b => {
    if (b.status !== 'resolved') return true;
    if (b.turnResolved === undefined) return false;
    return b.turnResolved >= currentDay - KEEP_HISTORY;
  });
};
