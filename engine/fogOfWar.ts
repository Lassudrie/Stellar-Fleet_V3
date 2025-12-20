
import { GameState, FactionId, Fleet } from '../types';
import { CAPTURE_RANGE, SENSOR_RANGE } from '../data/static';
import { getTerritoryOwner } from './territory';
import { Vec3, distSq } from './math/vec3';

// Performance optimization: squared distances
const CAPTURE_SQ = CAPTURE_RANGE * CAPTURE_RANGE;
const SENSOR_SQ = SENSOR_RANGE * SENSOR_RANGE;

/**
 * Returns a Set of system IDs that are currently "observed" by the viewer.
 * A system is observed if:
 * 1. It is owned by the viewer.
 * 2. A viewer's fleet is within CAPTURE_RANGE of the system.
 * 
 * OPTIMIZATION: Accepts optional preCalculatedViewerFleets to avoid re-filtering state.fleets.
 */
export const getObservedSystemIds = (
  state: GameState, 
  viewerFactionId: FactionId,
  preCalculatedViewerFleets?: Fleet[]
): Set<string> => {
  const observed = new Set<string>();
  
  // WHY: Avoid allocating a new array if the caller already has one.
  const viewerFleets = preCalculatedViewerFleets || state.fleets.filter(f => f.factionId === viewerFactionId);

  for (const sys of state.systems) {
    // Rule 1: Ownership
    if (sys.ownerFactionId === viewerFactionId) {
      observed.add(sys.id);
      continue;
    }

    // Rule 2: Viewer Fleet Presence
    // We reuse CAPTURE_RANGE as the "System Visibility Range"
    for (const fleet of viewerFleets) {
      if (distSq(fleet.position, sys.position) <= CAPTURE_SQ) {
        observed.add(sys.id);
        break; // System is observed, no need to check other fleets for this system
      }
    }
  }
  return observed;
};

/**
 * INTERNAL OPTIMIZED CHECKER
 * Uses pre-calculated lists (viewerFleets, observedPositions) to avoid 
 * O(N) lookups inside the hot loop.
 */
const checkVisibility = (
  fleet: Fleet,
  state: GameState,
  viewerFactionId: FactionId,
  viewerFleets: Fleet[],
  observedPositions: Vec3[]
): boolean => {
  // 1. Allies always visible
  if (fleet.factionId === viewerFactionId) return true;

  // 2. Direct Sensor Range (Ship-to-Ship)
  // Essential for deep space encounters away from systems
  for (const viewer of viewerFleets) {
    if (distSq(fleet.position, viewer.position) <= SENSOR_SQ) {
      return true;
    }
  }

  // 3. System Surveillance
  // Visible if within range of an observed system
  // WHY: Iterating pre-fetched positions is O(M) vs O(M * S) using systems.find()
  for (const pos of observedPositions) {
    if (distSq(fleet.position, pos) <= CAPTURE_SQ) {
      return true;
    }
  }

  // 4. Territorial Surveillance
  // Visible if inside the viewer's controlled space (borders)
  // Note: getTerritoryOwner scans systems, so this remains the most expensive check,
  // but it is only reached if previous checks fail.
  const territoryOwner = getTerritoryOwner(state.systems, fleet.position);
  if (territoryOwner === viewerFactionId) {
      return true;
  }

  return false;
};

/**
 * Determines if a specific fleet is visible to the viewer.
 * Legacy wrapper for single-fleet checks.
 * WARNING: Less efficient than calling applyFogOfWar for batch processing.
 */
export const isFleetVisibleToViewer = (
  fleet: Fleet, 
  state: GameState, 
  viewerFactionId: FactionId, 
  observedSystemIds: Set<string>
): boolean => {
  // Reconstruct necessary optimization structures on the fly
  const viewerFleets = state.fleets.filter(f => f.factionId === viewerFactionId);
  const observedPositions: Vec3[] = [];
  for (const sys of state.systems) {
      if (observedSystemIds.has(sys.id)) observedPositions.push(sys.position);
  }

  return checkVisibility(fleet, state, viewerFactionId, viewerFleets, observedPositions);
};

/**
 * Returns a shallow copy of GameState with the 'fleets' array filtered
 * based on visibility rules for the viewer.
 * 
 * OPTIMIZED IMPLEMENTATION
 */
export const applyFogOfWar = (state: GameState, viewerFactionId: FactionId): GameState => {
  // 1. Pre-calculate Viewer Fleets (O(N))
  // Done once per frame instead of for every target fleet
  const viewerFleets = state.fleets.filter(f => f.factionId === viewerFactionId);

  // 2. Get Observed IDs (O(S * F_view))
  const observedIds = getObservedSystemIds(state, viewerFactionId, viewerFleets);

  // 3. Pre-calculate Observed Positions (O(S))
  // WHY: Extracting positions now prevents doing `state.systems.find` 
  // (which is O(S)) inside the fleet loop (which is O(N)), avoiding O(N*S) complexity.
  // We use a simple array iteration for distance checks.
  const observedPositions: Vec3[] = [];
  for (const sys of state.systems) {
      if (observedIds.has(sys.id)) {
          observedPositions.push(sys.position);
      }
  }

  // 4. Filter Fleets (O(N_total * (F_view + S_observed)))
  // The logic is now heavily optimized for the batch operation.
  return {
    ...state,
    systems: state.systems,
    fleets: state.fleets.filter(f =>
      checkVisibility(f, state, viewerFactionId, viewerFleets, observedPositions)
    )
  };
};
