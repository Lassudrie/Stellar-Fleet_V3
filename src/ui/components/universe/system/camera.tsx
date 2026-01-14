import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { MathUtils, Spherical, Vector3 } from 'three';

export type SystemCameraState = {
  theta: number;
  phi: number;
  radius: number;
  anchoredBodyId?: string;
  position?: [number, number, number];
  target?: [number, number, number];
};

export type CameraSphericalState = {
  theta: number;
  phi: number;
  radius: number;
};

export type FocusRequest = {
  target: Vector3;
  distance: number;
};

const MIN_POLAR_ANGLE = 0.15;
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;

const clampPhi = (phi: number): number => MathUtils.clamp(phi, MIN_POLAR_ANGLE, MAX_POLAR_ANGLE);

export const sphericalFromOffset = (offset: Vector3): CameraSphericalState => {
  const spherical = new Spherical().setFromVector3(offset);
  return {
    theta: spherical.theta,
    phi: clampPhi(spherical.phi),
    radius: Math.max(spherical.radius, 0.001)
  };
};

export const deriveSphericalState = (
  state: SystemCameraState | undefined,
  anchoredTarget: [number, number, number],
  fallbackPosition: [number, number, number]
): CameraSphericalState => {
  if (state?.theta !== undefined && state?.phi !== undefined && state?.radius !== undefined) {
    return {
      theta: state.theta,
      phi: clampPhi(state.phi),
      radius: Math.max(state.radius, 0.001)
    };
  }

  const anchorTargetVec = new Vector3(...anchoredTarget);
  const positionVec = state?.position ? new Vector3(...state.position) : new Vector3(...fallbackPosition);
  const offset = positionVec.sub(anchorTargetVec);
  return sphericalFromOffset(offset);
};

export const positionFromSpherical = (state: CameraSphericalState, target: [number, number, number]): [number, number, number] => {
  const targetVec = new Vector3(...target);
  const spherical = new Spherical(state.radius, clampPhi(state.phi), state.theta);
  const positionVec = new Vector3().setFromSpherical(spherical).add(targetVec);
  return [positionVec.x, positionVec.y, positionVec.z];
};

export const SystemCamera: React.FC<{
  maxDistance: number;
  minDistance: number;
  focusRequest: React.MutableRefObject<FocusRequest | null>;
  initialSpherical: CameraSphericalState;
  onCameraStateChange?: (state: SystemCameraState) => void;
  lastCameraStateRef: React.MutableRefObject<SystemCameraState>;
  anchoredTarget: [number, number, number];
  anchoredBodyId?: string;
  rotateSpeed: number;
  zoomSpeed: number;
  cameraNear: number;
  cameraFar: number;
}> = ({
  maxDistance,
  minDistance,
  focusRequest,
  initialSpherical,
  onCameraStateChange,
  lastCameraStateRef,
  anchoredTarget,
  anchoredBodyId,
  rotateSpeed,
  zoomSpeed,
  cameraNear,
  cameraFar
}) => {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const { camera } = useThree();
  const initialPosition = useMemo<[number, number, number]>(() => positionFromSpherical(initialSpherical, anchoredTarget), [
    anchoredTarget,
    initialSpherical.phi,
    initialSpherical.radius,
    initialSpherical.theta
  ]);
  const targetRef = useRef<Vector3>(new Vector3(...anchoredTarget));
  const desiredTargetRef = useRef<Vector3>(targetRef.current.clone());
  const initialDistance = useMemo(() => {
    const distance = Math.max(initialSpherical.radius, minDistance);
    const fallbackDistance = maxDistance * 0.6;
    return Math.max(distance || fallbackDistance, minDistance);
  }, [initialSpherical.radius, maxDistance, minDistance]);
  const desiredDistanceRef = useRef<number>(initialDistance);
  const isUserInteractingRef = useRef(false);
  const workingVector = useMemo(() => new Vector3(), []);
  const hasInitializedRef = useRef(false);
  const syncDesiredDistanceFromControls = useCallback(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const distance = controls.object.position.distanceTo(controls.target);
    desiredDistanceRef.current = MathUtils.clamp(distance, minDistance, maxDistance);
  }, [maxDistance, minDistance]);

  useEffect(() => {
    camera.near = cameraNear;
    camera.far = cameraFar;
    camera.updateProjectionMatrix();
  }, [camera, cameraFar, cameraNear]);

  useLayoutEffect(() => {
    if (hasInitializedRef.current) return;
    camera.position.set(...initialPosition);
    targetRef.current.set(...anchoredTarget);
    desiredTargetRef.current.copy(targetRef.current);
    desiredDistanceRef.current = MathUtils.clamp(initialDistance, minDistance, maxDistance);
    controlsRef.current?.target.copy(targetRef.current);
    controlsRef.current?.update();
    lastCameraStateRef.current = {
      ...sphericalFromOffset(workingVector.copy(camera.position).sub(targetRef.current)),
      anchoredBodyId
    };
    hasInitializedRef.current = true;
  }, [
    anchoredBodyId,
    anchoredTarget,
    camera,
    initialDistance,
    initialPosition,
    lastCameraStateRef,
    maxDistance,
    minDistance,
    workingVector
  ]);

  useEffect(() => {
    return () => {
      if (onCameraStateChange) {
        onCameraStateChange(lastCameraStateRef.current);
      }
    };
  }, [lastCameraStateRef, onCameraStateChange]);

  useEffect(() => {
    desiredTargetRef.current.set(...anchoredTarget);
  }, [anchoredTarget]);

  useEffect(() => {
    desiredDistanceRef.current = MathUtils.clamp(desiredDistanceRef.current, minDistance, maxDistance);
  }, [maxDistance, minDistance]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    const pendingFocus = focusRequest.current;
    if (pendingFocus) {
      desiredTargetRef.current.copy(pendingFocus.target);
      desiredDistanceRef.current = MathUtils.clamp(pendingFocus.distance, minDistance, maxDistance);
      focusRequest.current = null;
    }

    const lerpAlpha = 1 - Math.exp(-6 * delta);
    targetRef.current.lerp(desiredTargetRef.current, lerpAlpha);

    const currentDirection = workingVector.copy(camera.position).sub(targetRef.current);
    const currentDistance = currentDirection.length();
    const nextDistance = MathUtils.damp(currentDistance, desiredDistanceRef.current, 8, delta);
    const clampedDistance = MathUtils.clamp(nextDistance, minDistance, maxDistance);

    const nextPosition = currentDirection.setLength(clampedDistance).add(targetRef.current);
    camera.position.copy(nextPosition);
    controls.target.copy(targetRef.current);
    controls.update();

    lastCameraStateRef.current = {
      ...sphericalFromOffset(workingVector.copy(camera.position).sub(targetRef.current)),
      anchoredBodyId
    };
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enableDamping
      dampingFactor={0.2}
      enablePan={false}
      minDistance={minDistance}
      minPolarAngle={MIN_POLAR_ANGLE}
      maxPolarAngle={MAX_POLAR_ANGLE}
      maxDistance={maxDistance}
      rotateSpeed={rotateSpeed}
      zoomSpeed={zoomSpeed}
      onStart={() => {
        isUserInteractingRef.current = true;
      }}
      onEnd={() => {
        isUserInteractingRef.current = false;
        syncDesiredDistanceFromControls();
      }}
      onChange={() => {
        if (isUserInteractingRef.current) {
          syncDesiredDistanceFromControls();
        }
      }}
    />
  );
};
