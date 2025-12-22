import { Fleet, ShipType } from '../../shared/types';
import { MAX_HYPERJUMP_DISTANCE_LY, SHIP_STATS } from '../../content/data/static';

const getFuelConsumption = (type: ShipType): number => SHIP_STATS[type]?.fuelConsumptionPerLy ?? 0;
const getFuelCapacity = (type: ShipType): number => SHIP_STATS[type]?.fuelCapacity ?? 0;

export const computeShipJumpCost = (type: ShipType, distanceLy: number): number => {
  const consumption = getFuelConsumption(type);
  return consumption * distanceLy;
};

export const getFleetMaxReachLy = (fleet: Fleet): number => {
  if (fleet.ships.length === 0) return 0;

  return fleet.ships.reduce((reach, ship) => {
    const consumption = getFuelConsumption(ship.type);
    if (consumption <= 0) return reach;
    const shipReach = ship.fuel / consumption;
    return Math.min(reach, shipReach);
  }, MAX_HYPERJUMP_DISTANCE_LY);
};

export const canFleetPayJump = (fleet: Fleet, distanceLy: number): boolean => {
  return fleet.ships.every(ship => {
    const cost = computeShipJumpCost(ship.type, distanceLy);
    return ship.fuel >= cost;
  });
};

export const applyJumpFuelDebit = (fleet: Fleet, distanceLy: number): Fleet => {
  if (distanceLy <= 0) return fleet;

  return {
    ...fleet,
    ships: fleet.ships.map(ship => {
      const cost = computeShipJumpCost(ship.type, distanceLy);
      const updatedFuel = Math.max(0, ship.fuel - cost);
      const capacity = getFuelCapacity(ship.type);
      const clampedFuel = Math.min(updatedFuel, capacity || updatedFuel);

      return {
        ...ship,
        fuel: clampedFuel
      };
    })
  };
};
