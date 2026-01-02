import type { HexCoord } from '../../shared/types';

export const axialToIndex = (coord: HexCoord, w: number): number => coord.r * w + coord.q;

export const indexToAxial = (index: number, w: number): HexCoord => ({
  q: index % w,
  r: Math.floor(index / w)
});

export const wrapQ = (q: number, w: number, wrapX: boolean): number => {
  if (!wrapX) return q;
  const m = q % w;
  return m < 0 ? m + w : m;
};

export const isInBounds = (coord: HexCoord, w: number, h: number): boolean =>
  coord.q >= 0 && coord.q < w && coord.r >= 0 && coord.r < h;

// Axial neighbors (pointy-top axial coordinate system).
const NEIGHBOR_DIRS: ReadonlyArray<HexCoord> = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 }
];

export const neighborsAxial = (coord: HexCoord, w: number, h: number, wrapX: boolean): HexCoord[] => {
  const out: HexCoord[] = [];
  for (const d of NEIGHBOR_DIRS) {
    const n: HexCoord = { q: coord.q + d.q, r: coord.r + d.r };
    if (wrapX) n.q = wrapQ(n.q, w, true);
    if (isInBounds(n, w, h)) out.push(n);
  }
  return out;
};

export const normalizedLatitude = (r: number, h: number): number => {
  if (h <= 1) return 0;
  return (r / (h - 1)) * 2 - 1;
};

