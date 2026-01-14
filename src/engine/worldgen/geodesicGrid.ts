import { Vec3 } from '../math/vec3';

export type GeodesicGrid = {
  frequency: number;
  vertices: Vec3[];
  faces: Array<[number, number, number]>;
  neighbors: number[][];
  facesByVertex: number[][];
};

const ROUND_SCALE = 1_000_000;

const normalize = (v: Vec3): Vec3 => {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len <= 0) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
};

const keyFor = (v: Vec3): string => {
  const x = Math.round(v.x * ROUND_SCALE);
  const y = Math.round(v.y * ROUND_SCALE);
  const z = Math.round(v.z * ROUND_SCALE);
  return `${x}|${y}|${z}`;
};

const ICOSAHEDRON_VERTICES: Vec3[] = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: Vec3[] = [
    { x: -1, y: t, z: 0 },
    { x: 1, y: t, z: 0 },
    { x: -1, y: -t, z: 0 },
    { x: 1, y: -t, z: 0 },
    { x: 0, y: -1, z: t },
    { x: 0, y: 1, z: t },
    { x: 0, y: -1, z: -t },
    { x: 0, y: 1, z: -t },
    { x: t, y: 0, z: -1 },
    { x: t, y: 0, z: 1 },
    { x: -t, y: 0, z: -1 },
    { x: -t, y: 0, z: 1 }
  ];
  return raw.map(normalize);
})();

const ICOSAHEDRON_FACES: Array<[number, number, number]> = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1]
];

export const tileCount = (frequency: number): number => {
  const f = Math.max(1, Math.floor(frequency));
  return 10 * f * f + 2;
};

export const buildGeodesicGrid = (frequency: number): GeodesicGrid => {
  const f = Math.max(1, Math.floor(frequency));
  const vertices: Vec3[] = [];
  const faces: Array<[number, number, number]> = [];
  const facesByVertex: number[][] = [];
  const vertexIndexByKey = new Map<string, number>();

  const getVertexIndex = (v: Vec3): number => {
    const key = keyFor(v);
    const existing = vertexIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = vertices.length;
    vertexIndexByKey.set(key, idx);
    vertices.push(v);
    facesByVertex[idx] = [];
    return idx;
  };

  ICOSAHEDRON_FACES.forEach((face) => {
    const a = ICOSAHEDRON_VERTICES[face[0]];
    const b = ICOSAHEDRON_VERTICES[face[1]];
    const c = ICOSAHEDRON_VERTICES[face[2]];

    const local: number[][] = [];
    for (let i = 0; i <= f; i += 1) {
      local[i] = [];
      for (let j = 0; j <= f - i; j += 1) {
        const k = f - i - j;
        const wa = k / f;
        const wb = i / f;
        const wc = j / f;
        const point = normalize({
          x: a.x * wa + b.x * wb + c.x * wc,
          y: a.y * wa + b.y * wb + c.y * wc,
          z: a.z * wa + b.z * wb + c.z * wc
        });
        local[i][j] = getVertexIndex(point);
      }
    }

    for (let i = 0; i < f; i += 1) {
      for (let j = 0; j < f - i; j += 1) {
        const v0 = local[i][j];
        const v1 = local[i + 1][j];
        const v2 = local[i][j + 1];
        faces.push([v0, v1, v2]);
        if (j + i < f - 1) {
          const v3 = local[i + 1][j + 1];
          faces.push([v1, v3, v2]);
        }
      }
    }
  });

  const neighborSets = vertices.map(() => new Set<number>());
  faces.forEach(([a, b, c], faceIndex) => {
    facesByVertex[a].push(faceIndex);
    facesByVertex[b].push(faceIndex);
    facesByVertex[c].push(faceIndex);

    neighborSets[a].add(b);
    neighborSets[a].add(c);
    neighborSets[b].add(a);
    neighborSets[b].add(c);
    neighborSets[c].add(a);
    neighborSets[c].add(b);
  });

  const neighbors = neighborSets.map((set) => Array.from(set).sort((lhs, rhs) => lhs - rhs));

  return {
    frequency: f,
    vertices,
    faces,
    neighbors,
    facesByVertex
  };
};

export const getTileDirection = (grid: GeodesicGrid, tileId: number): Vec3 | null => {
  if (!Number.isFinite(tileId)) return null;
  const idx = Math.floor(tileId);
  if (idx < 0 || idx >= grid.vertices.length) return null;
  return grid.vertices[idx];
};

export const getTileNeighbors = (grid: GeodesicGrid, tileId: number): number[] => {
  if (!Number.isFinite(tileId)) return [];
  const idx = Math.floor(tileId);
  if (idx < 0 || idx >= grid.neighbors.length) return [];
  return grid.neighbors[idx];
};
