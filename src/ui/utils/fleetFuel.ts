import { MAX_HYPERJUMP_DISTANCE_LY, SHIP_STATS } from '../../content/data/static';
import { Fleet } from '../../shared/types';

export interface FleetFuelSummary {
  totalFuel: number;
  totalCapacity: number;
  cappedCurrentReach: number;
  cappedFullReach: number;
  fuelPercentage: number;
}

export const computeFleetFuelSummary = (fleet: Fleet): FleetFuelSummary => {
  let totalFuel = 0;
  let totalCapacity = 0;
  let currentReach = Infinity;
  let fullReach = Infinity;

  fleet.ships.forEach(ship => {
    const stats = SHIP_STATS[ship.type];
    if (!stats) return;
    totalFuel += ship.fuel;
    totalCapacity += stats.fuelCapacity;
    const consumption = stats.fuelConsumptionPerLy;
    if (consumption > 0) {
      currentReach = Math.min(currentReach, ship.fuel / consumption);
      fullReach = Math.min(fullReach, stats.fuelCapacity / consumption);
    }
  });

  if (!Number.isFinite(currentReach)) currentReach = 0;
  if (!Number.isFinite(fullReach)) fullReach = 0;

  const cappedCurrentReach = Math.min(currentReach, MAX_HYPERJUMP_DISTANCE_LY);
  const cappedFullReach = Math.min(fullReach, MAX_HYPERJUMP_DISTANCE_LY);
  const fuelPercentage = totalCapacity > 0 ? Math.min(100, Math.max(0, (totalFuel / totalCapacity) * 100)) : 0;

  return {
    totalFuel,
    totalCapacity,
    cappedCurrentReach,
    cappedFullReach,
    fuelPercentage
  };
};
