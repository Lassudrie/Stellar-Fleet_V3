
import React, { Suspense, useEffect, useMemo, useLayoutEffect, useRef, useState } from 'react';
import { Canvas, ThreeEvent, useFrame } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { BufferGeometry, BufferAttribute } from 'three';
import { GameState, StarSystem, LaserShot, FleetState, EnemySighting } from '../../shared/shared';
import { SCENARIO_TEMPLATES } from '../../content/scenarios';
import Galaxy from './Galaxy';
import FleetMesh from './FleetRenderer';
import TerritoryBorders from './TerritoryBorders';
import GameCamera from './GameCamera';
import IntelGhosts from './IntelGhosts';
import { Vec3 } from '../../engine/math/vec3';
import { sorted } from '../../shared/shared';

interface GameSceneProps {
  gameState: GameState;
  enemySightings: Record<string, EnemySighting>;
  selectedFleetId: string | null;
  isInteractive?: boolean;
  focusTarget?: Vec3 | null;
  onReady?: () => void;
  onFleetSelect: (id: string | null) => void;
  onFleetInspect: (id: string) => void;
  onSystemClick: (sys: StarSystem, event: ThreeEvent<MouseEvent>) => void;
  onBackgroundClick: () => void;
}

const resolveFactionColor = (factions: GameState['factions'], id: string) =>
  factions.find(faction => faction.id === id)?.color || '#999';

// ------------------------------------------------------------
// Map metrics (was: ui/components/hooks/useMapMetrics.ts)
// ------------------------------------------------------------

const DEFAULT_RADIUS = 120;
const DEFAULT_MARGIN = 40;

interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

interface MapMetrics {
  center: Vec3;
  radius: number;
  bounds: MapBounds;
}

function useMapMetrics(systems: StarSystem[], galaxyRadius?: number): MapMetrics {
  return useMemo(() => {
    const requestedRadius = Math.max(galaxyRadius ?? 0, 0);
    const fallbackRadius = Math.max(DEFAULT_RADIUS, requestedRadius);

    if (systems.length === 0) {
      const span = fallbackRadius * 2;
      const margin = Math.max(DEFAULT_MARGIN, span * 0.1);
      return {
        center: { x: 0, y: 0, z: 0 },
        radius: fallbackRadius,
        bounds: {
          minX: -fallbackRadius - margin,
          maxX: fallbackRadius + margin,
          minZ: -fallbackRadius - margin,
          maxZ: fallbackRadius + margin
        }
      };
    }

    let minX = systems[0].position.x;
    let maxX = systems[0].position.x;
    let minZ = systems[0].position.z;
    let maxZ = systems[0].position.z;

    systems.forEach(({ position }) => {
      minX = Math.min(minX, position.x);
      maxX = Math.max(maxX, position.x);
      minZ = Math.min(minZ, position.z);
      maxZ = Math.max(maxZ, position.z);
    });

    const center: Vec3 = {
      x: (minX + maxX) / 2,
      y: 0,
      z: (minZ + maxZ) / 2
    };

    const extentX = maxX - minX;
    const extentZ = maxZ - minZ;
    const boundingDiagonal = Math.sqrt(extentX * extentX + extentZ * extentZ);
    const radius = Math.max(boundingDiagonal / 2, DEFAULT_RADIUS, requestedRadius);

    let boundsMinX = minX;
    let boundsMaxX = maxX;
    let boundsMinZ = minZ;
    let boundsMaxZ = maxZ;

    if (requestedRadius > 0) {
      boundsMinX = Math.min(boundsMinX, -requestedRadius);
      boundsMaxX = Math.max(boundsMaxX, requestedRadius);
      boundsMinZ = Math.min(boundsMinZ, -requestedRadius);
      boundsMaxZ = Math.max(boundsMaxZ, requestedRadius);
    }

    const spanX = boundsMaxX - boundsMinX;
    const spanZ = boundsMaxZ - boundsMinZ;
    const margin = Math.max(DEFAULT_MARGIN, Math.max(spanX, spanZ) * 0.1);

    return {
      center,
      radius,
      bounds: {
        minX: boundsMinX - margin,
        maxX: boundsMaxX + margin,
        minZ: boundsMinZ - margin,
        maxZ: boundsMaxZ + margin
      }
    };
  }, [galaxyRadius, systems]);
}

const SimpleLine: React.FC<{ start: Vec3; end: Vec3; color: string; dashed?: boolean }> = ({ start, end, color, dashed }) => {
  const lineRef = useRef<any>(null);
  
  const geometry = useMemo(() => {
    const geo = new BufferGeometry();
    const positions = new Float32Array(6); 
    geo.setAttribute('position', new BufferAttribute(positions, 3));
    return geo;
  }, []);

  useLayoutEffect(() => {
    const posAttribute = geometry.attributes.position;
    const arr = posAttribute.array as Float32Array;
    arr[0] = start.x; arr[1] = start.y; arr[2] = start.z;
    arr[3] = end.x;   arr[4] = end.y;   arr[5] = end.z;
    posAttribute.needsUpdate = true;
    if (dashed && lineRef.current) {
        lineRef.current.computeLineDistances();
    }
  }, [dashed, end.x, end.y, end.z, geometry, start.x, start.y, start.z]); 

  return (
    <lineSegments ref={lineRef} geometry={geometry} frustumCulled={false}>
      {dashed ? (
          <lineDashedMaterial color={color} dashSize={1.5} gapSize={1.0} transparent opacity={0.6} />
      ) : (
          <lineBasicMaterial color={color} transparent opacity={0.6} linewidth={1} />
      )}
    </lineSegments>
  );
};

const LaserRenderer: React.FC<{ lasers: LaserShot[] }> = React.memo(({ lasers }) => {
  return (
    <group>
      {lasers.map((laser) => (
        <SimpleLine
          key={laser.id}
          start={{ x: laser.start.x, y: 0, z: laser.start.z }}
          end={{ x: laser.end.x, y: 0, z: laser.end.z }}
          color={laser.color}
        />
      ))}
    </group>
  );
});

// TrajectoryRenderer - Now uses playerFactionId check for coloring
const TrajectoryRenderer: React.FC<{
  fleets: GameState['fleets'];
  factions: GameState['factions'];
  playerFactionId: string;
}> = React.memo(({ fleets, factions, playerFactionId }) => {
    return (
        <group>
            {fleets.map(fleet => {
                if (fleet.state === FleetState.MOVING && fleet.targetPosition) {
                    const isPlayer = fleet.factionId === playerFactionId;
                    const color = resolveFactionColor(factions, fleet.factionId);

                    return (
                        <SimpleLine
                            key={`traj-${fleet.id}`}
                            start={{ x: fleet.position.x, y: 0, z: fleet.position.z }}
                            end={{ x: fleet.targetPosition.x, y: 0, z: fleet.targetPosition.z }}
                            color={color}
                            dashed={!isPlayer}
                        />
                    );
                }
                return null;
            })}
        </group>
    );
});

const SceneReadyReporter: React.FC<{ onReady?: () => void }> = ({ onReady }) => {
  const firedRef = useRef(false);

  useFrame(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    onReady?.();
  });

  return null;
};

const GameScene: React.FC<GameSceneProps> = ({
  gameState,
  enemySightings,
  selectedFleetId,
  onFleetSelect,
  onFleetInspect,
  onSystemClick,
  onBackgroundClick,
  focusTarget,
  isInteractive = true,
  onReady
}) => {

  const playerHomeworld = useMemo(() => {
    const ownedHomeworld = gameState.systems.find(
      (system) => system.isHomeworld && system.ownerFactionId === gameState.playerFactionId
    );

    if (ownedHomeworld) {
      return { x: ownedHomeworld.position.x, y: 0, z: ownedHomeworld.position.z };
    }

    const ownedSystem = gameState.systems.find((system) => system.ownerFactionId === gameState.playerFactionId);

    if (ownedSystem) {
      return { x: ownedSystem.position.x, y: 0, z: ownedSystem.position.z };
    }

    return { x: 0, y: 0, z: 0 };
  }, [gameState.playerFactionId, gameState.systems]);

  const isScenarioReady = gameState.systems.length > 0;

  const initialHomeworldRef = useRef<Vec3 | null>(null);
  const [lastFocusedTarget, setLastFocusedTarget] = useState<Vec3 | null>(null);

  useEffect(() => {
    if (isScenarioReady && !initialHomeworldRef.current) {
      initialHomeworldRef.current = playerHomeworld;
    }
  }, [isScenarioReady, playerHomeworld]);

  useEffect(() => {
    if (focusTarget) {
      setLastFocusedTarget({ x: focusTarget.x, y: 0, z: focusTarget.z });
    }
  }, [focusTarget]);

  const homeworldForCamera = initialHomeworldRef.current ?? playerHomeworld;

  const cameraTarget = useMemo(
    () => [homeworldForCamera.x, homeworldForCamera.y, homeworldForCamera.z] as [number, number, number],
    [homeworldForCamera.x, homeworldForCamera.y, homeworldForCamera.z]
  );

  const cameraPosition = useMemo(
    () => [homeworldForCamera.x, homeworldForCamera.y + 80, homeworldForCamera.z + 50] as [number, number, number],
    [homeworldForCamera.x, homeworldForCamera.y, homeworldForCamera.z]
  );

  const cameraFocusTarget = lastFocusedTarget;

  const scenarioRadius = useMemo(() => {
    const template = SCENARIO_TEMPLATES.find(scenario => scenario.id === gameState.scenarioId);
    return template?.generation.radius;
  }, [gameState.scenarioId]);

  const mapMetrics = useMapMetrics(gameState.systems, scenarioRadius);

  const ownershipSignature = useMemo(() => {
      const owners = gameState.systems.map((system) => `${system.id}:${system.ownerFactionId ?? 'none'}`);
      return sorted(owners).join('|');
  }, [gameState.systems]);

  const battlingSystemIds = useMemo(() => {
    if (!gameState.battles) return new Set<string>();
    return new Set(
        gameState.battles
            .filter(b => b.status !== 'resolved' || b.turnResolved === gameState.day)
            .map(b => b.systemId)
    );
  }, [gameState.battles, gameState.day]);

  const visibleFleetIds = useMemo(() => {
      return new Set(gameState.fleets.map(f => f.id));
  }, [gameState.fleets]);

  const hasCoarsePointer = () => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;

  const handleFleetInteraction = (
    fleetId: string,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => {
    if (!isInteractive) return;
    const isDouble = options?.isDouble ?? false;
    const pointerType = options?.pointerType;
    const isTouchPointer = pointerType === 'touch' || hasCoarsePointer();

    if (isDouble) {
      onFleetInspect(fleetId);
      return;
    }

    if (isTouchPointer) {
      onFleetInspect(fleetId);
      return;
    }
    onFleetSelect(fleetId);
  };

  // Color Helper
  const getFactionColor = useMemo(() => (id: string) => resolveFactionColor(gameState.factions, id), [gameState.factions]);

  return (
    <div className={`absolute inset-0 z-0 bg-black ${isInteractive ? '' : 'pointer-events-none'}`}>
      <Canvas
        gl={{ antialias: false, powerPreference: "high-performance" }}
        dpr={[1, 1.5]}
        onPointerMissed={() => {
            if (!isInteractive) return;
            onBackgroundClick();
        }}
      >
        <Suspense fallback={null}>
            <GameCamera
              initialPosition={cameraPosition}
              initialTarget={cameraTarget}
              focusTarget={cameraFocusTarget}
              ready={isScenarioReady}
              mapRadius={mapMetrics.radius}
              mapBounds={mapMetrics.bounds}
            />
            <ambientLight intensity={0.4} color="#aaccff" />
            <pointLight position={[0, 50, 0]} intensity={1.5} color="#ffffff" />
            <Stars radius={200} depth={50} count={3000} factor={4} saturation={0} fade speed={0.5} />
            
            <group>
                <TerritoryBorders 
                    systems={gameState.systems} 
                    signature={ownershipSignature}
                    factions={gameState.factions} // Pass factions for coloring
                />

                <Galaxy 
                  systems={gameState.systems} 
                  fleets={gameState.fleets}
                  factions={gameState.factions}
                  armies={gameState.armies}
                  battlingSystemIds={battlingSystemIds}
                  onSystemClick={onSystemClick} 
                  playerFactionId={gameState.playerFactionId}
                />
                
                <TrajectoryRenderer
                  fleets={gameState.fleets}
                  factions={gameState.factions}
                  playerFactionId={gameState.playerFactionId}
                />

                <IntelGhosts
                    sightings={enemySightings}
                    currentDay={gameState.day}
                    visibleFleetIds={visibleFleetIds}
                    getFactionColor={getFactionColor}
                />

                {gameState.fleets.map(fleet => (
                    <FleetMesh
                        key={fleet.id}
                        fleet={fleet}
                        day={gameState.day}
                        isSelected={selectedFleetId === fleet.id}
                        onSelect={(e, isDouble, pointerType) => {
                            e.stopPropagation();
                            handleFleetInteraction(fleet.id, { isDouble, pointerType });
                        }}
                        playerFactionId={gameState.playerFactionId}
                        color={getFactionColor(fleet.factionId)}
                    />
                ))}

                <LaserRenderer lasers={gameState.lasers} />
            </group>

            <SceneReadyReporter onReady={onReady} />

            <EffectComposer enableNormalPass={false}>
                <Bloom luminanceThreshold={0.2} mipmapBlur intensity={1.2} radius={0.4} />
            </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
};

export default GameScene;
