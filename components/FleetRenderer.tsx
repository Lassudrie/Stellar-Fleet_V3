
import React, { useRef, useMemo, useLayoutEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Mesh, Group, Vector3, Shape, AdditiveBlending, PointLight } from 'three';
import { Fleet, FleetState, FactionId } from '../types';
import { COLORS, ORBIT_RADIUS, ORBIT_SPEED } from '../data/static';
import { Text, Billboard } from '@react-three/drei';
import { fleetLabel } from '../engine/idUtils';

interface FleetMeshProps {
  fleet: Fleet;
  day: number;
  isSelected: boolean;
  onSelect: (e: any) => void;
  playerFactionId: string;
  color: string;
}

// --- MODULE LEVEL CONSTANTS (Optimization) ---
// Avoids recreating geometry settings and shapes for every fleet instance.

const CHEVRON_SHAPE = new Shape();
CHEVRON_SHAPE.moveTo(0, -1.5);     
CHEVRON_SHAPE.lineTo(1.2, 1);     
CHEVRON_SHAPE.lineTo(0, 0.2);     
CHEVRON_SHAPE.lineTo(-1.2, 1);    
CHEVRON_SHAPE.lineTo(0, -1.5);

const EXTRUDE_SETTINGS = {
  depth: 0.2,
  bevelEnabled: true,
  bevelThickness: 0.1,
  bevelSize: 0.1,
  bevelSegments: 2
};

// Reusable scratch vector to avoid GC pressure in the render loop
const _vec3 = new Vector3();

const FleetMesh: React.FC<FleetMeshProps> = React.memo(({ fleet, day, isSelected, onSelect, playerFactionId }) => {
  // We use a Group to handle the Position of the entire fleet entity (ship + label + selection ring)
  const groupRef = useRef<Group>(null);
  // We use a Mesh ref to handle the Rotation/Orientation of the ship model itself
  const meshRef = useRef<Mesh>(null);
  
  // Flash Effect Refs
  const flashMeshRef = useRef<Mesh>(null);
  const flashLightRef = useRef<PointLight>(null);
  const previousState = useRef<FleetState>(fleet.state);
  const flashProgress = useRef(0); // 0 (inactive) -> 1 (start of flash) -> 0 (end)

  // Constants for visual representation
  const color = fleet.factionId === 'blue' ? COLORS.blue : COLORS.red;
  const highlightColor = fleet.factionId === 'blue' ? COLORS.blueHighlight : COLORS.redHighlight;
  const isOrbiting = fleet.state === FleetState.ORBIT;

  // Generate a stable random start angle based on fleet ID
  const angleOffset = useMemo(() => {
    let hash = 0;
    for (let i = 0; i < fleet.id.length; i++) {
        hash = (hash << 5) - hash + fleet.id.charCodeAt(i);
        hash |= 0; 
    }
    return Math.abs(hash % 360) * (Math.PI / 180);
  }, [fleet.id]);

  // Set initial position immediately to prevent jumping from 0,0,0
  useLayoutEffect(() => {
    if (groupRef.current) {
        groupRef.current.position.set(fleet.position.x, fleet.position.y, fleet.position.z);
    }
    
    // Check if we should trigger a flash on mount (e.g. Enemy arriving from Fog of War)
    if (fleet.stateStartTurn === day) {
         flashProgress.current = 1.0;
    }
  }, []); // Only on mount
  
  useFrame((state, delta) => {
    if (!groupRef.current || !meshRef.current) return;

    // --- HYPERDRIVE FLASH DETECTION ---
    if (previousState.current !== fleet.state) {
        const wasOrbiting = previousState.current === FleetState.ORBIT;
        const isNowMoving = fleet.state === FleetState.MOVING;
        const wasMoving = previousState.current === FleetState.MOVING;
        const isNowOrbiting = fleet.state === FleetState.ORBIT;

        // Trigger flash on Departure OR Arrival
        if ((wasOrbiting && isNowMoving) || (wasMoving && isNowOrbiting)) {
            flashProgress.current = 1.0; 
        }
        previousState.current = fleet.state;
    }

    // --- FLASH ANIMATION ---
    if (flashProgress.current > 0) {
        // Decay the flash quickly (duration ~0.3s)
        flashProgress.current -= delta * 3.5;
        if (flashProgress.current < 0) flashProgress.current = 0;

        if (flashMeshRef.current && flashLightRef.current) {
            // Expansion: Starts small, explodes outward
            const invertedProgress = 1.0 - flashProgress.current;
            const scale = 1 + invertedProgress * 10; 
            
            flashMeshRef.current.scale.setScalar(scale);
            
            // @ts-ignore
            if (flashMeshRef.current.material) {
                // @ts-ignore
                flashMeshRef.current.material.opacity = flashProgress.current;
            }
            flashLightRef.current.intensity = flashProgress.current * 50; 
        }
    } else {
        // Ensure hidden when inactive
        if (flashMeshRef.current) flashMeshRef.current.scale.setScalar(0);
        if (flashLightRef.current) flashLightRef.current.intensity = 0;
    }

    // --- MOVEMENT LOGIC ---
    if (isOrbiting) {
        // OPTIMIZATION: Use state.clock.getElapsedTime() for frame-synced time
        const time = state.clock.getElapsedTime() * ORBIT_SPEED + angleOffset;
        
        const x = fleet.position.x + Math.cos(time) * ORBIT_RADIUS;
        const z = fleet.position.z + Math.sin(time) * ORBIT_RADIUS;
        
        // OPTIMIZATION: Reuse _vec3 to avoid new allocation
        _vec3.set(x, fleet.position.y, z);
        groupRef.current.position.lerp(_vec3, 0.1);

        const futureTime = time + 0.1; 
        const lookAtX = fleet.position.x + Math.cos(futureTime) * ORBIT_RADIUS;
        const lookAtZ = fleet.position.z + Math.sin(futureTime) * ORBIT_RADIUS;
        
        meshRef.current.lookAt(lookAtX, fleet.position.y, lookAtZ);
        meshRef.current.rotateX(-Math.PI / 2);

    } else {
        // Convert Vec3 to Three.Vector3 on the fly for Lerp target
        _vec3.set(fleet.position.x, fleet.position.y, fleet.position.z);
        groupRef.current.position.lerp(_vec3, 0.5);
        if (fleet.targetPosition) {
            meshRef.current.lookAt(fleet.targetPosition.x, fleet.targetPosition.y, fleet.targetPosition.z);
            meshRef.current.rotateX(-Math.PI / 2);
        }
    }
  });

  return (
    <group ref={groupRef}>
        {/* HITBOX: Large invisible sphere for easier selection on mobile/desktop */}
        <mesh 
            onClick={(e) => {
                e.stopPropagation();
                onSelect(e);
            }}
            onPointerOver={() => document.body.style.cursor = 'pointer'}
            onPointerOut={() => document.body.style.cursor = 'auto'}
        >
            <sphereGeometry args={[2.5, 8, 8]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>

        {/* HYPERDRIVE FLASH FX */}
        <mesh ref={flashMeshRef} scale={[0,0,0]}>
            <sphereGeometry args={[1, 16, 16]} />
            <meshBasicMaterial color="#cceeff" transparent opacity={0} blending={AdditiveBlending} depthWrite={false} />
        </mesh>
        <pointLight ref={flashLightRef} color="#cceeff" distance={20} decay={2} intensity={0} />

        {/* SHIP MODEL (No Trail) */}
        <mesh 
            ref={meshRef}
            scale={[0.6, 0.6, 0.6]} 
        >
            <extrudeGeometry args={[CHEVRON_SHAPE, EXTRUDE_SETTINGS]} />
            <meshStandardMaterial 
                color={isSelected ? highlightColor : color} 
                emissive={isSelected ? highlightColor : color}
                emissiveIntensity={isSelected ? 0.6 : 0.4}
                roughness={0.4}
                metalness={0.6}
            />
        </mesh>
        
        {/* SELECTION RING */}
        {isSelected && (
            <mesh position={[0, -0.2, 0]} rotation={[-Math.PI/2, 0, 0]}>
                <ringGeometry args={[1, 1.2, 32]} />
                <meshBasicMaterial color={highlightColor} transparent opacity={0.6} />
            </mesh>
        )}

        {/* INFO LABEL (Performance Optimized) */}
        <Billboard
             follow={true}
             lockX={false}
             lockY={false}
             lockZ={false}
             position={[0, 2.5, 0]} 
        >
            <Text
                fontSize={1.2}
                color={fleet.factionId === 'blue' ? '#93c5fd' : '#fca5a5'} // blue-300 / red-300
                outlineWidth={0.1}
                outlineColor="#000000"
                fontWeight="bold"
            >
                {`${fleetLabel(fleet.id)} [${fleet.ships.length}]`}
            </Text>
        </Billboard>
    </group>
  );
});

export default FleetMesh;
