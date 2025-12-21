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

console.log('GameCamera clamp tests passed');
