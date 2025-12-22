import { Fleet, ShipType, StarSystem, FleetState } from '../../shared/types';
import { MAX_HYPERJUMP_DISTANCE_LY, SHIP_STATS } from '../../content/data/static';
import { dist } from '../math/vec3';
import { getOrbitingSystem } from '../orbit';

const FUEL_PRECISION = 0.01;
const roundFuel = (value: number): number => Math.max(0, Math.round(value / FUEL_PRECISION) * FUEL_PRECISION);
const ceilFuel = (value: number): number => Math.max(0, Math.ceil(value / FUEL_PRECISION) * FUEL_PRECISION);

const getFuelConsumption = (type: ShipType): number => SHIP_STATS[type]?.fuelConsumptionPerLy ?? 0;
const getFuelCapacity = (type: ShipType): number => SHIP_STATS[type]?.fuelCapacity ?? 0;

export const computeShipJumpCost = (type: ShipType, distanceLy: number): number => {
  const consumption = getFuelConsumption(type);
  return ceilFuel(consumption * distanceLy);
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
    return roundFuel(ship.fuel) >= cost;
  });
};

export const applyJumpFuelDebit = (fleet: Fleet, distanceLy: number): Fleet => {
  if (distanceLy <= 0) return fleet;

  return {
    ...fleet,
    ships: fleet.ships.map(ship => {
      const cost = computeShipJumpCost(ship.type, distanceLy);
      const updatedFuel = roundFuel(ship.fuel - cost);
      const capacity = getFuelCapacity(ship.type);
      const clampedFuel = Math.min(updatedFuel, capacity || updatedFuel);

      return {
        ...ship,
        fuel: clampedFuel
      };
    })
  };
};

export const validateAndDebitJumpOrFail = (
  fleet: Fleet,
  targetSystem: StarSystem,
  systems: StarSystem[]
): { ok: true; updatedFleet: Fleet; distanceLy: number; alreadyEnRoute: boolean } | { ok: false; error: string } => {
  const alreadyEnRoute = fleet.state === FleetState.MOVING && fleet.targetSystemId === targetSystem.id;

  if (alreadyEnRoute) {
    return { ok: true, updatedFleet: fleet, distanceLy: 0, alreadyEnRoute: true };
  }

  const sourceSystem = getOrbitingSystem(fleet, systems);
  if (!sourceSystem) return { ok: false, error: 'Fleet must be orbiting a system to move.' };

  const distanceLy = dist(sourceSystem.position, targetSystem.position);
  if (distanceLy > MAX_HYPERJUMP_DISTANCE_LY) {
    return { ok: false, error: 'Destination is beyond maximum jump distance.' };
  }
  if (!canFleetPayJump(fleet, distanceLy)) {
    return { ok: false, error: 'Insufficient fuel for jump.' };
  }

  return {
    ok: true,
    updatedFleet: applyJumpFuelDebit(fleet, distanceLy),
    distanceLy,
    alreadyEnRoute: false
  };
};

export const quantizeFuel = (value: number): number => roundFuel(value);
