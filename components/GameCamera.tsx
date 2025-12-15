import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { PerspectiveCamera, MapControls } from '@react-three/drei';
import { MapControls as ThreeMapControls } from 'three-stdlib';
import { useThree } from '@react-three/fiber';
import { Vec3 } from '../engine/math/vec3';
import { Vector3 } from 'three';

interface GameCameraProps {
  initialPosition?: Vec3 | [number, number, number];
  initialTarget?: Vec3 | [number, number, number];
  ready?: boolean;
  mapBounds?: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
}

const GameCamera: React.FC<GameCameraProps> = React.memo(({ initialPosition, initialTarget, ready, mapBounds }) => {
  const controlsRef = useRef<ThreeMapControls>(null);
  const mapBoundsRef = useRef(mapBounds);
  const isUpdatingRef = useRef(false);
  const { camera } = useThree();

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

  useEffect(() => {
    mapBoundsRef.current = mapBounds;
  }, [mapBounds]);

  const clampValue = useCallback((value: number, min: number, max: number) => {
    return Math.min(Math.max(value, min), max);
  }, []);

  const clampToBounds = useCallback(() => {
    const bounds = mapBoundsRef.current;
    const controls = controlsRef.current;

    if (!bounds || !controls || isUpdatingRef.current) {
      return;
    }

    isUpdatingRef.current = true;

    const currentTarget = controls.target;
    const clampedTargetX = clampValue(currentTarget.x, bounds.minX, bounds.maxX);
    const clampedTargetZ = clampValue(currentTarget.z, bounds.minZ, bounds.maxZ);
    currentTarget.set(clampedTargetX, currentTarget.y, clampedTargetZ);

    const offset = new Vector3().copy(camera.position).sub(currentTarget);
    const distance = offset.length();
    const minDistance = controls.minDistance ?? distance;
    const maxDistance = controls.maxDistance ?? distance;
    const clampedDistance = clampValue(distance, minDistance, maxDistance);

    if (distance > 0) {
      offset.setLength(clampedDistance);
    } else {
      offset.set(clampedDistance, offset.y, offset.z);
    }

    camera.position.copy(currentTarget).add(offset);
    camera.position.x = clampValue(camera.position.x, bounds.minX, bounds.maxX);
    camera.position.z = clampValue(camera.position.z, bounds.minZ, bounds.maxZ);

    controls.update();
    isUpdatingRef.current = false;
  }, [camera, clampValue]);

  useEffect(() => {
    if (!ready || !controlsRef.current) return;
    controlsRef.current.target.set(...targetArray);
    controlsRef.current.update();
    clampToBounds();
  }, [clampToBounds, ready, targetArray]);

  useEffect(() => {
    if (mapBounds) {
      clampToBounds();
    }
  }, [clampToBounds, mapBounds]);

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
        minDistance={20}
        maxDistance={250}
        dampingFactor={0.05}
        screenSpacePanning={false}
        onChange={clampToBounds}
      />
    </>
  );
});

export default GameCamera;