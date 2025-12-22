import { CAPTURE_RANGE, CAPTURE_RANGE_SQ, ORBIT_PROXIMITY_RANGE_SQ } from '../content/data/static';
import { Fleet, FleetState, GameState, StarSystem } from '../shared/types';
import { Vec3, distSq } from './math/vec3';

/**
 * Returns whether the provided positions fall within the orbit interaction threshold.
 *
 * This wrapper avoids manual squared-distance comparisons, keeping gameplay and UI
 * aligned on the same proximity constant.
 */
export const isWithinOrbitProximity = (a: Vec3, b: Vec3): boolean =>
    distSq(a, b) <= ORBIT_PROXIMITY_RANGE_SQ;

/**
 * Checks if a fleet is close enough to interact with a system (e.g., load, unload, bombard).
 */
export const isFleetWithinOrbitProximity = (fleet: Fleet, system: StarSystem): boolean =>
    isWithinOrbitProximity(fleet.position, system.position);

/**
 * Checks if a fleet is both marked as orbiting and physically within the orbit proximity of a system.
 */
export const isFleetOrbitingSystem = (fleet: Fleet, system: StarSystem): boolean =>
    fleet.state === FleetState.ORBIT && isFleetWithinOrbitProximity(fleet, system);

/**
 * Determines whether two orbiting fleets share the same proximity envelope, preventing
 * distance drift from bypassing orbit-only actions.
 */
export const areFleetsSharingOrbit = (a: Fleet, b: Fleet): boolean =>
    a.state === FleetState.ORBIT &&
    b.state === FleetState.ORBIT &&
    isWithinOrbitProximity(a.position, b.position);

/**
 * Detects whether multiple factions with active ships are within capture range of a system.
 *
 * The threshold is derived from ORBIT_RADIUS * 3 (see CAPTURE_RANGE), keeping UI and gameplay rules aligned.
 */
export const isOrbitContested = (system: StarSystem, fleetsOrState: Fleet[] | GameState): boolean => {
    const fleets = Array.isArray(fleetsOrState) ? fleetsOrState : fleetsOrState.fleets;
    const captureSq = CAPTURE_RANGE_SQ;
    const factionsInRange = new Set(
        fleets
            .filter(fleet => fleet.ships.length > 0 && distSq(fleet.position, system.position) <= captureSq)
            .map(fleet => fleet.factionId)
    );

    return factionsInRange.size >= 2;
};
