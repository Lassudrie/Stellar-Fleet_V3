
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const isValidVec3 = (v: Vec3 | null | undefined): v is Vec3 =>
  Boolean(v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));

export const vec3 = (x: number = 0, y: number = 0, z: number = 0): Vec3 => ({ x, y, z });

export const clone = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export const copy = (target: Vec3, source: Vec3): Vec3 => {
    target.x = source.x;
    target.y = source.y;
    target.z = source.z;
    return target;
};

export const equals = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const scale = (v: Vec3, s: number): Vec3 => ({ x: v.x * s, y: v.y * s, z: v.z * s });

export const lenSq = (v: Vec3): number => {
  if (!isValidVec3(v)) return Number.POSITIVE_INFINITY;
  return v.x * v.x + v.y * v.y + v.z * v.z;
};

export const len = (v: Vec3): number => {
  const magnitudeSq = lenSq(v);
  return Number.isFinite(magnitudeSq) ? Math.sqrt(magnitudeSq) : Number.POSITIVE_INFINITY;
};

export const distSq = (a: Vec3, b: Vec3): number => {
  if (!isValidVec3(a) || !isValidVec3(b)) return Number.POSITIVE_INFINITY;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

export const dist = (a: Vec3, b: Vec3): number => {
  const distanceSq = distSq(a, b);
  return Number.isFinite(distanceSq) ? Math.sqrt(distanceSq) : Number.POSITIVE_INFINITY;
};

export const normalize = (v: Vec3): Vec3 => {
  const magnitude = len(v);
  if (!Number.isFinite(magnitude) || magnitude === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / magnitude, y: v.y / magnitude, z: v.z / magnitude };
};

export const lerp = (start: Vec3, end: Vec3, t: number): Vec3 => {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t
  };
};
