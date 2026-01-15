import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { PerspectiveCamera, MapControls } from '@react-three/drei';
import { MapControls as ThreeMapControls } from 'three-stdlib';
import { TOUCH, Vector3 } from 'three';
import { Vec3 } from '../../engine/math/vec3';
import { clampCameraToBounds, ClampBounds, ClampScratch, createClampScratch } from '../hooks';

interface GameCameraProps {
  initialPosition?: Vec3 | [number, number, number];
  initialTarget?: Vec3 | [number, number, number];
  focusTarget?: Vec3 | [number, number, number] | null;
  ready?: boolean;
  mapRadius?: number;
  mapBounds?: ClampBounds;
  distanceLimits?: { min: number; max: number };
  zoomTargetDistance?: number;
  onDistanceChange?: (distance: number) => void;
  enableRotate?: boolean;
  minPolarAngle?: number;
  maxPolarAngle?: number;
}

const CAMERA_FOV = 35;

const GameCamera: React.FC<GameCameraProps> = React.memo(({
  initialPosition,
  initialTarget,
  focusTarget,
  ready,
  mapRadius,
  mapBounds,
  distanceLimits,
  zoomTargetDistance,
  onDistanceChange,
  enableRotate = false,
  minPolarAngle,
  maxPolarAngle
}) => {
  const controlsRef = useRef<ThreeMapControls>(null);
  const hasInitialized = useRef(false);
  const isClampingRef = useRef(false);
  const clampScratchRef = useRef<ClampScratch>(createClampScratch());
  const focusVectorRef = useRef<Vector3>(new Vector3());
  const desiredPositionRef = useRef<Vector3>(new Vector3());
  const offsetRef = useRef<Vector3>(new Vector3());
  const clampControlsRef = useRef<(options?: { skipUpdate?: boolean }) => void>(() => {});
  const mapBoundsRef = useRef<ClampBounds | null | undefined>(mapBounds);

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
    if (distanceLimits) {
      const minDistance = Math.max(distanceLimits.min, 0.1);
      const maxDistance = Math.max(distanceLimits.max, minDistance);
      return { minDistance, maxDistance };
    }
    const fallbackRadius = 120;
    const radius = Math.max(mapRadius ?? fallbackRadius, 1);
    const halfFovRad = (CAMERA_FOV * Math.PI) / 360;
    const fitDistance = radius / Math.sin(halfFovRad);

    const maxDistance = Math.max(radius * 2.5, fallbackRadius * 2, fitDistance);
    const minDistance = Math.min(Math.max(20, radius * 0.3), maxDistance * 0.8);

    return { minDistance, maxDistance };
  }, [distanceLimits, mapRadius]);

  const polarLimits = useMemo(() => ({
    min: minPolarAngle ?? Math.PI / 8,
    max: maxPolarAngle ?? Math.PI / 2,
  }), [maxPolarAngle, minPolarAngle]);

  const touchConfig = useMemo(() => ({
    ONE: TOUCH.PAN,
    TWO: TOUCH.DOLLY_PAN
  }), []);

  const cameraBounds = useMemo<ClampBounds | null>(() => {
    if (!mapBounds) return null;
    const offset = new Vector3(
      positionArray[0] - targetArray[0],
      positionArray[1] - targetArray[1],
      positionArray[2] - targetArray[2]
    );
    const length = offset.length();
    if (length === 0) return mapBounds;
    offset.divideScalar(length);
    const paddingX = Math.abs(offset.x) * distanceConfig.maxDistance;
    const paddingZ = Math.abs(offset.z) * distanceConfig.maxDistance;
    return {
      minX: mapBounds.minX - paddingX,
      maxX: mapBounds.maxX + paddingX,
      minZ: mapBounds.minZ - paddingZ,
      maxZ: mapBounds.maxZ + paddingZ
    };
  }, [distanceConfig.maxDistance, mapBounds, positionArray, targetArray]);

  const clampControls = useCallback((options?: { skipUpdate?: boolean }) => {
    if (!controlsRef.current || !mapBounds) return;
    if (isClampingRef.current) return;
    isClampingRef.current = true;
    try {
      const { object: camera, target, minDistance, maxDistance } = controlsRef.current;
      const distanceLimits = {
        min: minDistance ?? distanceConfig.minDistance,
        max: maxDistance ?? distanceConfig.maxDistance
      };

      const result = clampCameraToBounds(
        camera.position,
        target,
        mapBounds,
        distanceLimits,
        clampScratchRef.current,
        cameraBounds ?? mapBounds
      );

      if (!options?.skipUpdate && (result.targetChanged || result.positionChanged)) {
        controlsRef.current.update();
      }
    } finally {
      isClampingRef.current = false;
    }
  }, [cameraBounds, mapBounds, distanceConfig.maxDistance, distanceConfig.minDistance]);

  useEffect(() => {
    clampControlsRef.current = clampControls;
  }, [clampControls]);

  useEffect(() => {
    mapBoundsRef.current = mapBounds;
  }, [mapBounds]);

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

  useEffect(() => {
    if (!focusTarget || !controlsRef.current || !ready) return;

    const targetX = Array.isArray(focusTarget) ? focusTarget[0] : focusTarget.x;
    const targetY = Array.isArray(focusTarget) ? focusTarget[1] : focusTarget.y;
    const targetZ = Array.isArray(focusTarget) ? focusTarget[2] : focusTarget.z;

    const bounds = mapBoundsRef.current ?? null;
    const clampedX = bounds ? Math.min(bounds.maxX, Math.max(bounds.minX, targetX)) : targetX;
    const clampedZ = bounds ? Math.min(bounds.maxZ, Math.max(bounds.minZ, targetZ)) : targetZ;

    focusVectorRef.current.set(clampedX, targetY, clampedZ);

    let frameId: number | null = null;

    const animate = () => {
      if (!controlsRef.current) return;

      const camera = controlsRef.current.object;
      const target = controlsRef.current.target;
      const focusVec = focusVectorRef.current;

      offsetRef.current.copy(camera.position).sub(target);
      desiredPositionRef.current.copy(focusVec).add(offsetRef.current);

      target.lerp(focusVec, 0.12);
      camera.position.lerp(desiredPositionRef.current, 0.12);

      controlsRef.current.update();
      clampControlsRef.current();

      const targetDelta = target.distanceTo(focusVec);
      const positionDelta = camera.position.distanceTo(desiredPositionRef.current);

      if (targetDelta > 0.01 || positionDelta > 0.01) {
        frameId = requestAnimationFrame(animate);
      }
    };

    frameId = requestAnimationFrame(animate);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [focusTarget, ready]);

  useEffect(() => {
    if (!ready || zoomTargetDistance === undefined || !controlsRef.current) return;

    const controls = controlsRef.current;
    const desiredDistance = Math.max(
      distanceConfig.minDistance,
      Math.min(distanceConfig.maxDistance, zoomTargetDistance)
    );
    const currentDistance = controls.object.position.distanceTo(controls.target);

    if (Math.abs(currentDistance - desiredDistance) < 0.01) return;

    let frameId: number | null = null;

    const animate = () => {
      if (!controlsRef.current) return;

      const camera = controlsRef.current.object;
      const target = controlsRef.current.target;

      offsetRef.current.copy(camera.position).sub(target);
      const distance = offsetRef.current.length();
      if (distance === 0) return;

      const nextDistance = distance + (desiredDistance - distance) * 0.18;
      offsetRef.current.multiplyScalar(nextDistance / distance);
      camera.position.copy(target).add(offsetRef.current);

      controlsRef.current.update();
      clampControlsRef.current();

      if (Math.abs(nextDistance - desiredDistance) > 0.02) {
        frameId = requestAnimationFrame(animate);
      }
    };

    frameId = requestAnimationFrame(animate);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [distanceConfig.maxDistance, distanceConfig.minDistance, ready, zoomTargetDistance]);

  return (
    <>
      {/*
        PerspectiveCamera:
        - position: configurable pour centrer la scène sur le homeworld.
        - fov: 35 pour aplatir légèrement la perspective (effet isométrique).
      */}
      <PerspectiveCamera makeDefault position={positionArray} fov={CAMERA_FOV} />

      {/*
        MapControls:
        - Idéal pour les RTS/Cartes.
        - screenSpacePanning={false} : Le pan suit le sol (plan XZ), pas l'écran.
        - dampingFactor : Ajoute de l'inertie fluide.
      */}
      <MapControls
        ref={controlsRef}
        target={targetArray}
        enableRotate={enableRotate}
        enablePan={true}
        enableZoom={true}
        touches={touchConfig}
        minDistance={distanceConfig.minDistance}
        maxDistance={distanceConfig.maxDistance}
        dampingFactor={0.05}
        minPolarAngle={polarLimits.min}
        maxPolarAngle={polarLimits.max}
        screenSpacePanning={false}
        onChange={() => {
          clampControls({ skipUpdate: true });
          if (!ready || !onDistanceChange || !controlsRef.current) return;
          const { object, target } = controlsRef.current;
          onDistanceChange(object.position.distanceTo(target));
        }}
      />
    </>
  );
});

export default GameCamera;
