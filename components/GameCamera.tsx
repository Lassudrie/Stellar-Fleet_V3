import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { PerspectiveCamera, MapControls } from '@react-three/drei';
import { MapControls as ThreeMapControls } from 'three-stdlib';
import { Vector3 } from 'three';
import { Vec3 } from '../engine/math/vec3';

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

    const { object: camera, target, minDistance, maxDistance } = controlsRef.current;
    const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    const direction = new Vector3().subVectors(camera.position, target);

    const clampedTargetX = clampValue(target.x, mapBounds.minX, mapBounds.maxX);
    const clampedTargetZ = clampValue(target.z, mapBounds.minZ, mapBounds.maxZ);
    const targetChanged = clampedTargetX !== target.x || clampedTargetZ !== target.z;

    target.set(clampedTargetX, target.y, clampedTargetZ);

    const desiredPosition = new Vector3().addVectors(target, direction);
    const clampedPositionX = clampValue(desiredPosition.x, mapBounds.minX, mapBounds.maxX);
    const clampedPositionZ = clampValue(desiredPosition.z, mapBounds.minZ, mapBounds.maxZ);
    desiredPosition.setX(clampedPositionX).setZ(clampedPositionZ);

    const offsetFromTarget = new Vector3().subVectors(desiredPosition, target);
    const currentDistance = offsetFromTarget.length();
    const distanceLimits = {
      min: minDistance ?? distanceConfig.minDistance,
      max: maxDistance ?? distanceConfig.maxDistance
    };

    const clampedDistance = clampValue(currentDistance || distanceLimits.min, distanceLimits.min, distanceLimits.max);

    const safeDirection = offsetFromTarget.lengthSq() === 0
      ? new Vector3(0, 1, 0)
      : offsetFromTarget.normalize();

    const finalPosition = new Vector3().addVectors(target, safeDirection.multiplyScalar(clampedDistance));
    const boundedPosition = new Vector3(
      clampValue(finalPosition.x, mapBounds.minX, mapBounds.maxX),
      finalPosition.y,
      clampValue(finalPosition.z, mapBounds.minZ, mapBounds.maxZ)
    );

    const positionChanged = !boundedPosition.equals(camera.position);

    if (targetChanged || positionChanged) {
      camera.position.copy(boundedPosition);
      controlsRef.current.update();
    }
  }, [mapBounds, distanceConfig.maxDistance, distanceConfig.minDistance]);

  useEffect(() => {
    if (!ready || !controlsRef.current) return;
    const controls = controlsRef.current;

    controls.object.position.set(...positionArray);
    controls.target.set(...targetArray);
    controls.object.up.set(0, 1, 0);
    controls.object.lookAt(...targetArray);
    controls.update();
    clampControls();
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
