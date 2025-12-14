import { Fleet } from '../../types';
import { BASE_FLEET_SPEED, SHIP_STATS } from '../../data/static';

/**
 * Calculates the movement speed of a fleet per turn.
 * Rule: A fleet moves as fast as its slowest ship.
 * Formula: BASE_FLEET_SPEED * min(ship.speedModifier)
 */
export const getFleetSpeed = (fleet: Fleet): number => {
  if (!fleet.ships || fleet.ships.length === 0) return BASE_FLEET_SPEED;

  let minSpeedModifier = Infinity;

  for (const ship of fleet.ships) {
    if (!ship || !ship.type) continue; // Defensive check for undefined ships

    const stats = SHIP_STATS[ship.type];
    if (stats && stats.speed < minSpeedModifier) {
      minSpeedModifier = stats.speed;
    }
  }

  // Fallback to 1.0 modifier if logic fails (e.g. unknown ship type), though unlikely
  if (minSpeedModifier === Infinity) minSpeedModifier = 1.0;

  return BASE_FLEET_SPEED * minSpeedModifier;
};