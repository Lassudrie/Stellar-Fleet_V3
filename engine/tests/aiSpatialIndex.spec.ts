import assert from 'node:assert';
import { SpatialIndex } from '../spatialIndex';

type Point = { id: string; position: { x: number; y: number; z: number } };

const points: Point[] = [
  { id: 'a', position: { x: 0, y: 0, z: 0 } },
  { id: 'b', position: { x: 10, y: 0, z: 0 } },
  { id: 'c', position: { x: 25, y: 0, z: 0 } },
];

{
  const index = new SpatialIndex(points, 8);
  const nearby = index.queryRadius({ x: 0, y: 0, z: 0 }, 12).map(p => p.id);
  assert.deepStrictEqual(new Set(nearby), new Set(['a', 'b']), 'queryRadius should include only points inside the radius');
}

{
  const index = new SpatialIndex(points, 8);
  const nearest = index.findNearest({ x: 13, y: 0, z: 0 });
  assert.strictEqual(nearest?.item.id, 'b', 'findNearest should return closest point');
}

{
  const index = new SpatialIndex(points, 8);
  const nearestMatching = index.findNearest({ x: 13, y: 0, z: 0 }, item => item.id === 'c');
  assert.strictEqual(nearestMatching?.item.id, 'c', 'findNearest should respect predicate filters');
}

{
  const emptyIndex = new SpatialIndex<Point>([], 5);
  assert.deepStrictEqual(emptyIndex.queryRadius({ x: 0, y: 0, z: 0 }, 10), [], 'Empty indexes should return empty queries');
  assert.strictEqual(emptyIndex.findNearest({ x: 0, y: 0, z: 0 }), null, 'findNearest should return null on empty index');
}

console.log('SpatialIndex tests passed');
