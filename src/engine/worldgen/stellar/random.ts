import { RNG } from '../../rng';

export function clamp(x: number, min: number, max: number): number {
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

export function logUniform(rng: RNG, min: number, max: number): number {
  if (min <= 0 || max <= 0) {
    throw new Error(`logUniform requires positive bounds, got [${min}, ${max}]`);
  }
  const a = Math.log(min);
  const b = Math.log(max);
  return Math.exp(rng.range(a, b));
}

export function normal(rng: RNG, mean = 0, std = 1): number {
  return mean + std * rng.gaussian();
}

export function expNormalNoise(rng: RNG, std: number): number {
  return Math.exp(normal(rng, 0, std));
}

export function weightedPick<T extends string>(
  rng: RNG,
  items: Array<{ key: T; weight: number }>
): T {
  const total = items.reduce((sum, it) => sum + Math.max(0, it.weight), 0);
  if (total <= 0) {
    throw new Error('weightedPick: total weight must be > 0');
  }
  let r = rng.next() * total;
  for (const it of items) {
    r -= Math.max(0, it.weight);
    if (r <= 0) return it.key;
  }
  return items[items.length - 1].key;
}

export function pickFromProbTable<T extends string>(rng: RNG, probs: Record<T, number>): T {
  const entries = Object.entries(probs) as Array<[T, number]>;
  const items = entries.map(([key, weight]) => ({ key, weight }));
  return weightedPick(rng, items);
}

// Poisson sampler (Knuth) - fine for lambdas in this project (<= ~5)
export function poisson(rng: RNG, lambda: number): number {
  if (!Number.isFinite(lambda) || lambda < 0) {
    throw new Error(`poisson: invalid lambda ${lambda}`);
  }
  if (lambda === 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L);
  return k - 1;
}

// Deterministic 32-bit FNV-1a hash for strings.
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function deriveSeed32(...parts: Array<string | number>): number {
  const s = parts.map(p => String(p)).join('|');
  // Ensure non-zero RNG state
  return (fnv1a32(s) >>> 0) || 1;
}

export function randomUnitWeights(rng: RNG, n: number): number[] {
  if (n <= 0) return [];
  const xs = Array.from({ length: n }, () => -Math.log(Math.max(1e-12, rng.next())));
  const sum = xs.reduce((a, b) => a + b, 0);
  return xs.map(x => x / sum);
}
