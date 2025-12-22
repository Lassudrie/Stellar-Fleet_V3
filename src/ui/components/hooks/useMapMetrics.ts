import { useMemo } from 'react';
import { StarSystem } from '../../../shared/types';
import { Vec3 } from '../../../engine/math/vec3';

const DEFAULT_RADIUS = 120;
const DEFAULT_MARGIN = 40;

export interface MapBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface MapMetrics {
  center: Vec3;
  radius: number;
  bounds: MapBounds;
}

export function useMapMetrics(systems: StarSystem[]): MapMetrics {
  return useMemo(() => {
    if (systems.length === 0) {
      return {
        center: { x: 0, y: 0, z: 0 },
        radius: DEFAULT_RADIUS,
        bounds: {
          minX: -DEFAULT_RADIUS - DEFAULT_MARGIN,
          maxX: DEFAULT_RADIUS + DEFAULT_MARGIN,
          minZ: -DEFAULT_RADIUS - DEFAULT_MARGIN,
          maxZ: DEFAULT_RADIUS + DEFAULT_MARGIN,
        },
      };
    }

    let minX = systems[0].position.x;
    let maxX = systems[0].position.x;
    let minY = systems[0].position.y;
    let maxY = systems[0].position.y;
    let minZ = systems[0].position.z;
    let maxZ = systems[0].position.z;

    systems.forEach(({ position }) => {
      minX = Math.min(minX, position.x);
      maxX = Math.max(maxX, position.x);
      minY = Math.min(minY, position.y);
      maxY = Math.max(maxY, position.y);
      minZ = Math.min(minZ, position.z);
      maxZ = Math.max(maxZ, position.z);
    });

    const center: Vec3 = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: (minZ + maxZ) / 2,
    };

    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    const boundingDiagonal = Math.sqrt(extentX * extentX + extentY * extentY + extentZ * extentZ);
    const radius = Math.max(boundingDiagonal / 2, DEFAULT_RADIUS);

    const margin = Math.max(DEFAULT_MARGIN, Math.max(extentX, extentZ) * 0.1);

    return {
      center,
      radius,
      bounds: {
        minX: minX - margin,
        maxX: maxX + margin,
        minZ: minZ - margin,
        maxZ: maxZ + margin,
      },
    };
  }, [systems]);
}
