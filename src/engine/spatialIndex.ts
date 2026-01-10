import { distSq } from './math/vec3';

type PositionedEntity = { position: { x: number; y: number; z: number } };

export class SpatialIndex<T extends PositionedEntity> {
  // Use number keys for packed coordinates to avoid string allocations
  private readonly buckets = new Map<number, T[]>();
  private readonly cellSize: number;
  private readonly minCell: { x: number; z: number } = { x: Infinity, z: Infinity };
  private readonly maxCell: { x: number; z: number } = { x: -Infinity, z: -Infinity };
  private readonly items: T[];
  private readonly sourceItems: T[];
  private readonly buildTurn?: number;

  constructor(items: T[], cellSize: number, buildTurn?: number) {
    this.cellSize = Math.max(1, cellSize);
    this.sourceItems = [...items];
    this.items = this.sourceItems;
    this.buildTurn = buildTurn;

    for (const item of this.items) {
      const cell = this.getCellCoords(item.position);
      // Update bounds in place
      if (cell.x < this.minCell.x) this.minCell.x = cell.x;
      if (cell.z < this.minCell.z) this.minCell.z = cell.z;
      if (cell.x > this.maxCell.x) this.maxCell.x = cell.x;
      if (cell.z > this.maxCell.z) this.maxCell.z = cell.z;

      const key = this.getKey(cell.x, cell.z);
      const bucket = this.buckets.get(key);
      if (bucket) {
        bucket.push(item);
      } else {
        this.buckets.set(key, [item]);
      }
    }
  }

  private getCellCoords(position: PositionedEntity['position']) {
    return {
      x: Math.floor(position.x / this.cellSize),
      z: Math.floor(position.z / this.cellSize),
    };
  }

  // Packed integer key: (x + OFFSET) * STRIDE + (z + OFFSET)
  // 32768 offset allows coordinates down to -32768
  // 65536 stride allows coordinates up to 32767
  // Result fits in safe integer (2^53)
  private getKey(x: number, z: number) {
    return (x + 32768) * 65536 + (z + 32768);
  }

  // Iterates over all cells in a square radius (inclusive) without allocating an array
  private forEachCellInSquare(
    center: { x: number; z: number },
    cellRadius: number,
    callback: (x: number, z: number) => void
  ) {
    for (let x = center.x - cellRadius; x <= center.x + cellRadius; x += 1) {
      for (let z = center.z - cellRadius; z <= center.z + cellRadius; z += 1) {
        callback(x, z);
      }
    }
  }

  // Iterates over cells in the "ring" at exactly radius r (square perimeter)
  private forEachCellInRing(
    center: { x: number; z: number },
    radius: number,
    callback: (x: number, z: number) => void
  ) {
    if (radius === 0) {
      callback(center.x, center.z);
      return;
    }

    const minX = center.x - radius;
    const maxX = center.x + radius;
    const minZ = center.z - radius;
    const maxZ = center.z + radius;

    // Top and Bottom rows (full width)
    for (let x = minX; x <= maxX; x++) {
      callback(x, minZ);
      callback(x, maxZ);
    }

    // Left and Right columns (excluding corners already handled)
    for (let z = minZ + 1; z < maxZ; z++) {
      callback(minX, z);
      callback(maxX, z);
    }
  }

  private getSearchBounds(center: { x: number; z: number }, cellRadius: number) {
    return {
      minX: (center.x - cellRadius) * this.cellSize,
      maxX: (center.x + cellRadius + 1) * this.cellSize,
      minZ: (center.z - cellRadius) * this.cellSize,
      maxZ: (center.z + cellRadius + 1) * this.cellSize,
    };
  }

  private resolveIndex(currentTurn?: number, items?: T[]): SpatialIndex<T> {
    if (currentTurn !== undefined && this.buildTurn !== undefined && currentTurn !== this.buildTurn) {
      const shouldWarn =
        typeof process !== 'undefined'
          ? process.env?.NODE_ENV !== 'production'
          : (typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV);
      if (shouldWarn) {
        console.warn(
          `[SpatialIndex] stale index detected (built at ${this.buildTurn}, used at ${currentTurn}). Rebuilding.`
        );
      }
      return new SpatialIndex(items ?? this.sourceItems, this.cellSize, currentTurn);
    }
    return this;
  }

  queryRadius(
    position: PositionedEntity['position'],
    maxDistance: number,
    options?: { currentTurn?: number; items?: T[] }
  ): T[] {
    if (this.items.length === 0) return [];
    const index = this.resolveIndex(options?.currentTurn, options?.items);
    if (index !== this) {
      return index.queryRadius(position, maxDistance, options);
    }

    const center = this.getCellCoords(position);
    const cellRadius = Math.max(0, Math.ceil(maxDistance / this.cellSize));
    const maxDistanceSq = maxDistance * maxDistance;
    const candidates: T[] = [];

    this.forEachCellInSquare(center, cellRadius, (cx, cz) => {
      const bucket = this.buckets.get(this.getKey(cx, cz));
      if (!bucket) return;

      for (const item of bucket) {
        if (distSq(item.position, position) <= maxDistanceSq) {
          candidates.push(item);
        }
      }
    });

    return candidates;
  }

  findNearest(
    position: PositionedEntity['position'],
    predicate?: (item: T) => boolean,
    options?: { currentTurn?: number; items?: T[] }
  ): { item: T; distanceSq: number } | null {
    if (this.items.length === 0) return null;

    const index = this.resolveIndex(options?.currentTurn, options?.items);
    if (index !== this) {
      return index.findNearest(position, predicate, options);
    }

    const center = this.getCellCoords(position);
    const maxRadius = Math.max(this.maxCell.x - this.minCell.x, this.maxCell.z - this.minCell.z, 0) + 1;
    let bestItem: T | null = null;
    let bestDistanceSq = Infinity;

    for (let cellRadius = 0; cellRadius <= maxRadius; cellRadius += 1) {
      // Only check the ring to avoid re-checking inner cells (O(R^2) instead of O(R^3))
      this.forEachCellInRing(center, cellRadius, (cx, cz) => {
        const bucket = this.buckets.get(this.getKey(cx, cz));
        if (!bucket) return;

        for (const item of bucket) {
          if (predicate && !predicate(item)) return;
          const distanceSq = distSq(item.position, position);
          if (distanceSq < bestDistanceSq) {
            bestDistanceSq = distanceSq;
            bestItem = item;
          }
        }
      });

      if (bestItem) {
        const bounds = this.getSearchBounds(center, cellRadius);
        const minBoundary = Math.min(
          position.x - bounds.minX,
          bounds.maxX - position.x,
          position.z - bounds.minZ,
          bounds.maxZ - position.z
        );
        if (minBoundary > 0 && bestDistanceSq <= minBoundary * minBoundary) {
          break;
        }
      }
    }

    return bestItem ? { item: bestItem, distanceSq: bestDistanceSq } : null;
  }
}
