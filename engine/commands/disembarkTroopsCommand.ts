import { GameState, ArmyState } from '../../types';
import { findNearestSystem } from '../world';
import { ORBIT_RADIUS } from '../../data/static';
import { distSq } from '../math/vec3';

export function disembarkTroopsCommand(
  world: GameState,
  fleetId: string,
  armyIds: string[]
): GameState {
  const fleet = world.fleets.find(f => f.id === fleetId);
  if (!fleet) return world;

  // Determine current system
  const currentSystem = findNearestSystem(world.systems, fleet.position);
  if (!currentSystem) return world;

  // Check if fleet is in orbit
  const orbitThresholdSq = (ORBIT_RADIUS * 3) ** 2;
  if (distSq(fleet.position, currentSystem.position) > orbitThresholdSq) return world;

  // Check if system is allied
  if (currentSystem.ownerFactionId !== fleet.factionId) return world;

  const embarkedArmyIds = fleet.embarkedArmyIds || [];
  const updatedArmies: typeof world.armies = [];
  const updatedFleets: typeof world.fleets = [];

  // Update armies
  for (const army of world.armies) {
    if (armyIds.includes(army.id) && army.embarkedFleetId === fleet.id) {
      updatedArmies.push({
        ...army,
        embarkedFleetId: undefined,
        state: ArmyState.DEPLOYED,
        containerId: currentSystem.id
      });
    } else {
      updatedArmies.push(army);
    }
  }

  // Update fleet
  const newEmbarkedIds = embarkedArmyIds.filter(id => !armyIds.includes(id));
  for (const f of world.fleets) {
    if (f.id === fleetId) {
      updatedFleets.push({
        ...f,
        embarkedArmyIds: newEmbarkedIds,
        currentSystemId: currentSystem.id
      });
    } else {
      updatedFleets.push(f);
    }
  }

  return {
    ...world,
    fleets: updatedFleets,
    armies: updatedArmies
  };
}
