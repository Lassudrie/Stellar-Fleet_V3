import { ORBIT_PROXIMITY_RANGE_SQ } from '../../data/static';
import { distSq } from '../../engine/math/vec3';
import { Fleet, FleetState, StarSystem } from '../../types';

/**
 * Identify the system a fleet is orbiting using the shared ORBIT_RADIUS * 3 proximity window.
 * A custom threshold can be provided for specific UI contexts while keeping the default consistent across the app.
 */
export const findOrbitingSystem = (
    fleet: Fleet | null,
    systems: StarSystem[],
    thresholdSq: number = ORBIT_PROXIMITY_RANGE_SQ
): StarSystem | null => {
    if (!fleet || fleet.state !== FleetState.ORBIT) return null;

    let closest: { system: StarSystem; distanceSq: number } | null = null;

    systems.forEach(system => {
        const distanceSq = distSq(fleet.position, system.position);
        if (distanceSq > thresholdSq) return;

        if (!closest || distanceSq < closest.distanceSq) {
            closest = { system, distanceSq };
        }
    });

    return closest?.system ?? null;
};
