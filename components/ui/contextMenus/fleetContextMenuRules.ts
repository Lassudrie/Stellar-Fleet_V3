import { GameState, Fleet, ArmyState, ShipType } from '../../../types';
import { findNearestSystem } from '../../../engine/world';
import { distSq } from '../../../engine/math/vec3';
import { ORBIT_RADIUS } from '../../../data/static';

const ORBIT_THRESHOLD_SQ = (ORBIT_RADIUS * 3) * (ORBIT_RADIUS * 3);

const getCurrentSystem = (world: GameState, fleet: Fleet) => {
  if (fleet.currentSystemId) {
    const explicit = world.systems.find(s => s.id === fleet.currentSystemId);
    if (explicit) return explicit;
  }
  return findNearestSystem(world.systems, fleet.position);
};

export const canEmbarkTroops = (world: GameState, fleet: Fleet): boolean => {
  const currentSystem = getCurrentSystem(world, fleet);
  if (!currentSystem) return false;

  const inOrbit = distSq(fleet.position, currentSystem.position) <= ORBIT_THRESHOLD_SQ;
  if (!inOrbit) return false;

  const hasEmptyTransport = fleet.ships.some(
    s => s.type === ShipType.TROOP_TRANSPORT && !s.carriedArmyId
  );
  if (!hasEmptyTransport) return false;

  const hasEligibleArmy = world.armies.some(
    a =>
      a.state === ArmyState.DEPLOYED &&
      a.containerId === currentSystem.id &&
      a.factionId === fleet.factionId
  );

  return hasEligibleArmy;
};

export const canDisembarkTroops = (world: GameState, fleet: Fleet): boolean => {
  const currentSystem = getCurrentSystem(world, fleet);
  if (!currentSystem) return false;

  const inOrbit = distSq(fleet.position, currentSystem.position) <= ORBIT_THRESHOLD_SQ;
  if (!inOrbit) return false;

  // Disembark is only permitted in allied systems.
  if (currentSystem.ownerFactionId !== fleet.factionId) return false;

  const hasLoadedTransport = fleet.ships.some(
    s => s.type === ShipType.TROOP_TRANSPORT && !!s.carriedArmyId
  );

  return hasLoadedTransport;
};
