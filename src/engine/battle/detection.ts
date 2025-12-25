
import { GameState, Battle, FleetState } from '../../shared/types';
import { RNG } from '../rng';
import { CAPTURE_RANGE_SQ } from '../../content/data/static';
import { distSq } from '../math/vec3';
import { sorted } from '../../shared/sorting';

/**
 * Scans the galaxy for contested systems.
 * Rule: A battle starts if at least two DIFFERENT factions have fleets within range.
 */
export const detectNewBattles = (state: GameState, rng: RNG, turn: number): Battle[] => {
  const newBattles: Battle[] = [];

  const activeBattleSystemIds = new Set(
    state.battles
      .filter(b => b.status !== 'resolved')
      .map(b => b.systemId)
  );

  const activeSystems = state.systems.filter(system => !activeBattleSystemIds.has(system.id));
  const activeSystemsById = new Map(activeSystems.map(system => [system.id, system]));

  const engageableFleets = state.fleets.filter(fleet => {
    if (fleet.state === FleetState.COMBAT) return false;
    if (fleet.ships.length === 0) return false;
    return true;
  });
  const engageableFleetsById = new Map(engageableFleets.map(fleet => [fleet.id, fleet]));

  const fleetAssignments = new Map<string, string>();

  engageableFleets.forEach(fleet => {
    let nearestSystemId: string | null = null;
    let nearestDistanceSq = Number.POSITIVE_INFINITY;

    activeSystems.forEach(system => {
      const distanceSq = distSq(fleet.position, system.position);
      if (distanceSq > CAPTURE_RANGE_SQ) return;
      if (distanceSq < nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
        nearestSystemId = system.id;
      }
    });

    if (nearestSystemId) {
      fleetAssignments.set(fleet.id, nearestSystemId);
    }
  });

  const systemAssignments = new Map<string, string[]>();

  fleetAssignments.forEach((systemId, fleetId) => {
    const fleets = systemAssignments.get(systemId) ?? [];
    fleets.push(fleetId);
    systemAssignments.set(systemId, fleets);
  });

  systemAssignments.forEach((fleetIds, systemId) => {
    const system = activeSystemsById.get(systemId);
    if (!system) return;

    const fleetsInSystem = fleetIds
      .map(fleetId => engageableFleetsById.get(fleetId))
      .filter((fleet): fleet is NonNullable<typeof fleet> => Boolean(fleet))
      .filter(fleet => fleet.state !== FleetState.COMBAT && fleet.ships.length > 0);

    const presentFactionIds = new Set<string>();
    fleetsInSystem.forEach(fleet => presentFactionIds.add(fleet.factionId));

    if (presentFactionIds.size > 1) {
      const battleId = rng.id('battle');
      const involvedFleetIds = sorted([...fleetIds]);

      const battle: Battle = {
        id: battleId,
        systemId: system.id,
        turnCreated: turn,
        status: 'scheduled',
        involvedFleetIds,
        logs: [`Battle detected at ${system.name}. Factions involved: ${Array.from(presentFactionIds).join(', ')}.`]
      };

      newBattles.push(battle);
    }
  });

  return newBattles;
};

export const pruneBattles = (battles: Battle[], currentTurn: number): Battle[] => {
  const KEEP_HISTORY = 5;
  return battles.filter(b => {
    if (b.status !== 'resolved') return true;
    const resolutionTurn = b.turnResolved ?? b.turnCreated ?? currentTurn;
    return resolutionTurn >= currentTurn - KEEP_HISTORY;
  });
};
