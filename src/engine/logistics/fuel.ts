import { Fleet, ShipType, StarSystem, FleetState, GameplayRules } from '../../shared/types';
import { MAX_HYPERJUMP_DISTANCE_LY, SHIP_STATS } from '../../content/data/static';
import { dist } from '../math/vec3';
import { getOrbitingSystem } from '../orbit';

export interface FuelShortageDetail {
  shipId: string;
  shipType: ShipType;
  missingFuel: number;
}

export interface FuelShortageError {
  code: 'INSUFFICIENT_FUEL';
  message: string;
  shortages: FuelShortageDetail[];
}

const FUEL_PRECISION = 0.01;
const roundFuel = (value: number): number => Math.max(0, Math.round(value / FUEL_PRECISION) * FUEL_PRECISION);
const ceilFuel = (value: number): number => Math.max(0, Math.ceil(value / FUEL_PRECISION) * FUEL_PRECISION);

type FuelRules = Pick<GameplayRules, 'unlimitedFuel'> | undefined;

const getFuelConsumption = (type: ShipType): number => SHIP_STATS[type]?.fuelConsumptionPerLy ?? 0;
const getFuelCapacity = (type: ShipType): number => SHIP_STATS[type]?.fuelCapacity ?? 0;
const hasUnlimitedFuel = (rules?: FuelRules): boolean => Boolean(rules?.unlimitedFuel);

const formatFuelShortageMessage = (shortages: FuelShortageDetail[], distanceLy: number): string => {
  const detail = shortages
    .map(shortage => `Ship ${shortage.shipId} (${shortage.shipType}) is short by ${shortage.missingFuel.toFixed(2)}`)
    .join('; ');
  return `Insufficient fuel for jump (${distanceLy.toFixed(2)} ly): ${detail}.`;
};

const computeFuelShortages = (fleet: Fleet, distanceLy: number, rules?: FuelRules): FuelShortageDetail[] => {
  if (hasUnlimitedFuel(rules)) return [];

  return fleet.ships
    .map(ship => {
      const cost = computeShipJumpCost(ship.type, distanceLy);
      const missing = roundFuel(cost - roundFuel(ship.fuel));
      if (missing <= 0) return null;
      return {
        shipId: ship.id,
        shipType: ship.type,
        missingFuel: missing
      };
    })
    .filter((shortage): shortage is FuelShortageDetail => Boolean(shortage));
};

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

export const canFleetPayJump = (fleet: Fleet, distanceLy: number, rules?: FuelRules): boolean => {
  if (hasUnlimitedFuel(rules)) return true;
  return fleet.ships.every(ship => {
    const cost = computeShipJumpCost(ship.type, distanceLy);
    return roundFuel(ship.fuel) >= cost;
  });
};

export const applyJumpFuelDebit = (fleet: Fleet, distanceLy: number, rules?: FuelRules): Fleet => {
  if (distanceLy <= 0 || hasUnlimitedFuel(rules)) return fleet;

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
  systems: StarSystem[],
  rules?: FuelRules
):
  | { ok: true; updatedFleet: Fleet; distanceLy: number; alreadyEnRoute: boolean }
  | { ok: false; error: string | FuelShortageError } => {
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
  const shortages = computeFuelShortages(fleet, distanceLy, rules);
  if (shortages.length > 0) {
    return {
      ok: false,
      error: {
        code: 'INSUFFICIENT_FUEL',
        message: formatFuelShortageMessage(shortages, distanceLy),
        shortages
      }
    };
  }

  return {
    ok: true,
    updatedFleet: applyJumpFuelDebit(fleet, distanceLy, rules),
    distanceLy,
    alreadyEnRoute: false
  };
};

export const quantizeFuel = (value: number): number => roundFuel(value);
