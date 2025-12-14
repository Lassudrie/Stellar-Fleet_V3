import { GameState, ArmyState } from '../../types';
import { findNearestSystem } from '../world';
import { ORBIT_RADIUS } from '../../data/static';
import { distSq } from '../math/vec3';

export function embarkTroopsCommand(
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

  // Get armies in the system
  const systemArmies = world.armies.filter(
    a => a.containerId === currentSystem.id && a.state === ArmyState.DEPLOYED
  );

  const embarkedArmyIds = fleet.embarkedArmyIds || [];
  const updatedArmies: typeof world.armies = [];
  const updatedFleets: typeof world.fleets = [];

  // Update armies and track which ones were embarked
  const newEmbarkedIds: string[] = [...embarkedArmyIds];
  for (const army of world.armies) {
    if (armyIds.includes(army.id)) {
      const systemArmy = systemArmies.find(a => a.id === army.id);
      if (systemArmy && !army.embarkedFleetId && army.factionId === fleet.factionId) {
        updatedArmies.push({
          ...army,
          embarkedFleetId: fleet.id,
          state: ArmyState.EMBARKED,
          containerId: fleet.id
        });
        if (!newEmbarkedIds.includes(army.id)) {
          newEmbarkedIds.push(army.id);
        }
        continue;
      }
    }
    updatedArmies.push(army);
  }

  // Update fleet
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
