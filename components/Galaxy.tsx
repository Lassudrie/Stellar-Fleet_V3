
import React, { useMemo, useRef } from 'react';
import { Billboard, Instance, Instances, Text } from '@react-three/drei';
import { BufferGeometry, Float32BufferAttribute, DoubleSide, Vector3 } from 'three';
import { ThreeEvent, useFrame } from '@react-three/fiber';
import { StarSystem, Army, ArmyState, SpectralType, PlanetData } from '../types';
import { CAPTURE_RANGE, COLORS } from '../data/static';

interface GalaxyProps {
  systems: StarSystem[];
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

type AstroSummary = {
    spectralType?: SpectralType;
    planetCount?: number;
    hasGasGiant?: boolean;
    hasHabitableLike?: boolean;
};

const spectralColor = (t?: SpectralType): string => {
    // Approximate star colors (UI only)
    switch (t) {
        case 'O': return '#7dd3fc'; // cyan-blue
        case 'B': return '#93c5fd'; // blue
        case 'A': return '#f8fafc'; // near-white
        case 'F': return '#fde68a'; // pale yellow
        case 'G': return '#fbbf24'; // yellow
        case 'K': return '#fb923c'; // orange
        case 'M': return '#f87171'; // red
        default: return '#ffffff';
    }
};

const isHabitableLike = (p: PlanetData, hzInnerAu: number, hzOuterAu: number): boolean => {
    if (!Number.isFinite(p.semiMajorAxisAu)) return false;
    const inHz = p.semiMajorAxisAu >= hzInnerAu && p.semiMajorAxisAu <= hzOuterAu;
    if (!inHz) return false;

    // Simple heuristic: terrestrial-ish + non-null atmosphere + plausible temperature
    if (p.type !== 'Terrestrial') return false;
    if (p.atmosphere === 'None') return false;
    if (!Number.isFinite(p.temperatureK)) return false;
    return p.temperatureK >= 240 && p.temperatureK <= 330;
};

const summarizeSystemAstro = (system: StarSystem): AstroSummary => {
    const astro = system.astro;
    if (!astro) return {};

    const planets = astro.planets || [];
    const hasGasGiant = planets.some(p => p.type === 'GasGiant' || p.type === 'IceGiant');
    const hzInnerAu = astro.derived?.hzInnerAu ?? NaN;
    const hzOuterAu = astro.derived?.hzOuterAu ?? NaN;
    const hasHabitableLike =
        Number.isFinite(hzInnerAu) && Number.isFinite(hzOuterAu)
            ? planets.some(p => isHabitableLike(p, hzInnerAu, hzOuterAu))
            : false;

    return {
        spectralType: astro.primarySpectralType,
        planetCount: planets.length,
        hasGasGiant,
        hasHabitableLike
    };
};

const SystemLabel: React.FC<{ system: StarSystem; armyInfo?: ArmyInfo; astro?: AstroSummary }> = ({ system, armyInfo, astro }) => {
    const textRef = useRef<any>(null);
    const iconRef = useRef<any>(null);
    const armyIconRef = useRef<any>(null);
    const astroRef = useRef<any>(null);
    const isOwned = system.ownerFactionId !== null;
    
    const resourceIcon = useMemo(() => {
        if (system.resourceType === 'gas') return '🪐';
        return null;
    }, [system.resourceType]);

    const astroLine = useMemo(() => {
        if (!astro || !astro.spectralType) return null;
        const bits: string[] = [];
        bits.push(`${astro.spectralType}`);
        if (typeof astro.planetCount === 'number') bits.push(`🪐 ${astro.planetCount}`);
        if (astro.hasHabitableLike) bits.push('🌍');
        return bits.join('  ');
    }, [astro]);

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

        if (astroRef.current) {
            astroRef.current.visible = isVisible;
            if (isVisible) {
                astroRef.current.fillOpacity = opacity;
                astroRef.current.outlineOpacity = opacity;
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
                        anchorX="center"
                        anchorY="bottom"
                        outlineWidth={0.02}
                        outlineColor="#000000"
                     >
                        {resourceIcon}
                     </Text>
                 </Billboard>
             )}

             {astroLine && (
                 <Billboard follow={true} lockX={false} lockY={false} lockZ={false}>
                     <Text
                        ref={astroRef}
                        position={[0, resourceIcon ? 2.2 : 1.2, 0]}
                        fontSize={0.55}
                        color={spectralColor(astro?.spectralType)}
                        anchorX="center"
                        anchorY="bottom"
                        outlineWidth={0.05}
                        outlineColor="#000000"
                        fontWeight="bold"
                     >
                        {astroLine}
                     </Text>
                 </Billboard>
             )}

             {armyVisual && (
                 <Billboard follow={true} lockX={false} lockY={false} lockZ={false}>
                     <Text
                        ref={armyIconRef}
                        position={[0, (resourceIcon ? 2.8 : 1.5) + (astroLine ? 1.0 : 0), 0]}
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

const Galaxy: React.FC<GalaxyProps> = React.memo(({ systems, armies, battlingSystemIds, onSystemClick, playerFactionId }) => {
  const armyMap = useMemo(() => {
      const map = new Map<string, ArmyInfo>();
      if (!armies) return map;

      armies.forEach(army => {
          if (army.state !== ArmyState.DEPLOYED) return;
          
          if (!map.has(army.containerId)) {
              map.set(army.containerId, { playerCount: 0, enemyCount: 0, hasConflict: false });
          }
          const info = map.get(army.containerId)!;
          
          if (army.factionId === playerFactionId) info.playerCount++;
          else info.enemyCount++;
          
          info.hasConflict = info.playerCount > 0 && info.enemyCount > 0;
      });
      return map;
  }, [armies, playerFactionId]);

  const astroSummaryBySystemId = useMemo(() => {
      const map = new Map<string, AstroSummary>();
      for (const sys of systems) {
          map.set(sys.id, summarizeSystemAstro(sys));
      }
      return map;
  }, [systems]);

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

        {/* Inner "stellar tint" (astro-driven) */}
        <Instances range={systems.length}>
            <sphereGeometry args={[0.2, 16, 16]} />
            <meshBasicMaterial />
            {systems.map((sys) => (
                <Instance
                    key={`astro-${sys.id}`}
                    position={[sys.position.x, sys.position.y, sys.position.z]}
                    scale={[1.0, 1.0, 1.0]}
                    color={spectralColor(sys.astro?.primarySpectralType)}
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
                <SystemLabel system={sys} armyInfo={armyMap.get(sys.id)} astro={astroSummaryBySystemId.get(sys.id)} />
            </group>
        ))}
    </group>
  );
});

export default Galaxy;
