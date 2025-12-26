
import React, { useMemo, useRef } from 'react';
import { Billboard, Instance, Instances, Text } from '@react-three/drei';
import { BufferGeometry, Float32BufferAttribute, DoubleSide, Vector3 } from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { Army, ArmyState, FactionState, Fleet, ShipType, StarSystem } from '../../shared/types';
import { CAPTURE_RANGE, COLORS } from '../../content/data/static';
import { findOrbitingSystem } from './ui/orbiting';
import { GAS_GIANT_ICON } from '../constants/icons';

interface GalaxyProps {
  systems: StarSystem[];
  fleets: Fleet[];
  factions: FactionState[];
  armies?: Army[];
  battlingSystemIds?: Set<string>;
  onSystemClick: (system: StarSystem, event: ThreeEvent<MouseEvent>) => void;
  playerFactionId: string;
}

interface ArmyInfo {
    playerCount: number;
    enemyCount: number;
    hasConflict: boolean;
}

interface PlanetBadgeInfo {
    planetId: string;
    systemId: string;
    position: [number, number, number];
    color: string;
    contested: boolean;
}

const PlanetBadge: React.FC<{ badge: PlanetBadgeInfo }> = ({ badge }) => (
    <Billboard follow={true} lockX={false} lockY={false} lockZ={false} position={badge.position}>
        <mesh>
            <circleGeometry args={[0.45, 24]} />
            <meshBasicMaterial color={badge.color} transparent opacity={0.85} />
        </mesh>
        <mesh>
            <ringGeometry args={[0.55, 0.7, 24]} />
            <meshBasicMaterial color="#111827" transparent opacity={0.6} side={DoubleSide} />
        </mesh>
        {badge.contested && (
            <group>
                <mesh>
                    <ringGeometry args={[0.8, 1, 32]} />
                    <meshBasicMaterial color="#fbbf24" transparent opacity={0.9} side={DoubleSide} />
                </mesh>
                <Text
                    position={[0, 0, 0.05]}
                    fontSize={0.5}
                    color="#fbbf24"
                    anchorX="center"
                    anchorY="middle"
                    outlineWidth={0.04}
                    outlineColor="#000000"
                    fontWeight="bold"
                >
                    ⚔
                </Text>
            </group>
        )}
    </Billboard>
);

const SystemLabel: React.FC<{ system: StarSystem; armyInfo?: ArmyInfo; iconColor?: string }> = ({ system, armyInfo, iconColor }) => {
    const textRef = useRef<any>(null);
    const iconRef = useRef<any>(null);
    const armyIconRef = useRef<any>(null);
    const isOwned = system.ownerFactionId !== null;
    
    const resourceIcon = useMemo(() => {
        if (system.resourceType !== 'gas') return null;
        return GAS_GIANT_ICON;
    }, [system.resourceType]);

    const armyVisual = useMemo(() => {
        if (!armyInfo || (armyInfo.playerCount === 0 && armyInfo.enemyCount === 0)) return null;
        
        if (armyInfo.hasConflict) {
            return { text: '⚔', color: '#fbbf24' }; // Amber Swords
        }
        if (armyInfo.playerCount > 0) {
            return { text: `⚑ ${armyInfo.playerCount}`, color: COLORS.blueHighlight };
        }
        if (armyInfo.enemyCount > 0) {
            return { text: `⚑ ${armyInfo.enemyCount}`, color: COLORS.redHighlight };
        }
        return null;
    }, [armyInfo]);

    useFrame(({ camera }) => {
        const dist = camera.position.distanceTo(new Vector3(system.position.x, system.position.y, system.position.z));
        const maxDist = isOwned ? 135 : 90;
        const fadeRange = 30;
        const fadeStart = maxDist - fadeRange;

        let opacity = 1;
        if (dist > maxDist) {
            opacity = 0;
        } else if (dist > fadeStart) {
            opacity = 1 - (dist - fadeStart) / fadeRange;
        }

        const isVisible = opacity > 0.05;
        
        if (textRef.current) {
            textRef.current.visible = isVisible;
            if (isVisible) {
                textRef.current.fillOpacity = isOwned ? opacity : opacity * 0.7;
                textRef.current.outlineOpacity = opacity;
            }
        }

        if (iconRef.current) {
             iconRef.current.visible = isVisible;
             if (isVisible) {
                 iconRef.current.fillOpacity = opacity;
                 iconRef.current.outlineOpacity = opacity;
             }
        }

        if (armyIconRef.current) {
            armyIconRef.current.visible = isVisible;
            if (isVisible) {
                armyIconRef.current.fillOpacity = opacity;
                armyIconRef.current.outlineOpacity = opacity;
            }
        }
    });

    return (
        <group>
             {resourceIcon && (
                 <Billboard follow={true} lockX={false} lockY={false} lockZ={false}>
                     <Text
                        ref={iconRef}
                        position={[0, 1.3, 0]}
                        fontSize={1.2}
                        color={iconColor}
                        anchorX="center"
                        anchorY="bottom"
                        outlineWidth={0.02}
                        outlineColor="#000000"
                     >
                        {resourceIcon}
                     </Text>
                 </Billboard>
             )}

             {armyVisual && (
                 <Billboard follow={true} lockX={false} lockY={false} lockZ={false}>
                     <Text
                        ref={armyIconRef}
                        position={[0, resourceIcon ? 2.8 : 1.5, 0]}
                        fontSize={1.0}
                        color={armyVisual.color}
                        anchorX="center"
                        anchorY="bottom"
                        outlineWidth={0.05}
                        outlineColor="#000000"
                        fontWeight="bold"
                     >
                        {armyVisual.text}
                     </Text>
                 </Billboard>
             )}

            <Billboard follow={true} lockX={false} lockY={false} lockZ={false}>
                <Text
                    ref={textRef}
                    position={[0, -1.5, 0]}
                    fontSize={0.9}
                    color={system.color} // Use system color (which defaults to white or owner color)
                    anchorX="center"
                    anchorY="top"
                    outlineWidth={0.05}
                    outlineColor="#000000"
                    fontWeight={isOwned ? 'bold' : 'normal'}
                >
                    {system.name}
                </Text>
            </Billboard>
        </group>
    );
};

const Galaxy: React.FC<GalaxyProps> = React.memo(({ systems, fleets, factions, armies, battlingSystemIds, onSystemClick, playerFactionId }) => {
  const armyMap = useMemo(() => {
      const map = new Map<string, ArmyInfo>();
      if (!armies) return map;

      const planetToSystem = new Map<string, string>();
      systems.forEach(system => {
          system.planets.forEach(planet => {
              planetToSystem.set(planet.id, system.id);
          });
      });

      armies.forEach(army => {
          if (army.state !== ArmyState.DEPLOYED) return;
          const systemId = planetToSystem.get(army.containerId);
          if (!systemId) return;
          
          if (!map.has(systemId)) {
              map.set(systemId, { playerCount: 0, enemyCount: 0, hasConflict: false });
          }
          const info = map.get(systemId)!;
          
          if (army.factionId === playerFactionId) info.playerCount++;
          else info.enemyCount++;
          
          info.hasConflict = info.playerCount > 0 && info.enemyCount > 0;
      });
      return map;
  }, [armies, playerFactionId, systems]);

  const deployedFactionsByPlanet = useMemo(() => {
      const map = new Map<string, Set<string>>();
      if (!armies) return map;

      armies.forEach(army => {
          if (army.state !== ArmyState.DEPLOYED) return;
          if (!map.has(army.containerId)) {
              map.set(army.containerId, new Set());
          }
          map.get(army.containerId)!.add(army.factionId);
      });

      return map;
  }, [armies]);

  const extractingBySystem = useMemo(() => {
      const map = new Map<string, Set<string>>();
      fleets.forEach(fleet => {
          if (!fleet.ships.some(ship => ship.type === ShipType.EXTRACTOR)) return;
          const system = findOrbitingSystem(fleet, systems);
          if (!system || system.resourceType !== 'gas') return;
          if (!map.has(system.id)) {
              map.set(system.id, new Set());
          }
          map.get(system.id)!.add(fleet.factionId);
      });
      return map;
  }, [fleets, systems]);

  const factionColorById = useMemo(() => {
      const map = new Map<string, string>();
      factions.forEach(faction => map.set(faction.id, faction.color));
      return map;
  }, [factions]);

  const planetBadges = useMemo<PlanetBadgeInfo[]>(() => {
      const badges: PlanetBadgeInfo[] = [];

      systems.forEach((system) => {
          const solidPlanets = system.planets.filter((planet) => planet.isSolid);
          if (solidPlanets.length === 0) return;

          const angleStep = (Math.PI * 2) / solidPlanets.length;
          const radius = Math.max(3.5, 2.5 + system.size * 0.25);

          solidPlanets.forEach((planet, index) => {
              const angle = index * angleStep;
              const x = system.position.x + Math.cos(angle) * radius;
              const z = system.position.z + Math.sin(angle) * radius;
              const y = system.position.y + 0.2;
              const ownerColor = planet.ownerFactionId ? factionColorById.get(planet.ownerFactionId) ?? '#9ca3af' : '#9ca3af';
              const factionsOnPlanet = deployedFactionsByPlanet.get(planet.id);
              const contested = (factionsOnPlanet?.size ?? 0) >= 2;

              badges.push({
                  planetId: planet.id,
                  systemId: system.id,
                  position: [x, y, z],
                  color: ownerColor,
                  contested,
              });
          });
      });

      return badges;
  }, [deployedFactionsByPlanet, factionColorById, systems]);

  const resolveGasIconColor = (system: StarSystem): string => {
      if (system.resourceType !== 'gas') return '#ffffff';
      if (!system.ownerFactionId) return '#ffffff';
      const extractingFactions = extractingBySystem.get(system.id);
      if (extractingFactions?.has(system.ownerFactionId)) return '#22c55e';
      return factionColorById.get(system.ownerFactionId) ?? '#ffffff';
  };

  const lineGeometry = useMemo(() => {
    if (!systems || systems.length === 0) return new BufferGeometry();
    const positions: number[] = [];
    systems.forEach(sys => {
        positions.push(sys.position.x, 0, sys.position.z);
        positions.push(sys.position.x, sys.position.y, sys.position.z);
    });
    
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return geo;
  }, [systems]);

  const battleSystems = useMemo(() => {
    if (!battlingSystemIds) return [];
    return systems.filter(s => battlingSystemIds.has(s.id));
  }, [systems, battlingSystemIds]);

  if (!systems || systems.length === 0) return null;

  return (
    <group>
        <lineSegments geometry={lineGeometry}>
            <lineBasicMaterial color="#ffffff" transparent opacity={0.1} linewidth={1} />
        </lineSegments>

        <Instances range={systems.length}>
            <sphereGeometry args={[0.25, 16, 16]} />
            <meshBasicMaterial />
            
            {systems.map((sys) => (
                <Instance 
                    key={`vis-${sys.id}`}
                    position={[sys.position.x, sys.position.y, sys.position.z]} 
                    scale={[1.5, 1.5, 1.5]}
                    color={sys.color} 
                />
            ))}
        </Instances>

        {battleSystems.length > 0 && (
          <Instances range={battleSystems.length}>
            <torusGeometry args={[CAPTURE_RANGE * 0.8, 0.1, 8, 32]} />
            <meshBasicMaterial color="#ef4444" transparent opacity={0.6} side={DoubleSide} />
            {battleSystems.map((sys) => (
               <Instance
                  key={`battle-${sys.id}`}
                  position={[sys.position.x, sys.position.y, sys.position.z]}
                  rotation={[Math.PI / 2, 0, 0]} 
               />
            ))}
          </Instances>
        )}

        <Instances range={systems.length}>
            <sphereGeometry args={[3.5, 8, 8]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            
            {systems.map((sys) => (
                <Instance 
                    key={`hit-${sys.id}`}
                    position={[sys.position.x, sys.position.y, sys.position.z]} 
                    scale={[1, 1, 1]} 
                    onClick={(e) => {
                        e.stopPropagation();
                        onSystemClick(sys, e);
                    }}
                    onPointerOver={() => document.body.style.cursor = 'pointer'}
                    onPointerOut={() => document.body.style.cursor = 'auto'}
                />
            ))}
        </Instances>

        {systems.map((sys) => (
            <group key={`label-${sys.id}`} position={[sys.position.x, sys.position.y, sys.position.z]}>
                <SystemLabel system={sys} armyInfo={armyMap.get(sys.id)} iconColor={resolveGasIconColor(sys)} />
            </group>
        ))}

        {planetBadges.map((badge) => (
            <PlanetBadge key={`planet-badge-${badge.planetId}`} badge={badge} />
        ))}
    </group>
  );
});

export default Galaxy;
