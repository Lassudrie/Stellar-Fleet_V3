
import React, { Suspense, useEffect, useMemo, useLayoutEffect, useRef } from 'react';
import { Canvas, ThreeEvent } from '@react-three/fiber';
import { Stars } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { GameState, StarSystem, LaserShot, FleetState, EnemySighting } from '../types';
import Galaxy from './Galaxy';
import FleetMesh from './FleetRenderer';
import TerritoryBorders from './TerritoryBorders';
import GameCamera from './GameCamera';
import IntelGhosts from './IntelGhosts';
import { Vec3 } from '../engine/math/vec3';
import { useMapMetrics } from './hooks/useMapMetrics';
import BatchedLines, { LineDef } from './BatchedLines';

interface GameSceneProps {
  gameState: GameState;
  enemySightings: Record<string, EnemySighting>;
  selectedFleetId: string | null;
  onFleetSelect: (id: string | null) => void;
  onFleetInspect: (id: string) => void;
  onSystemClick: (sys: StarSystem, event: ThreeEvent<MouseEvent>) => void;
  onBackgroundClick: () => void;
}

const resolveFactionColor = (factions: GameState['factions'], id: string) =>
  factions.find(faction => faction.id === id)?.color || '#999';

const LaserRenderer: React.FC<{ lasers: LaserShot[] }> = React.memo(({ lasers }) => {
  const lines: LineDef[] = useMemo(() => lasers.map(laser => ({
      id: laser.id,
      start: laser.start,
      end: laser.end,
      color: laser.color,
      dashed: false
  })), [lasers]);

  return <BatchedLines lines={lines} />;
});

// TrajectoryRenderer - Now uses playerFactionId check for coloring
const TrajectoryRenderer: React.FC<{
  fleets: GameState['fleets'];
  factions: GameState['factions'];
  day: number;
  playerFactionId: string;
}> = React.memo(({ fleets, factions, day, playerFactionId }) => {

    const lines: LineDef[] = useMemo(() => {
        const result: LineDef[] = [];
        fleets.forEach(fleet => {
            if (fleet.state === FleetState.MOVING && fleet.targetPosition) {
                const isPlayer = fleet.factionId === playerFactionId;
                const color = resolveFactionColor(factions, fleet.factionId);
                result.push({
                    id: `traj-${fleet.id}`,
                    start: fleet.position,
                    end: fleet.targetPosition,
                    color: color,
                    dashed: !isPlayer
                });
            }
        });
        return result;
    }, [fleets, factions, playerFactionId]);

    return <BatchedLines lines={lines} />;
});

const GameScene: React.FC<GameSceneProps> = ({
  gameState,
  enemySightings,
  selectedFleetId,
  onFleetSelect,
  onFleetInspect,
  onSystemClick,
  onBackgroundClick
}) => {

  const playerHomeworld = useMemo(() => {
    const ownedHomeworld = gameState.systems.find(
      (system) => system.isHomeworld && system.ownerFactionId === gameState.playerFactionId
    );

    if (ownedHomeworld) {
      return ownedHomeworld.position;
    }

    const ownedSystem = gameState.systems.find((system) => system.ownerFactionId === gameState.playerFactionId);

    if (ownedSystem) {
      return ownedSystem.position;
    }

    return { x: 0, y: 0, z: 0 };
  }, [gameState.playerFactionId, gameState.systems]);

  const isScenarioReady = gameState.systems.length > 0;

  const initialHomeworldRef = useRef<Vec3 | null>(null);

  useEffect(() => {
    if (isScenarioReady && !initialHomeworldRef.current) {
      initialHomeworldRef.current = playerHomeworld;
    }
  }, [isScenarioReady, playerHomeworld]);

  const homeworldForCamera = initialHomeworldRef.current ?? playerHomeworld;

  const cameraTarget = useMemo(
    () => [homeworldForCamera.x, homeworldForCamera.y, homeworldForCamera.z] as [number, number, number],
    [homeworldForCamera.x, homeworldForCamera.y, homeworldForCamera.z]
  );

  const cameraPosition = useMemo(
    () => [homeworldForCamera.x, homeworldForCamera.y + 80, homeworldForCamera.z + 50] as [number, number, number],
    [homeworldForCamera.x, homeworldForCamera.y, homeworldForCamera.z]
  );

  const mapMetrics = useMapMetrics(gameState.systems);

  const ownershipSignature = useMemo(() => {
      const owners = gameState.systems.map((system) => `${system.id}:${system.ownerFactionId ?? 'none'}`);
      owners.sort();
      return owners.join('|');
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

  const lastTapRef = useRef<{ id: string | null; time: number }>({ id: null, time: 0 });
  const DOUBLE_TAP_THRESHOLD_MS = 500;

  const handleFleetInteraction = (fleetId: string, isDouble = false) => {
    const now = performance.now();

    if (isDouble) {
      lastTapRef.current = { id: null, time: 0 };
      onFleetInspect(fleetId);
      return;
    }

    if (lastTapRef.current.id === fleetId && now - lastTapRef.current.time < DOUBLE_TAP_THRESHOLD_MS) {
      lastTapRef.current = { id: null, time: 0 };
      onFleetInspect(fleetId);
      return;
    }

    lastTapRef.current = { id: fleetId, time: now };
    onFleetSelect(fleetId);
  };

  // Color Helper
  const getFactionColor = useMemo(() => (id: string) => resolveFactionColor(gameState.factions, id), [gameState.factions]);

  return (
    <div className="absolute inset-0 z-0 bg-black">
      <Canvas
        gl={{ antialias: false, powerPreference: "high-performance" }}
        dpr={[1, 1.5]}
        onPointerMissed={() => onBackgroundClick()}
      >
        <Suspense fallback={null}>
            <GameCamera
              initialPosition={cameraPosition}
              initialTarget={cameraTarget}
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
                  armies={gameState.armies}
                  battlingSystemIds={battlingSystemIds}
                  onSystemClick={onSystemClick} 
                  playerFactionId={gameState.playerFactionId}
                />
                
                <TrajectoryRenderer
                  fleets={gameState.fleets}
                  factions={gameState.factions}
                  day={gameState.day}
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
                        onSelect={(e, isDouble) => {
                            e.stopPropagation();
                            handleFleetInteraction(fleet.id, isDouble);
                        }}
                        playerFactionId={gameState.playerFactionId}
                        color={getFactionColor(fleet.factionId)}
                    />
                ))}

                <LaserRenderer lasers={gameState.lasers} />
            </group>

            <EffectComposer enableNormalPass={false}>
                <Bloom luminanceThreshold={0.2} mipmapBlur intensity={1.2} radius={0.4} />
            </EffectComposer>
        </Suspense>
      </Canvas>
    </div>
  );
};

export default GameScene;
