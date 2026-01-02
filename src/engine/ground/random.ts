import type { RNG } from '../rng';

export const rollTriangularCentered = (rng: RNG, epsilon: number): number => {
  const u1 = rng.next();
  const u2 = rng.next();
  const t = (u1 + u2 - 1); // [-1, 1]
  return 1 + t * epsilon;
};

