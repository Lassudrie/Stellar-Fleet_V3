import { hashJoin32 } from './hash32';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10); // smootherstep

const hashUnit2D = (seed: number, x: number, y: number): number => {
  // Deterministic [0..1] from integer lattice coords.
  const h = hashJoin32(seed >>> 0, x | 0, y | 0);
  return h / 0xffffffff;
};

/**
 * Value noise 2D (continuous) based on integer lattice + bilinear interpolation.
 * Input coords are continuous; internal lattice is integer.
 */
export const valueNoise2D = (seed: number, x: number, y: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const sx = fade(x - x0);
  const sy = fade(y - y0);

  const n00 = hashUnit2D(seed, x0, y0);
  const n10 = hashUnit2D(seed, x1, y0);
  const n01 = hashUnit2D(seed, x0, y1);
  const n11 = hashUnit2D(seed, x1, y1);

  const ix0 = lerp(n00, n10, sx);
  const ix1 = lerp(n01, n11, sx);
  return lerp(ix0, ix1, sy); // 0..1
};

export const fbm2D = (seed: number, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    sum += (valueNoise2D(seed + i * 1013, x * freq, y * freq) * 2 - 1) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0; // ~[-1..1]
};

export const ridgedFbm2D = (seed: number, x: number, y: number, octaves: number): number => {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    const n = valueNoise2D(seed + i * 2179, x * freq, y * freq);
    const ridge = 1 - Math.abs(n * 2 - 1); // 0..1
    const v = (ridge * 2 - 1); // [-1..1]
    sum += v * amp;
    norm += amp;
    amp *= 0.55;
    freq *= 2.1;
  }
  return norm > 0 ? sum / norm : 0;
};

export const domainWarp2D = (
  seed: number,
  x: number,
  y: number,
  strength: number
): { x: number; y: number } => {
  const dx = fbm2D(seed ^ 0x68bc21eb, x * 0.8, y * 0.8, 3);
  const dy = fbm2D(seed ^ 0x02e5be93, x * 0.8, y * 0.8, 3);
  return { x: x + dx * strength, y: y + dy * strength };
};

