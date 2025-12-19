import { CAPTURE_RANGE } from '../data/static';
import { Fleet, GameState, StarSystem } from '../types';
import { distSq } from './math/vec3';

/**
 * Detects whether multiple factions with active ships are within capture range of a system.
 *
 * The threshold is derived from ORBIT_RADIUS * 3 (see CAPTURE_RANGE), keeping UI and gameplay rules aligned.
 */
export const isOrbitContested = (system: StarSystem, fleetsOrState: Fleet[] | GameState): boolean => {
    const fleets = Array.isArray(fleetsOrState) ? fleetsOrState : fleetsOrState.fleets;
    const captureSq = CAPTURE_RANGE * CAPTURE_RANGE;
    const factionsInRange = new Set(
        fleets
            .filter(fleet => fleet.ships.length > 0 && distSq(fleet.position, system.position) <= captureSq)
            .map(fleet => fleet.factionId)
    );

    return factionsInRange.size >= 2;
};
