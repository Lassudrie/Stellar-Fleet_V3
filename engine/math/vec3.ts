
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

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

export const lenSq = (v: Vec3): number => v.x * v.x + v.y * v.y + v.z * v.z;

export const len = (v: Vec3): number => Math.sqrt(lenSq(v));

export const distSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

export const dist = (a: Vec3, b: Vec3): number => Math.sqrt(distSq(a, b));

export const normalize = (v: Vec3): Vec3 => {
  const l = len(v);
  if (l === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

export const lerp = (start: Vec3, end: Vec3, t: number): Vec3 => {
  return {
    x: start.x + (end.x - start.x) * t,
    y: start.y + (end.y - start.y) * t,
    z: start.z + (end.z - start.z) * t
  };
};
