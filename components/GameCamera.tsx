import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { PerspectiveCamera, MapControls } from '@react-three/drei';
import { MapControls as ThreeMapControls } from 'three-stdlib';
import { Vector3 } from 'three';
import { Vec3 } from '../engine/math/vec3';

export interface CameraVectorPool {
  direction: Vector3;
  desired: Vector3;
  offset: Vector3;
  safeDirection: Vector3;
  final: Vector3;
  bounded: Vector3;
}

export interface CameraBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ClampDistanceConfig {
  minDistance: number;
  maxDistance: number;
}

type ClampableControls = Pick<ThreeMapControls, 'object' | 'target' | 'minDistance' | 'maxDistance' | 'update'>;

export const clampCameraToBounds = (
  controls: ClampableControls,
  mapBounds: CameraBounds,
  distanceConfig: ClampDistanceConfig,
  vectors: CameraVectorPool
) => {
  const { object: camera, target, minDistance, maxDistance } = controls;
  const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const { direction, desired, offset, safeDirection, final, bounded } = vectors;

  direction.subVectors(camera.position, target);

  const clampedTargetX = clampValue(target.x, mapBounds.minX, mapBounds.maxX);
  const clampedTargetZ = clampValue(target.z, mapBounds.minZ, mapBounds.maxZ);
  const targetChanged = clampedTargetX !== target.x || clampedTargetZ !== target.z;

  target.set(clampedTargetX, target.y, clampedTargetZ);

  desired.addVectors(target, direction);
  const clampedPositionX = clampValue(desired.x, mapBounds.minX, mapBounds.maxX);
  const clampedPositionZ = clampValue(desired.z, mapBounds.minZ, mapBounds.maxZ);
  desired.setX(clampedPositionX).setZ(clampedPositionZ);

  offset.subVectors(desired, target);
  const currentDistance = offset.length();
  const distanceLimits = {
    min: minDistance ?? distanceConfig.minDistance,
    max: maxDistance ?? distanceConfig.maxDistance
  };

  const clampedDistance = clampValue(currentDistance || distanceLimits.min, distanceLimits.min, distanceLimits.max);

  if (offset.lengthSq() === 0) {
    safeDirection.set(0, 1, 0);
  } else {
    safeDirection.copy(offset).normalize();
  }

  final.addVectors(target, safeDirection.multiplyScalar(clampedDistance));
  bounded.set(
    clampValue(final.x, mapBounds.minX, mapBounds.maxX),
    final.y,
    clampValue(final.z, mapBounds.minZ, mapBounds.maxZ)
  );

  const positionChanged = !bounded.equals(camera.position);

  if (targetChanged || positionChanged) {
    camera.position.copy(bounded);
    controls.update();
  }
};

interface GameCameraProps {
  initialPosition?: Vec3 | [number, number, number];
  initialTarget?: Vec3 | [number, number, number];
  ready?: boolean;
  mapRadius?: number;
  mapBounds?: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
}

const GameCamera: React.FC<GameCameraProps> = React.memo(({ initialPosition, initialTarget, ready, mapRadius, mapBounds }) => {
  const controlsRef = useRef<ThreeMapControls>(null);
  const hasInitialized = useRef(false);
  const vectorPoolRef = useRef({
    direction: new Vector3(),
    desired: new Vector3(),
    offset: new Vector3(),
    safeDirection: new Vector3(),
    final: new Vector3(),
    bounded: new Vector3()
  });

  const targetArray = useMemo<[number, number, number]>(() => {
    if (!initialTarget) return [0, 0, 0];
    if (Array.isArray(initialTarget)) return initialTarget;
    return [initialTarget.x, initialTarget.y, initialTarget.z];
  }, [initialTarget]);

  const positionArray = useMemo<[number, number, number]>(() => {
    if (!initialPosition) return [0, 80, 50];
    if (Array.isArray(initialPosition)) return initialPosition;
    return [initialPosition.x, initialPosition.y, initialPosition.z];
  }, [initialPosition]);

  const distanceConfig = useMemo(() => {
    const fallbackRadius = 120;
    const radius = Math.max(mapRadius ?? fallbackRadius, 1);

    const maxDistance = Math.max(radius * 2.5, fallbackRadius * 2);
    const minDistance = Math.min(Math.max(20, radius * 0.3), maxDistance * 0.8);

    return { minDistance, maxDistance };
  }, [mapRadius]);

  const clampControls = useCallback(() => {
    if (!controlsRef.current || !mapBounds) return;

    clampCameraToBounds(controlsRef.current, mapBounds, distanceConfig, vectorPoolRef.current);
  }, [mapBounds, distanceConfig.maxDistance, distanceConfig.minDistance]);

  useEffect(() => {
    if (!ready) {
      hasInitialized.current = false;
    }
  }, [ready]);

  useEffect(() => {
    if (!ready || hasInitialized.current || !controlsRef.current) return;
    const controls = controlsRef.current;

    controls.object.position.set(...positionArray);
    controls.target.set(...targetArray);
    controls.object.up.set(0, 1, 0);
    controls.object.lookAt(...targetArray);
    controls.update();
    clampControls();

    hasInitialized.current = true;
  }, [ready, targetArray, positionArray, clampControls]);

  useEffect(() => {
    clampControls();
  }, [clampControls, mapBounds]);

  return (
    <>
      {/*
        PerspectiveCamera:
        - position: configurable pour centrer la scène sur le homeworld.
        - fov: 35 pour aplatir légèrement la perspective (effet isométrique).
      */}
      <PerspectiveCamera makeDefault position={positionArray} fov={35} />

      {/*
        MapControls:
        - Idéal pour les RTS/Cartes.
        - enableRotate={false} : Verrouille la rotation (pas de pivot).
        - screenSpacePanning={false} : Le pan suit le sol (plan XZ), pas l'écran.
        - dampingFactor : Ajoute de l'inertie fluide.
      */}
      <MapControls
        ref={controlsRef}
        target={targetArray}
        enableRotate={false}
        enablePan={true}
        enableZoom={true}
        minDistance={distanceConfig.minDistance}
        maxDistance={distanceConfig.maxDistance}
        dampingFactor={0.05}
        screenSpacePanning={false}
        onChange={clampControls}
      />
    </>
  );
});

export default GameCamera;
