import type { HexCoord } from '../../shared/types';

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const hexKey = (coord: HexCoord): string => `${coord.q}|${coord.r}`;

