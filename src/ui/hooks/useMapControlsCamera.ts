import { useCallback, useEffect, useRef, useState } from 'react';
import { Vector3 } from 'three';
import type { Dispatch, PointerEvent as ReactPointerEvent, SetStateAction, WheelEvent as ReactWheelEvent } from 'react';

export interface ClampBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ClampScratch {
  offsetFromTarget: Vector3;
  safeDirection: Vector3;
  finalPosition: Vector3;
  boundedPosition: Vector3;
}

export const createClampScratch = (): ClampScratch => ({
  offsetFromTarget: new Vector3(),
  safeDirection: new Vector3(),
  finalPosition: new Vector3(),
  boundedPosition: new Vector3()
});

const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const clampCameraToBounds = (
  camera: Vector3,
  target: Vector3,
  mapBounds: ClampBounds,
  distanceLimits: { min: number; max: number },
  scratch: ClampScratch
): { targetChanged: boolean; positionChanged: boolean } => {
  const clampedTargetX = clampValue(target.x, mapBounds.minX, mapBounds.maxX);
  const clampedTargetZ = clampValue(target.z, mapBounds.minZ, mapBounds.maxZ);
  const targetChanged = clampedTargetX !== target.x || clampedTargetZ !== target.z;
  target.set(clampedTargetX, target.y, clampedTargetZ);

  scratch.offsetFromTarget.copy(camera).sub(target);
  const currentDistance = scratch.offsetFromTarget.length();
  const desiredDistance = clampValue(currentDistance || distanceLimits.min, distanceLimits.min, distanceLimits.max);

  scratch.safeDirection.copy(scratch.offsetFromTarget);
  if (scratch.safeDirection.lengthSq() === 0) {
    scratch.safeDirection.set(0, 1, 0);
  } else {
    scratch.safeDirection.normalize();
  }

  const maxDistanceWithinBounds = (() => {
    const distances: number[] = [];
    if (scratch.safeDirection.x > 0) {
      distances.push((mapBounds.maxX - target.x) / scratch.safeDirection.x);
    } else if (scratch.safeDirection.x < 0) {
      distances.push((mapBounds.minX - target.x) / scratch.safeDirection.x);
    }

    if (scratch.safeDirection.z > 0) {
      distances.push((mapBounds.maxZ - target.z) / scratch.safeDirection.z);
    } else if (scratch.safeDirection.z < 0) {
      distances.push((mapBounds.minZ - target.z) / scratch.safeDirection.z);
    }

    const positiveDistances = distances.filter(distance => distance >= 0);
    if (positiveDistances.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(...positiveDistances);
  })();

  const boundedDistance = Math.min(desiredDistance, maxDistanceWithinBounds);

  scratch.finalPosition.copy(target).addScaledVector(scratch.safeDirection, Math.max(0, boundedDistance));
  scratch.boundedPosition.set(
    clampValue(scratch.finalPosition.x, mapBounds.minX, mapBounds.maxX),
    scratch.finalPosition.y,
    clampValue(scratch.finalPosition.z, mapBounds.minZ, mapBounds.maxZ)
  );

  const positionChanged = !scratch.boundedPosition.equals(camera);
  if (positionChanged) {
    camera.copy(scratch.boundedPosition);
  }

  return { targetChanged, positionChanged };
};

export interface MapControlsCameraState {
  zoom: number;
  offset: { x: number; y: number };
}

type GestureState =
  | {
    type: 'pan';
    startPointer: { id: number; x: number; y: number };
    startCamera: MapControlsCameraState;
    movedSq: number;
  }
  | {
    type: 'pinch';
    startCenter: { x: number; y: number };
    startDistance: number;
    startCamera: MapControlsCameraState;
    startWorld: { x: number; y: number };
    movedSq: number;
  };

export interface MapControlsCameraOptions {
  camera: MapControlsCameraState;
  minZoom: number;
  maxZoom: number;
  clampOffset: (offset: MapControlsCameraState['offset'], zoom: number) => MapControlsCameraState['offset'];
  setCamera: Dispatch<SetStateAction<MapControlsCameraState>>;
  tapDragThresholdSq?: number;
}

export interface MapControlsCameraHandlers {
  handleWheel: (event: ReactWheelEvent<HTMLElement>) => void;
  handlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  handlePointerMove: (event: ReactPointerEvent<HTMLElement>) => boolean;
  handlePointerUp: (event: ReactPointerEvent<HTMLElement>) => boolean;
  handlePointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  isInteracting: boolean;
}

const computeCenterAndDistance = (points: Array<{ x: number; y: number }>) => {
  const [a, b] = points;
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  return { center, distance: Math.max(distance, 0.0001) };
};

export const zoomAroundPoint = (
  camera: MapControlsCameraState,
  focus: { x: number; y: number },
  targetZoom: number,
  clampOffset: (offset: MapControlsCameraState['offset'], zoom: number) => MapControlsCameraState['offset'],
  minZoom: number,
  maxZoom: number
): MapControlsCameraState => {
  const clampedZoom = clampValue(targetZoom, minZoom, maxZoom);
  const worldX = (focus.x - camera.offset.x) / camera.zoom;
  const worldY = (focus.y - camera.offset.y) / camera.zoom;
  const nextOffset = clampOffset(
    {
      x: focus.x - worldX * clampedZoom,
      y: focus.y - worldY * clampedZoom
    },
    clampedZoom
  );

  return { zoom: clampedZoom, offset: nextOffset };
};

export const useMapControlsCamera = ({
  camera,
  clampOffset,
  maxZoom,
  minZoom,
  setCamera,
  tapDragThresholdSq = 36
}: MapControlsCameraOptions): MapControlsCameraHandlers => {
  const cameraRef = useRef(camera);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<GestureState | null>(null);
  const [isInteracting, setIsInteracting] = useState(false);

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  const getPoint = useCallback((event: ReactPointerEvent<HTMLElement> | ReactWheelEvent<HTMLElement>) => {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }, []);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLElement>) => {
    const focus = getPoint(event);
    if (!focus) return;
    event.preventDefault();

    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;
    setCamera(prev => zoomAroundPoint(prev, focus, prev.zoom * zoomFactor, clampOffset, minZoom, maxZoom));
  }, [clampOffset, getPoint, maxZoom, minZoom, setCamera]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const point = getPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, point);

    if (pointersRef.current.size === 1) {
      gestureRef.current = {
        type: 'pan',
        startPointer: { id: event.pointerId, ...point },
        startCamera: cameraRef.current,
        movedSq: 0
      };
    } else if (pointersRef.current.size >= 2) {
      const points = Array.from(pointersRef.current.values()).slice(0, 2);
      const { center, distance } = computeCenterAndDistance(points);
      gestureRef.current = {
        type: 'pinch',
        startCenter: center,
        startDistance: distance,
        startCamera: cameraRef.current,
        startWorld: {
          x: (center.x - cameraRef.current.offset.x) / cameraRef.current.zoom,
          y: (center.y - cameraRef.current.offset.y) / cameraRef.current.zoom
        },
        movedSq: 0
      };
    }
  }, [getPoint]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return gestureRef.current !== null;
    const point = getPoint(event);
    if (!point) return gestureRef.current !== null;
    pointersRef.current.set(event.pointerId, point);

    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      const { center, distance } = computeCenterAndDistance(points.slice(0, 2));
      let gesture = gestureRef.current;
      if (!gesture || gesture.type !== 'pinch') {
        gesture = {
          type: 'pinch',
          startCenter: center,
          startDistance: distance,
          startCamera: cameraRef.current,
          startWorld: {
            x: (center.x - cameraRef.current.offset.x) / cameraRef.current.zoom,
            y: (center.y - cameraRef.current.offset.y) / cameraRef.current.zoom
          },
          movedSq: 0
        };
        gestureRef.current = gesture;
      }

      const scale = distance / gesture.startDistance;
      const targetZoom = gesture.startCamera.zoom * scale;
      
      // Use startWorld as the anchor point to prevent drift when the pinch center moves
      // Calculate the offset so that startWorld remains at the same screen position
      const clampedZoom = clampValue(targetZoom, minZoom, maxZoom);
      const nextOffset = clampOffset(
        {
          x: center.x - gesture.startWorld.x * clampedZoom,
          y: center.y - gesture.startWorld.y * clampedZoom
        },
        clampedZoom
      );
      
      const nextCamera = { zoom: clampedZoom, offset: nextOffset };
      gesture.movedSq = Math.max(
        gesture.movedSq,
        (center.x - gesture.startCenter.x) ** 2 + (center.y - gesture.startCenter.y) ** 2
      );
      setCamera(() => nextCamera);
      setIsInteracting(true);
      return true;
    }

    if (points.length === 1 && gestureRef.current?.type === 'pan') {
      const gesture = gestureRef.current;
      const dx = point.x - gesture.startPointer.x;
      const dy = point.y - gesture.startPointer.y;
      const movedSq = dx * dx + dy * dy;
      gesture.movedSq = Math.max(gesture.movedSq, movedSq);

      setCamera(prev => ({
        zoom: prev.zoom,
        offset: clampOffset(
          {
            x: gesture.startCamera.offset.x + dx,
            y: gesture.startCamera.offset.y + dy
          },
          prev.zoom
        )
      }));
      if (gesture.movedSq >= tapDragThresholdSq) {
        setIsInteracting(true);
      }
      return true;
    }

    return gestureRef.current !== null;
  }, [clampOffset, getPoint, maxZoom, minZoom, setCamera, tapDragThresholdSq]);

  const resetGestureFromPointers = useCallback(() => {
    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      const { center, distance } = computeCenterAndDistance(points.slice(0, 2));
      gestureRef.current = {
        type: 'pinch',
        startCenter: center,
        startDistance: distance,
        startCamera: cameraRef.current,
        startWorld: {
          x: (center.x - cameraRef.current.offset.x) / cameraRef.current.zoom,
          y: (center.y - cameraRef.current.offset.y) / cameraRef.current.zoom
        },
        movedSq: 0
      };
    } else if (points.length === 1) {
      const [only] = points;
      gestureRef.current = {
        type: 'pan',
        startPointer: { id: pointersRef.current.keys().next().value ?? 0, ...only },
        startCamera: cameraRef.current,
        movedSq: 0
      };
    } else {
      gestureRef.current = null;
      setIsInteracting(false);
    }
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    pointersRef.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    const wasTap = gesture?.type === 'pan' && (gesture.movedSq ?? 0) < tapDragThresholdSq && pointersRef.current.size === 0;
    resetGestureFromPointers();
    if (pointersRef.current.size === 0) {
      setIsInteracting(false);
    }
    return Boolean(wasTap);
  }, [resetGestureFromPointers, tapDragThresholdSq]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    pointersRef.current.delete(event.pointerId);
    gestureRef.current = null;
    setIsInteracting(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }, []);

  return {
    handleWheel,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    isInteracting
  };
};
