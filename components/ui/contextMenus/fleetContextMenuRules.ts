import { Fleet, GameState } from '../../../types';
import { findNearestSystem } from '../../../engine/world';
import { ORBIT_RADIUS } from '../../../data/static';
import { distSq } from '../../../engine/math/vec3';
import { ArmyState } from '../../../types';

export function canEmbarkTroops(fleet: Fleet, world: GameState): boolean {
  if (!fleet.currentSystemId) {
    // Try to determine current system
    const currentSystem = findNearestSystem(world.systems, fleet.position);
    if (!currentSystem) return false;
    
    const orbitThresholdSq = (ORBIT_RADIUS * 3) ** 2;
    if (distSq(fleet.position, currentSystem.position) > orbitThresholdSq) return false;
  } else {
    const system = world.systems.find(s => s.id === fleet.currentSystemId);
    if (!system) return false;
  }

  // Check if there are any deployable armies in the system
  const systemId = fleet.currentSystemId || findNearestSystem(world.systems, fleet.position)?.id;
  if (!systemId) return false;

  const systemArmies = world.armies.filter(
    a => a.containerId === systemId && 
         a.state === ArmyState.DEPLOYED &&
         a.factionId === fleet.factionId &&
         !a.embarkedFleetId
  );

  return systemArmies.length > 0;
}

export function canDisembarkTroops(fleet: Fleet, world: GameState): boolean {
  if (!fleet.currentSystemId) {
    // Try to determine current system
    const currentSystem = findNearestSystem(world.systems, fleet.position);
    if (!currentSystem) return false;
    
    const orbitThresholdSq = (ORBIT_RADIUS * 3) ** 2;
    if (distSq(fleet.position, currentSystem.position) > orbitThresholdSq) return false;
  } else {
    const system = world.systems.find(s => s.id === fleet.currentSystemId);
    if (!system) return false;
  }

  // Check if fleet has embarked armies
  if (!fleet.embarkedArmyIds || fleet.embarkedArmyIds.length === 0) return false;

  // Check if current system is allied
  const systemId = fleet.currentSystemId || findNearestSystem(world.systems, fleet.position)?.id;
  if (!systemId) return false;

  const system = world.systems.find(s => s.id === systemId);
  if (!system) return false;

  return system.ownerFactionId === fleet.factionId;
}
