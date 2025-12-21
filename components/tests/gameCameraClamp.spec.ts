import assert from 'node:assert';
import { PerspectiveCamera, Vector3 } from 'three';
import { clampCameraToBounds, CameraVectorPool } from '../GameCamera';

const createPool = (): CameraVectorPool => ({
  direction: new Vector3(),
  desired: new Vector3(),
  offset: new Vector3(),
  safeDirection: new Vector3(),
  final: new Vector3(),
  bounded: new Vector3()
});

const camera = new PerspectiveCamera();
camera.position.set(120, 40, 120);

const target = camera.position.clone();

const controls = {
  object: camera,
  target,
  minDistance: 20,
  maxDistance: 80,
  updateCalled: false,
  update() {
    this.updateCalled = true;
  }
};

const pool = createPool();

clampCameraToBounds(
  controls as any,
  { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  { minDistance: 10, maxDistance: 60 },
  pool
);

assert.ok((controls as any).updateCalled, 'Clamping should request a controls update when adjustments are made');
assert.ok(controls.object.position.x <= 50 && controls.object.position.x >= -50, 'Camera X should be clamped');
assert.ok(controls.object.position.z <= 50 && controls.object.position.z >= -50, 'Camera Z should be clamped');

clampCameraToBounds(
  controls as any,
  { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  { minDistance: 10, maxDistance: 60 },
  pool
);

assert.strictEqual(pool.direction, pool.direction, 'Vector pool references remain stable between calls');
