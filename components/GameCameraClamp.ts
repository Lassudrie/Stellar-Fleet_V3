import { Vector3 } from 'three';

export interface ClampBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ClampScratch {
  direction: Vector3;
  desiredPosition: Vector3;
  offsetFromTarget: Vector3;
  safeDirection: Vector3;
  finalPosition: Vector3;
  boundedPosition: Vector3;
}

export const createClampScratch = (): ClampScratch => ({
  direction: new Vector3(),
  desiredPosition: new Vector3(),
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

  scratch.direction.copy(camera).sub(target);
  scratch.desiredPosition.copy(target).add(scratch.direction);
  const clampedPositionX = clampValue(scratch.desiredPosition.x, mapBounds.minX, mapBounds.maxX);
  const clampedPositionZ = clampValue(scratch.desiredPosition.z, mapBounds.minZ, mapBounds.maxZ);
  scratch.desiredPosition.setX(clampedPositionX).setZ(clampedPositionZ);

  scratch.offsetFromTarget.copy(scratch.desiredPosition).sub(target);
  const currentDistance = scratch.offsetFromTarget.length();
  const clampedDistance = clampValue(currentDistance || distanceLimits.min, distanceLimits.min, distanceLimits.max);

  scratch.safeDirection.copy(scratch.offsetFromTarget);
  if (scratch.safeDirection.lengthSq() === 0) {
    scratch.safeDirection.set(0, 1, 0);
  } else {
    scratch.safeDirection.normalize();
  }

  scratch.finalPosition.copy(target).addScaledVector(scratch.safeDirection, clampedDistance);
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
