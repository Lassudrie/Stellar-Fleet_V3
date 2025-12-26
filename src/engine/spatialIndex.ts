import { distSq } from './math/vec3';

type PositionedEntity = { position: { x: number; y: number; z: number } };

export class SpatialIndex<T extends PositionedEntity> {
  private readonly buckets = new Map<string, T[]>();
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

    this.items.forEach(item => {
      const cell = this.getCellCoords(item.position);
      this.minCell.x = Math.min(this.minCell.x, cell.x);
      this.minCell.z = Math.min(this.minCell.z, cell.z);
      this.maxCell.x = Math.max(this.maxCell.x, cell.x);
      this.maxCell.z = Math.max(this.maxCell.z, cell.z);

      const key = this.getKey(cell.x, cell.z);
      const bucket = this.buckets.get(key);
      if (bucket) {
        bucket.push(item);
      } else {
        this.buckets.set(key, [item]);
      }
    });
  }

  private getCellCoords(position: PositionedEntity['position']) {
    return {
      x: Math.floor(position.x / this.cellSize),
      z: Math.floor(position.z / this.cellSize),
    };
  }

  private getKey(x: number, z: number) {
    return `${x}:${z}`;
  }

  private getCellsInRadius(center: { x: number; z: number }, cellRadius: number) {
    const cells: Array<{ x: number; z: number }> = [];
    for (let x = center.x - cellRadius; x <= center.x + cellRadius; x += 1) {
      for (let z = center.z - cellRadius; z <= center.z + cellRadius; z += 1) {
        cells.push({ x, z });
      }
    }
    return cells;
  }

  /**
   * Returns only the cells on the perimeter of the square defined by cellRadius.
   * This avoids re-checking inner cells during expanding search.
   */
  private getCellsInRing(center: { x: number; z: number }, cellRadius: number) {
    const cells: Array<{ x: number; z: number }> = [];
    if (cellRadius === 0) {
      cells.push(center);
      return cells;
    }

    const minX = center.x - cellRadius;
    const maxX = center.x + cellRadius;
    const minZ = center.z - cellRadius;
    const maxZ = center.z + cellRadius;

    // Top and Bottom rows
    for (let x = minX; x <= maxX; x += 1) {
      cells.push({ x, z: minZ });
      cells.push({ x, z: maxZ });
    }

    // Left and Right columns (excluding corners already added)
    for (let z = minZ + 1; z < maxZ; z += 1) {
      cells.push({ x: minX, z });
      cells.push({ x: maxX, z });
    }

    return cells;
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

    this.getCellsInRadius(center, cellRadius).forEach(cell => {
      const bucket = this.buckets.get(this.getKey(cell.x, cell.z));
      if (!bucket) return;

      bucket.forEach(item => {
        if (distSq(item.position, position) <= maxDistanceSq) {
          candidates.push(item);
        }
      });
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
      // Optimization: Only check cells in the current ring (perimeter)
      // checking inner cells again is redundant
      const cells = this.getCellsInRing(center, cellRadius);

      cells.forEach(cell => {
        const bucket = this.buckets.get(this.getKey(cell.x, cell.z));
        if (!bucket) return;

        bucket.forEach(item => {
          if (predicate && !predicate(item)) return;
          const distanceSq = distSq(item.position, position);
          if (distanceSq < bestDistanceSq) {
            bestDistanceSq = distanceSq;
            bestItem = item;
          }
        });
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
