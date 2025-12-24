import { distSq } from './math/vec3';

type PositionedEntity = { position: { x: number; y: number; z: number } };

export class SpatialIndex<T extends PositionedEntity> {
  private readonly buckets = new Map<string, T[]>();
  private readonly cellSize: number;
  private readonly minCell: { x: number; z: number } = { x: Infinity, z: Infinity };
  private readonly maxCell: { x: number; z: number } = { x: -Infinity, z: -Infinity };
  private readonly items: T[];

  constructor(items: T[], cellSize: number) {
    this.cellSize = Math.max(1, cellSize);
    this.items = items;

    items.forEach(item => {
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

  private getCellsInRing(center: { x: number; z: number }, radius: number) {
    const cells: Array<{ x: number; z: number }> = [];
    if (radius === 0) {
      cells.push(center);
      return cells;
    }

    // Top and Bottom rows
    for (let x = center.x - radius; x <= center.x + radius; x += 1) {
      cells.push({ x, z: center.z - radius });
      cells.push({ x, z: center.z + radius });
    }
    // Left and Right columns (excluding corners which are covered above)
    for (let z = center.z - radius + 1; z <= center.z + radius - 1; z += 1) {
      cells.push({ x: center.x - radius, z });
      cells.push({ x: center.x + radius, z });
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

  queryRadius(position: PositionedEntity['position'], maxDistance: number): T[] {
    if (this.items.length === 0) return [];
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

  findNearest(position: PositionedEntity['position'], predicate?: (item: T) => boolean): { item: T; distanceSq: number } | null {
    if (this.items.length === 0) return null;

    const center = this.getCellCoords(position);
    const maxRadius = Math.max(this.maxCell.x - this.minCell.x, this.maxCell.z - this.minCell.z, 0) + 1;
    let bestItem: T | null = null;
    let bestDistanceSq = Infinity;

    for (let cellRadius = 0; cellRadius <= maxRadius; cellRadius += 1) {
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
