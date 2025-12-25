
import { GameState, FactionId, Fleet } from '../shared/types';
import { CAPTURE_RANGE_SQ, SENSOR_RANGE } from '../content/data/static';
import { buildTerritoryResolver } from './territory';
import { Vec3, distSq } from './math/vec3';

/**
 * Current limitations of the fog of war model:
 * - Visibility is purely range-based: no line-of-sight, obstacles, or sensor degradation.
 * - Knowledge is instantaneous and perfect once a rule triggers; no "last seen" memory.
 * - Territory checks still rely on system ownership borders, which remain expensive for dense maps.
 * - Systems become "observed" only through ownership or proximity; enemy actions cannot currently reveal themselves.
 */

export interface VisibilityContext {
  state: GameState;
  viewerFactionId: FactionId;
  viewerFleets: Fleet[];
  observedSystemIds: Set<string>;
  observedPositions: Vec3[];
  territoryResolver: (position: Vec3) => FactionId | null;
}

export interface FleetVisibilitySensor {
  id: string;
  /**
   * Returns true when the target fleet should be visible to the viewer.
   * Implementations should avoid mutating the input state.
   */
  isVisible: (fleet: Fleet, context: VisibilityContext) => boolean;
}

// Performance optimization: squared distances
const CAPTURE_SQ = CAPTURE_RANGE_SQ;
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
const DEFAULT_FLEET_SENSORS: FleetVisibilitySensor[] = [
  {
    id: 'ally-visibility',
    isVisible: (fleet, context) => fleet.factionId === context.viewerFactionId
  },
  {
    id: 'direct-sensor',
    isVisible: (fleet, context) => {
      for (const viewer of context.viewerFleets) {
        if (distSq(fleet.position, viewer.position) <= SENSOR_SQ) return true;
      }
      return false;
    }
  },
  {
    id: 'system-surveillance',
    isVisible: (fleet, context) => {
      for (const pos of context.observedPositions) {
        if (distSq(fleet.position, pos) <= CAPTURE_SQ) return true;
      }
      return false;
    }
  },
  {
    id: 'territory-surveillance',
    isVisible: (fleet, context) =>
      context.territoryResolver(fleet.position) === context.viewerFactionId
  }
];

const checkVisibility = (
  fleet: Fleet,
  context: VisibilityContext,
  sensors: FleetVisibilitySensor[]
): boolean => sensors.some(sensor => sensor.isVisible(fleet, context));

/**
 * Determines if a specific fleet is visible to the viewer.
 * Legacy wrapper for single-fleet checks.
 * WARNING: Less efficient than calling applyFogOfWar for batch processing.
 */
export const isFleetVisibleToViewer = (
  fleet: Fleet,
  state: GameState,
  viewerFactionId: FactionId,
  observedSystemIds: Set<string>,
  sensors: FleetVisibilitySensor[] = DEFAULT_FLEET_SENSORS
): boolean => {
  const context = buildVisibilityContext(state, viewerFactionId, observedSystemIds);
  return checkVisibility(fleet, context, sensors);
};

const buildVisibilityContext = (
  state: GameState,
  viewerFactionId: FactionId,
  observedSystemIds?: Set<string>
): VisibilityContext => {
  const viewerFleets = state.fleets.filter(f => f.factionId === viewerFactionId);
  const observedIds = observedSystemIds ?? getObservedSystemIds(state, viewerFactionId, viewerFleets);
  const observedPositions: Vec3[] = [];
  for (const sys of state.systems) {
    if (observedIds.has(sys.id)) observedPositions.push(sys.position);
  }
  const territoryResolver = buildTerritoryResolver(state.systems, state.day);

  return {
    state,
    viewerFactionId,
    viewerFleets,
    observedSystemIds: observedIds,
    observedPositions,
    territoryResolver
  };
};

/**
 * Returns a shallow copy of GameState with the 'fleets' array filtered
 * based on visibility rules for the viewer.
 * 
 * OPTIMIZED IMPLEMENTATION
 */
export const applyFogOfWar = (
  state: GameState,
  viewerFactionId: FactionId,
  sensors: FleetVisibilitySensor[] = DEFAULT_FLEET_SENSORS
): GameState => {
  const context = buildVisibilityContext(state, viewerFactionId);

  return {
    ...state,
    systems: state.systems,
    fleets: state.fleets.filter(fleet => checkVisibility(fleet, context, sensors))
  };
};

export const defaultFleetSensors = DEFAULT_FLEET_SENSORS;
