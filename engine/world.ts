
import { GameState, StarSystem, Fleet, FactionId, ShipType, ShipEntity } from '../types';
import { SENSOR_RANGE, SHIP_STATS } from '../data/static';
import { RNG } from './rng';
import { Vec3, distSq } from './math/vec3';

// --- QUERIES ---

export const getSystemById = (systems: StarSystem[], id: string): StarSystem | undefined => {
  return systems.find(s => s.id === id);
};

export const getDistanceSquared = (a: Vec3, b: Vec3): number => {
  return distSq(a, b);
};

export const getFleetsForFaction = (fleets: Fleet[], factionId: FactionId): Fleet[] => {
  return fleets.filter(f => f.factionId === factionId);
};

export const getFleetsAtSystem = (fleets: Fleet[], systemPosition: Vec3, threshold = 2.0): Fleet[] => {
  return fleets.filter(f => distSq(f.position, systemPosition) < threshold * threshold);
};

export const findNearestSystem = (systems: StarSystem[], position: Vec3): StarSystem | null => {
  let nearest: StarSystem | null = null;
  let minD = Infinity;

  for (const sys of systems) {
    const d = distSq(position, sys.position);
    // WHY: Strict determinism requirement.
    // If distances are numerically identical (unlikely with floats but possible),
    // use system ID as a tie-breaker to ensure consistent results across all runs.
    if (d < minD || (d === minD && nearest && sys.id < nearest.id)) {
      minD = d;
      nearest = sys;
    }
  }
  return nearest;
};

// --- STRATEGIC ANALYSIS ---

export const getVisibleEnemies = (myFleet: Fleet, allFleets: Fleet[]): Fleet[] => {
  const visible: Fleet[] = [];
  const sensorSq = SENSOR_RANGE * SENSOR_RANGE;

  for (const other of allFleets) {
    if (other.factionId === myFleet.factionId) continue;
    if (distSq(myFleet.position, other.position) < sensorSq) {
      visible.push(other);
    }
  }
  return visible;
};

// V1 Power Calculation: Robust estimation including HP, DPS and Burst capability
export const calculateFleetPower = (fleet: Fleet): number => {
  if (!fleet.ships) return 0;
  return fleet.ships.reduce((sum, ship) => {
    if (!ship || !ship.type || !SHIP_STATS[ship.type]) return sum;
    const s = SHIP_STATS[ship.type];
    // Heuristic: Sustainability (HP) + DPS + Burst Potential (Missiles/Torps)
    return sum + (s.maxHp / 10) + (s.damage * 2) + (s.missileStock * 10) + (s.torpedoStock * 20);
  }, 0);
};

// --- UTILITIES ---

/**
 * Creates a ship using the provided RNG for ID generation.
 */
export const createShip = (type: ShipType, rng: RNG): ShipEntity => {
  const stats = SHIP_STATS[type];
  return {
    id: rng.id('ship'),
    type,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    carriedArmyId: null // Default: No army loaded
  };
};
