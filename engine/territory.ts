
import { StarSystem, FactionId } from '../types';
import { TERRITORY_RADIUS } from '../data/static';
import { Vec3, distSq } from './math/vec3';

// Pre-calculate squared radius to avoid Sqrt operations in hot loops
const TERRITORY_RADIUS_SQ = TERRITORY_RADIUS * TERRITORY_RADIUS;

/**
 * Determines which faction controls a specific point in space.
 * 
 * Rules:
 * 1. The point must be within TERRITORY_RADIUS of a system owned by the faction.
 * 2. The point must be closer to that owned system than to any system owned by another faction.
 *    (Voronoi principle: borders are equidistant points between systems).
 * 
 * @returns The Faction owning the territory, or null if neutral/contested space.
 */
export const getTerritoryOwner = (systems: StarSystem[], position: Vec3): FactionId | null => {
  // Only systems with an owner can exert influence
  const ownedSystems = systems.filter(system => system.ownerFactionId !== null);

  if (ownedSystems.length === 0) return null;

  // Sort to guarantee deterministic processing when distances tie
  const sortedSystems = [...ownedSystems].sort((a, b) => a.id.localeCompare(b.id));

  let closestSystem: StarSystem | null = null;
  let minDistSq = Infinity;
  let contested = false;

  // 1. Find the dominant system (closest one), while detecting contested ties
  for (const sys of sortedSystems) {
    const d = distSq(position, sys.position);
    if (d < minDistSq) {
      minDistSq = d;
      closestSystem = sys;
      contested = false;
    } else if (d === minDistSq && closestSystem && sys.ownerFactionId !== closestSystem.ownerFactionId) {
      contested = true;
    }
  }

  // 2. Validation
  if (!closestSystem) return null;

  // Check Range Condition
  if (minDistSq > TERRITORY_RADIUS_SQ) {
    return null; // Too far from any system (Deep Space)
  }

  if (contested) {
    return null; // Equal influence from different factions
  }

  // 3. Return Owner
  return closestSystem.ownerFactionId;
};
