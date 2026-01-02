import type { HexCoord } from '../../shared/types';
import { neighborsAxial } from '../planetSurface/hex';
import { hexKey } from './utils';

type Node = { q: number; r: number; cost: number };

class MinHeap {
  private heap: Node[] = [];

  push(node: Node) {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): Node | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.bubbleDown(0);
    }
    return top;
  }

  get size() { return this.heap.length; }

  private bubbleUp(i: number) {
    let idx = i;
    while (idx > 0) {
      const p = (idx - 1) >> 1;
      if (this.less(this.heap[p], this.heap[idx])) break;
      [this.heap[p], this.heap[idx]] = [this.heap[idx], this.heap[p]];
      idx = p;
    }
  }

  private bubbleDown(i: number) {
    const n = this.heap.length;
    let idx = i;
    let moved = true;
    while (moved) {
      moved = false;
      const l = idx * 2 + 1;
      const r = l + 1;
      let best = idx;
      if (l < n && !this.less(this.heap[best], this.heap[l])) best = l;
      if (r < n && !this.less(this.heap[best], this.heap[r])) best = r;
      if (best !== idx) {
        [this.heap[best], this.heap[idx]] = [this.heap[idx], this.heap[best]];
        idx = best;
        moved = true;
      }
    }
  }

  private less(a: Node, b: Node): boolean {
    // Tie-break for determinism: cost, then r, then q.
    if (a.cost !== b.cost) return a.cost < b.cost;
    if (a.r !== b.r) return a.r < b.r;
    return a.q < b.q;
  }
}

export interface FindPathParams {
  from: HexCoord;
  to: HexCoord;
  w: number;
  h: number;
  wrapX: boolean;
  isBlocked: (coord: HexCoord) => boolean;
  stepCostCenti: (from: HexCoord, to: HexCoord) => number; // includes ZOC modifiers etc.
}

export interface PathResult {
  path: HexCoord[]; // includes start and end
  costCenti: number;
}

export const findPathWithCost = (params: FindPathParams): PathResult | null => {
  const { from, to, w, h, wrapX, isBlocked, stepCostCenti } = params;
  const startKey = hexKey(from);
  const goalKey = hexKey(to);

  const dist = new Map<string, number>();
  const prev = new Map<string, HexCoord>();
  dist.set(startKey, 0);

  const heap = new MinHeap();
  heap.push({ q: from.q, r: from.r, cost: 0 });

  while (heap.size > 0) {
    const cur = heap.pop()!;
    const curCoord: HexCoord = { q: cur.q, r: cur.r };
    const curKey = hexKey(curCoord);
    const best = dist.get(curKey);
    if (best === undefined || cur.cost !== best) continue;
    if (curKey === goalKey) break;

    const ns = neighborsAxial(curCoord, w, h, wrapX);
    for (const n of ns) {
      const nKey = hexKey(n);
      if (nKey !== goalKey && isBlocked(n)) continue;
      const step = stepCostCenti(curCoord, n);
      if (!Number.isFinite(step) || step <= 0) continue;
      const nextCost = cur.cost + step;
      const known = dist.get(nKey);
      if (known === undefined || nextCost < known) {
        dist.set(nKey, nextCost);
        prev.set(nKey, curCoord);
        heap.push({ q: n.q, r: n.r, cost: nextCost });
      }
    }
  }

  const total = dist.get(goalKey);
  if (total === undefined) return null;

  // Reconstruct
  const path: HexCoord[] = [];
  let cur: HexCoord = to;
  path.push(cur);
  while (hexKey(cur) !== startKey) {
    const p = prev.get(hexKey(cur));
    if (!p) break;
    cur = p;
    path.push(cur);
  }
  path.reverse();

  // Ensure start present
  if (path.length === 0 || hexKey(path[0]) !== startKey) {
    return null;
  }

  return { path, costCenti: total };
};

