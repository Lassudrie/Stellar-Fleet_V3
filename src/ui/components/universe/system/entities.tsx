import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Billboard, Text } from '@react-three/drei';
import { type ThreeEvent } from '@react-three/fiber';
import {
  ConeGeometry,
  CylinderGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  TorusGeometry
} from 'three';
import { useI18n } from '../../../i18n';
import { useFleetName } from '../../../context/FleetNames';
import { shortId, sorted } from '../../../../shared/shared';
import type { Fleet, Station } from '../../../../shared/shared';
import {
  hashStringToAngle,
  layoutTacticalRing,
  makeObjectId,
  type SystemObjectId,
  type TacticalRingConfig
} from '../../screens';
import type { OrbitingPlanet } from './systemModel';
import { useDisposableMemo } from './renderUtils';

export type FleetRingBaseOptions = {
  starRadius: number;
  focusDistanceFloor: number;
  planets: OrbitingPlanet[];
  safetyMargin: number;
  minimumOrbitClearance: number;
};

export const computeFleetRingBaseRadius = ({
  starRadius,
  focusDistanceFloor,
  planets,
  safetyMargin,
  minimumOrbitClearance
}: FleetRingBaseOptions): number => {
  const minimumRadius = Math.max(starRadius + safetyMargin, focusDistanceFloor * 1.5);

  if (!planets.length) {
    return minimumRadius;
  }

  const closestPlanet = planets.reduce(
    (currentClosest, planet) => (planet.orbitRadius < currentClosest.orbitRadius ? planet : currentClosest),
    planets[0]
  );
  const innerOrbitLimit = closestPlanet.orbitRadius - closestPlanet.radius - minimumOrbitClearance;

  if (innerOrbitLimit >= minimumRadius) {
    return innerOrbitLimit;
  }

  const outerOrbitLimit = closestPlanet.orbitRadius + closestPlanet.radius + minimumOrbitClearance;
  return Math.max(outerOrbitLimit, minimumRadius);
};

interface SystemFleetMeshProps {
  fleet: Fleet;
  color: string;
  scale: number;
  geometry: ConeGeometry;
  ringGeometry: RingGeometry;
  isSelected: boolean;
  isHovered: boolean;
  showLabel: boolean;
  onHover: () => void;
  onBlur: () => void;
  onInteract: (
    event: ThreeEvent<MouseEvent | PointerEvent>,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => void;
}

const SystemFleetMesh: React.FC<SystemFleetMeshProps> = ({
  fleet,
  color,
  scale,
  geometry,
  ringGeometry,
  isSelected,
  isHovered,
  showLabel,
  onHover,
  onBlur,
  onInteract
}) => {
  const getFleetName = useFleetName();
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const chevronRotation = useMemo<[number, number, number]>(() => [-Math.PI / 2, 0, 0], []);
  const resolvePointerType = (event: any) => event?.pointerType || event?.nativeEvent?.pointerType || '';
  const emissiveIntensity = isSelected ? 0.75 : isHovered ? 0.55 : 0.35;
  const emphasisScale = isSelected ? 1.1 : isHovered ? 1.04 : 1;
  const verticalEmphasis = isSelected ? scale * 0.2 : isHovered ? scale * 0.08 : 0;
  const baseScale: [number, number, number] = useMemo(() => [scale, scale, scale], [scale]);
  const labelText = showLabel ? `${getFleetName(fleet.id)} [${fleet.ships.length}]` : '';

  return (
    <group position={[0, verticalEmphasis, 0]} scale={[emphasisScale, emphasisScale, emphasisScale]}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onInteract(event, { isDouble: false, pointerType: resolvePointerType(event) });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
        }}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
          onHover();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'auto';
          onBlur();
        }}
      >
        <sphereGeometry args={[1.6, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh
        geometry={geometry}
        rotation={chevronRotation}
        scale={baseScale}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.4}
          metalness={0.6}
        />
      </mesh>
      {isSelected && (
        <mesh
          geometry={ringGeometry}
          rotation={chevronRotation}
          scale={[scale * 1.1, scale * 1.1, scale * 1.1]}
        >
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
      )}
      {showLabel && (
        <Billboard position={[0, scale * 2.5, 0]}>
          <Text
            fontSize={scale * 1.1}
            color={color}
            outlineWidth={scale * 0.1}
            outlineColor="#000000"
            fontWeight="bold"
          >
            {labelText}
          </Text>
        </Billboard>
      )}
    </group>
  );
};

interface SystemFleetShipsProps {
  fleet: Fleet;
  scale: number;
  color: string;
  visible: boolean;
}

const SystemFleetShips: React.FC<SystemFleetShipsProps> = ({ fleet, scale, color, visible }) => {
  const meshRef = useRef<InstancedMesh>(null);
  const temp = useMemo(() => new Object3D(), []);
  const shipGeometry = useDisposableMemo(() => new ConeGeometry(0.35, 0.8, 6), []);
  const shipMaterial = useDisposableMemo(
    () => new MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, roughness: 0.5, metalness: 0.4 }),
    [color]
  );

  useLayoutEffect(() => {
    if (!meshRef.current) return;
    const total = fleet.ships.length;
    if (total === 0) return;
    const formationRadius = scale * 1.6;
    const shipScale = scale * 0.35;
    const yOffset = scale * 0.18;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    for (let i = 0; i < total; i += 1) {
      const t = (i + 0.5) / total;
      const radius = formationRadius * Math.sqrt(t);
      const angle = i * goldenAngle;
      temp.position.set(Math.cos(angle) * radius, yOffset, Math.sin(angle) * radius);
      temp.rotation.set(-Math.PI / 2, 0, angle);
      temp.scale.set(shipScale, shipScale, shipScale);
      temp.updateMatrix();
      meshRef.current.setMatrixAt(i, temp.matrix);
    }
    meshRef.current.count = total;
    meshRef.current.instanceMatrix.needsUpdate = true;
  }, [fleet.ships.length, scale, temp]);

  if (!visible || fleet.ships.length === 0) return null;

  return (
    <instancedMesh ref={meshRef} args={[shipGeometry, shipMaterial, fleet.ships.length]} />
  );
};

interface SystemStationMeshProps {
  station: Station;
  color: string;
  scale: number;
  geometry: TorusGeometry;
  coreGeometry: CylinderGeometry;
  ringGeometry: RingGeometry;
  isSelected: boolean;
  isHovered: boolean;
  showLabel: boolean;
  onHover: () => void;
  onBlur: () => void;
  onInteract: (
    event: ThreeEvent<MouseEvent | PointerEvent>,
    options?: { isDouble?: boolean; pointerType?: string }
  ) => void;
}

const SystemStationMesh: React.FC<SystemStationMeshProps> = ({
  station,
  color,
  scale,
  geometry,
  coreGeometry,
  ringGeometry,
  isSelected,
  isHovered,
  showLabel,
  onHover,
  onBlur,
  onInteract
}) => {
  const { t } = useI18n();
  const lastTouchRef = useRef<number>(0);
  const DOUBLE_TAP_MAX_DELAY_MS = 350;
  const emissiveIntensity = isSelected ? 0.65 : isHovered ? 0.45 : 0.25;
  const labelText = station.name ?? t('systemView.stationInfo.unnamedStation', { code: shortId(station.id) });
  const resolvePointerType = (event: any) => event?.pointerType || event?.nativeEvent?.pointerType || '';

  return (
    <group>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onInteract(event, { isDouble: false, pointerType: resolvePointerType(event) });
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          event.nativeEvent.preventDefault();
          onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
        }}
        onPointerDown={(event: ThreeEvent<PointerEvent>) => {
          if (event.pointerType !== 'touch') return;
          const now = performance.now();
          if (now - lastTouchRef.current < DOUBLE_TAP_MAX_DELAY_MS) {
            lastTouchRef.current = 0;
            event.stopPropagation();
            event.nativeEvent.preventDefault();
            onInteract(event, { isDouble: true, pointerType: resolvePointerType(event) });
          } else {
            lastTouchRef.current = now;
          }
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'pointer';
          onHover();
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          document.body.style.cursor = 'auto';
          onBlur();
        }}
      >
        <sphereGeometry args={[1.3, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh
        geometry={geometry}
        rotation={[Math.PI / 2, 0, 0]}
        scale={[scale, scale, scale]}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.5}
          metalness={0.5}
        />
      </mesh>
      <mesh
        geometry={coreGeometry}
        scale={[scale * 0.6, scale * 0.9, scale * 0.6]}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={emissiveIntensity}
          roughness={0.6}
          metalness={0.3}
        />
      </mesh>
      {isSelected && (
        <mesh
          geometry={ringGeometry}
          rotation={[-Math.PI / 2, 0, 0]}
          scale={[scale * 1.15, scale * 1.15, scale * 1.15]}
        >
          <meshBasicMaterial color={color} transparent opacity={0.6} />
        </mesh>
      )}
      {showLabel && (
        <Billboard position={[0, scale * 2.4, 0]}>
          <Text
            fontSize={scale * 1.05}
            color={color}
            outlineWidth={scale * 0.1}
            outlineColor="#000000"
            fontWeight="bold"
          >
            {labelText}
          </Text>
        </Billboard>
      )}
    </group>
  );
};

interface SystemEntitiesLayerProps {
  starBodyId: string;
  fleets: Fleet[];
  stations: Station[];
  day: number;
  starRadius: number;
  bodyWorldPositions: Record<string, [number, number, number]>;
  bodyRadii: Record<string, number>;
  clampedScale: number;
  selectedFleetId: string | null;
  selectedObjectId: SystemObjectId | null;
  hoveredObjectId: SystemObjectId | null;
  fleetIconScale: number;
  fleetLayoutConfig: TacticalRingConfig;
  getFactionColor: (id: string) => string;
  onHoverObject: (objectId: SystemObjectId) => void;
  onBlurObject: (objectId: SystemObjectId) => void;
  onSelectObject: (objectId: SystemObjectId) => void;
  onFocusPoint: (position: [number, number, number], radius: number) => void;
}

export const SystemEntitiesLayer: React.FC<SystemEntitiesLayerProps> = ({
  starBodyId,
  fleets,
  stations,
  day,
  starRadius,
  bodyWorldPositions,
  bodyRadii,
  clampedScale,
  selectedFleetId,
  selectedObjectId,
  hoveredObjectId,
  fleetIconScale,
  fleetLayoutConfig,
  getFactionColor,
  onHoverObject,
  onBlurObject,
  onSelectObject,
  onFocusPoint
}) => {
  const fleetGeometry = useDisposableMemo(() => new ConeGeometry(0.5, 1.2, 6), []);
  const stationGeometry = useDisposableMemo(() => new TorusGeometry(0.6, 0.18, 10, 24), []);
  const stationCoreGeometry = useDisposableMemo(() => new CylinderGeometry(0.35, 0.35, 0.8, 10), []);
  const selectionRingGeometry = useDisposableMemo(() => new RingGeometry(0.9, 1.15, 32), []);
  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  const fleetLayouts = useMemo(() => layoutTacticalRing(fleets, {
    ...fleetLayoutConfig
  }, day, { assumeSorted: true }), [day, fleetLayoutConfig, fleets]);

  const stationLayouts = useMemo(() => {
    const orderedStations = sorted(stations, (a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
    const slotCapacity = 8;
    const stationScale = 0.55 * clampedScale;
    const stationSpacing = Math.max(stationScale * 2.6, clampedScale * 0.9);
    const stationYOffset = stationScale * 0.3;

    return orderedStations.map((station, index) => {
      const anchorId = station.anchorBodyId ?? starBodyId;
      const anchorPosition = bodyWorldPositions[anchorId] ?? bodyWorldPositions[starBodyId] ?? [0, 0, 0];
      const anchorRadius = bodyRadii[anchorId] ?? starRadius;
      const baseRadius = Math.max(anchorRadius * 2.6, stationScale * 2.4);
      const slotIndex = typeof station.slotIndex === 'number' ? station.slotIndex : index;
      const ringIndex = typeof station.slotIndex === 'number'
        ? Math.floor(slotIndex / slotCapacity)
        : 0;
      const angle = typeof station.slotIndex === 'number'
        ? ((slotIndex % slotCapacity) / slotCapacity) * Math.PI * 2
        : hashStringToAngle(station.id);
      const radius = baseRadius + ringIndex * stationSpacing;
      const position: [number, number, number] = [
        anchorPosition[0] + Math.cos(angle) * radius,
        anchorPosition[1] + stationYOffset,
        anchorPosition[2] + Math.sin(angle) * radius
      ];
      return {
        station,
        position,
        scale: stationScale
      };
    });
  }, [bodyRadii, bodyWorldPositions, clampedScale, starBodyId, starRadius, stations]);

  return (
    <group name="SystemEntitiesLayer">
      {fleetLayouts.map(({ entity: fleet, position, angle }) => {
        const objectId = makeObjectId('fleet', fleet.id);
        const isHovered = hoveredObjectId === objectId;
        const isSelected = selectedFleetId === fleet.id || selectedObjectId === objectId;
        const showLabel = isHovered || isSelected;
        const color = getFactionColor(fleet.factionId);
        const shouldShowShips = isSelected;

        return (
          <group key={fleet.id} position={position} rotation={[0, angle, 0]}>
            <SystemFleetMesh
              fleet={fleet}
              color={color}
              scale={fleetIconScale}
              geometry={fleetGeometry}
              ringGeometry={selectionRingGeometry}
              isSelected={isSelected}
              isHovered={isHovered}
              showLabel={showLabel}
              onHover={() => onHoverObject(objectId)}
              onBlur={() => onBlurObject(objectId)}
              onInteract={(_, options) => {
                onSelectObject(objectId);
                if (options?.isDouble) {
                  onFocusPoint(position, fleetIconScale * 6);
                }
              }}
            />
            <SystemFleetShips
              fleet={fleet}
              scale={fleetIconScale}
              color={color}
              visible={shouldShowShips}
            />
          </group>
        );
      })}
      {stationLayouts.map(({ station, position, scale }) => {
        const objectId = makeObjectId('station', station.id);
        const isHovered = hoveredObjectId === objectId;
        const isSelected = selectedObjectId === objectId;
        const showLabel = isHovered || isSelected;
        const color = getFactionColor(station.factionId);

        return (
          <group key={station.id} position={position}>
            <SystemStationMesh
              station={station}
              color={color}
              scale={scale}
              geometry={stationGeometry}
              coreGeometry={stationCoreGeometry}
              ringGeometry={selectionRingGeometry}
              isSelected={isSelected}
              isHovered={isHovered}
              showLabel={showLabel}
              onHover={() => onHoverObject(objectId)}
              onBlur={() => onBlurObject(objectId)}
              onInteract={(_, options) => {
                onSelectObject(objectId);
                if (options?.isDouble) {
                  onFocusPoint(position, scale * 6);
                }
              }}
            />
          </group>
        );
      })}
    </group>
  );
};
