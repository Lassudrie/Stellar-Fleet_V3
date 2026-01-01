import assert from 'node:assert';
import { Vector3 } from 'three';
import { performance } from 'node:perf_hooks';
import { clampCameraToBounds, createClampScratch, ClampBounds } from './GameCameraClamp';

const bounds: ClampBounds = {
  minX: -50,
  maxX: 50,
  minZ: -50,
  maxZ: 50,
};

{
  const camera = new Vector3(100, 20, 100);
  const target = new Vector3(100, 0, 100);
  const scratch = createClampScratch();

  const { targetChanged, positionChanged } = clampCameraToBounds(
    camera,
    target,
    bounds,
    { min: 10, max: 120 },
    scratch
  );

  assert.strictEqual(targetChanged, true, 'Target should be clamped inside bounds');
  assert.strictEqual(positionChanged, true, 'Camera should move when target is clamped');
  assert.ok(camera.x <= bounds.maxX && camera.x >= bounds.minX, 'Camera X should be inside bounds');
  assert.ok(camera.z <= bounds.maxZ && camera.z >= bounds.minZ, 'Camera Z should be inside bounds');
}

{
  const iterations = 5000;
  const camera = new Vector3(10, 30, 10);
  const target = new Vector3(10, 0, 10);
  const scratch = createClampScratch();
  const start = performance.now();

  for (let i = 0; i < iterations; i += 1) {
    target.x = 60 + (i % 5);
    target.z = 60 - (i % 7);
    clampCameraToBounds(camera, target, bounds, { min: 5, max: 150 }, scratch);
  }

  const duration = performance.now() - start;
  assert.ok(duration < 200, `Clamping should remain fast (took ${duration.toFixed(2)}ms)`);
}

{
  const camera = new Vector3(0, 40, 40);
  const target = new Vector3(0, 0, 0);
  const scratch = createClampScratch();

  clampCameraToBounds(camera, target, bounds, { min: 20, max: 60 }, scratch);

  const distance = camera.distanceTo(target);
  assert.ok(Math.abs(distance - Math.sqrt(40 * 40 + 40 * 40)) < 0.001, 'Camera should respect desired distance within bounds');
  assert.ok(camera.x <= bounds.maxX && camera.x >= bounds.minX, 'Camera X should stay within bounds');
  assert.ok(camera.z <= bounds.maxZ && camera.z >= bounds.minZ, 'Camera Z should stay within bounds');
}

{
  const camera = new Vector3(70, 10, 0);
  const target = new Vector3(40, 0, 0);
  const scratch = createClampScratch();

  const initialOffset = camera.clone().sub(target);
  const expectedDirection = initialOffset.clone().normalize();
  const expectedDistance = (bounds.maxX - target.x) / expectedDirection.x;

  clampCameraToBounds(camera, target, bounds, { min: 20, max: 120 }, scratch);

  const distance = camera.distanceTo(target);
  assert.ok(Math.abs(distance - expectedDistance) < 0.001, 'Camera should stop at the boundary-constrained distance');
  assert.ok(camera.x <= bounds.maxX && camera.x >= bounds.minX, 'Camera X should stay within bounds after boundary clamp');
  assert.ok(camera.z <= bounds.maxZ && camera.z >= bounds.minZ, 'Camera Z should stay within bounds after boundary clamp');
}

console.log('GameCamera clamp tests passed');
