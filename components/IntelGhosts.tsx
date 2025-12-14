import React, { useMemo } from 'react';
import { EnemySighting } from '../types';
import { COLORS } from '../data/static';
import { Color } from 'three';

interface IntelGhostsProps {
  sightings: Record<string, EnemySighting>;
  currentDay: number;
  visibleFleetIds: Set<string>;
}

/**
 * Renders visual "Ghost" markers for enemy fleets that have been spotted previously
 * but are currently not visible (lost in Fog of War or range).
 * 
 * Behavior:
 * - Only renders fleets NOT in the current visible list.
 * - Markers fade out over time based on the age of the sighting.
 * - Purely visual, non-interactive.
 */
const IntelGhosts: React.FC<IntelGhostsProps> = React.memo(({ sightings, currentDay, visibleFleetIds }) => {
  
  const ghosts = useMemo(() => {
    const list: React.ReactElement[] = [];
    const entries: EnemySighting[] = Object.values(sightings);
    
    // Half-life of visual confidence in turns
    const FADE_DURATION = 10; 

    entries.forEach(sighting => {
        // If the fleet is currently visible (live updated), we don't show a ghost
        if (visibleFleetIds.has(sighting.fleetId)) return;

        const age = currentDay - sighting.daySeen;
        
        // Don't render if too old
        if (age > FADE_DURATION) return;

        // Calculate Opacity: Starts at 0.5, fades to 0
        const signalStrength = Math.max(0, 1 - (age / FADE_DURATION));
        const opacity = 0.5 * signalStrength;

        if (opacity < 0.05) return;

        list.push(
            <mesh 
                key={sighting.fleetId}
                position={[sighting.position.x, sighting.position.y, sighting.position.z]}
                raycast={() => null} // Ignore raycasting (non-clickable)
            >
                {/* Tetrahedron = Diamond shape, classic radar blip look */}
                <tetrahedronGeometry args={[0.8, 0]} />
                <meshBasicMaterial 
                    color={COLORS.redHighlight} 
                    transparent 
                    opacity={opacity} 
                    wireframe={true} // Wireframe looks more "tech/holographic"
                />
            </mesh>
        );
    });

    return list;
  }, [sightings, currentDay, visibleFleetIds]);

  return <group pointerEvents="none">{ghosts}</group>;
});

export default IntelGhosts;