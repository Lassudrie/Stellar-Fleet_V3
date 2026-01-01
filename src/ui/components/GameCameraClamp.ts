import { Vector3 } from 'three';

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
  boundedPosition: new Vector3(),
});

export const clampCameraToBounds = (
  camera: Vector3,
  target: Vector3,
  mapBounds: ClampBounds,
  distanceLimits: { min: number; max: number },
  scratch: ClampScratch
): { targetChanged: boolean; positionChanged: boolean } => {
  const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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

    const positiveDistances = distances.filter((distance) => distance >= 0);
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
