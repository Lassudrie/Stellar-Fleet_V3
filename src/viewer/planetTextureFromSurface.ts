import * as THREE from 'three';
import type {
  Biome,
  PlanetSurfaceDescriptor,
  PlanetSurfaceMap,
  PlanetSurfaceTile,
  PlanetData,
  MoonData,
  Vec3
} from '../shared/shared';
import { generateSurfaceMap, surfaceDirFromUv } from '../engine/worldgen/planetSurfaceGenerator';
import { buildGeodesicGrid } from '../engine/worldgen/geodesicGrid';

export type SurfaceTextureMode = 'albedo' | 'biome';

type SurfaceTextureParams = {
  systemId: string;
  bodyId: string;
  descriptor: PlanetSurfaceDescriptor;
  resolution: number;
  planetData?: PlanetData;
  moonData?: MoonData;
  mode?: SurfaceTextureMode;
};

const BIOME_COLORS: Record<Biome, string> = {
  ocean: '#1b4f9c',
  coast: '#2e88a8',
  lake: '#2b6b9b',
  ice: '#dfeaf5',
  fractured_ice: '#cbd7e6',
  dusty_ice: '#b9c6d4',
  cryovolcanic: '#8ba0b9',
  tundra: '#9db7a5',
  taiga: '#6fa082',
  grassland: '#7fb468',
  forest: '#4c8a56',
  rainforest: '#2f6e4d',
  desert: '#d2b471',
  ash_desert: '#9a8f85',
  thermal_polygons: '#c8b48a',
  lava_flats: '#5b2b2b',
  vitrified: '#7b6a6a',
  oxidized: '#b46a4a',
  compressed_plateau: '#7a7f7e',
  chemical_erosion: '#8aa195',
  fossil_basin: '#9d8063',
  rocky: '#7b7a73',
  mountain: '#8a8f95',
  volcanic: '#5e3c3c',
  cratered: '#7d7468'
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const getTileColor = (
  tile: PlanetSurfaceTile,
  seaLevelElev: number,
  mode: SurfaceTextureMode
): THREE.Color => {
  const base = new THREE.Color(BIOME_COLORS[tile.biome]);
  if (mode === 'biome') return base;

  const elevDelta = tile.elev - seaLevelElev;
  const elevNorm = clamp(elevDelta / 2400, -1, 1);
  const moistNorm = clamp(tile.moist / 255, 0, 1);

  if (tile.biome === 'ocean' || tile.biome === 'coast' || tile.biome === 'lake') {
    base.offsetHSL(0, 0.02 * (1 - moistNorm), -0.12 * Math.max(0, -elevNorm));
  } else if (tile.biome === 'ice' || tile.biome === 'fractured_ice' || tile.biome === 'dusty_ice') {
    base.offsetHSL(0, -0.05, 0.12 + elevNorm * 0.08);
  } else {
    base.offsetHSL(0, 0.04 * moistNorm, 0.08 * elevNorm);
  }

  return base;
};

const createCanvas = (
  width: number,
  height: number
): HTMLCanvasElement | OffscreenCanvas | null => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
};

const buildTileColors = (map: PlanetSurfaceMap, mode: SurfaceTextureMode): Float32Array => {
  const colors = new Float32Array(map.tiles.length * 3);
  map.tiles.forEach((tile, index) => {
    const color = getTileColor(tile, map.seaLevelElev, mode);
    const base = index * 3;
    colors[base] = color.r;
    colors[base + 1] = color.g;
    colors[base + 2] = color.b;
  });
  return colors;
};

const geodesicGridCache = new Map<number, ReturnType<typeof buildGeodesicGrid>>();

const getGeodesicGrid = (frequency: number): ReturnType<typeof buildGeodesicGrid> => {
  const key = Math.max(1, Math.floor(frequency));
  const cached = geodesicGridCache.get(key);
  if (cached) return cached;
  const grid = buildGeodesicGrid(key);
  geodesicGridCache.set(key, grid);
  return grid;
};

const resolveTileIndexGeodesic = (dir: Vec3, tileDirs: Vec3[]): number => {
  let bestIndex = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < tileDirs.length; i += 1) {
    const value = dot(dir, tileDirs[i]);
    if (value > bestDot) {
      bestDot = value;
      bestIndex = i;
    }
  }
  return bestIndex;
};

export const createPlanetTextureFromSurface = (params: SurfaceTextureParams): THREE.Texture | null => {
  if (params.resolution <= 0) return null;
  const width = params.resolution * 2;
  const height = params.resolution;

  const canvas = createCanvas(width, height);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;

  const map = generateSurfaceMap({
    systemId: params.systemId,
    bodyId: params.bodyId,
    descriptor: params.descriptor,
    planetData: params.planetData,
    moonData: params.moonData
  });

  const mode = params.mode ?? 'albedo';
  const tileColors = buildTileColors(map, mode);
  const image = ctx.createImageData(width, height);
  const data = image.data;

  if (map.descriptor.config.gridKind === 'geodesic') {
    const grid = getGeodesicGrid(map.descriptor.config.frequency);
    const tileDirs = grid.vertices;

    for (let y = 0; y < height; y += 1) {
      const v = (y + 0.5) / height;
      for (let x = 0; x < width; x += 1) {
        const u = (x + 0.5) / width;
        const dir = surfaceDirFromUv(u, v);
        const tileIndex = resolveTileIndexGeodesic(dir, tileDirs);
        const colorIndex = tileIndex * 3;
        const base = (y * width + x) * 4;
        data[base] = Math.round(tileColors[colorIndex] * 255);
        data[base + 1] = Math.round(tileColors[colorIndex + 1] * 255);
        data[base + 2] = Math.round(tileColors[colorIndex + 2] * 255);
        data[base + 3] = 255;
      }
    }
  } else {
    const config = map.descriptor.config;
    const w = config.w;
    const h = config.h;
    const wrapX = config.wrapX;
    for (let y = 0; y < height; y += 1) {
      const v = (y + 0.5) / height;
      const r = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
      for (let x = 0; x < width; x += 1) {
        const u = (x + 0.5) / width;
        const q = wrapX ? Math.floor(u * w) % w : Math.min(w - 1, Math.max(0, Math.floor(u * w)));
        const tileIndex = r * w + q;
        const colorIndex = tileIndex * 3;
        const base = (y * width + x) * 4;
        data[base] = Math.round(tileColors[colorIndex] * 255);
        data[base + 1] = Math.round(tileColors[colorIndex + 1] * 255);
        data[base + 2] = Math.round(tileColors[colorIndex + 2] * 255);
        data[base + 3] = 255;
      }
    }
  }

  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 2;
  texture.needsUpdate = true;
  return texture;
};
