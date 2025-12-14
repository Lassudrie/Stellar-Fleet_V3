
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
  let closestSystem: StarSystem | null = null;
  let minDistSq = Infinity;

  // 1. Find the dominant system (Closest one)
  for (const sys of systems) {
    const d = distSq(position, sys.position);
    if (d < minDistSq) {
      minDistSq = d;
      closestSystem = sys;
    }
  }

  // 2. Validation
  if (!closestSystem) return null;

  // Check Range Condition
  if (minDistSq > TERRITORY_RADIUS_SQ) {
      return null; // Too far from any system (Deep Space)
  }

  // If closest system has no owner, it's neutral territory
  if (!closestSystem.ownerFactionId) {
      return null;
  }

  // 3. Return Owner
  // Since we found the STRICTLY closest system, we satisfy the Voronoi condition automatically.
  // (If point P is closer to System A than System B, P is in A's Voronoi cell).
  return closestSystem.ownerFactionId;
};
