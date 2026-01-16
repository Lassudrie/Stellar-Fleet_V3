import * as THREE from 'three';
import type { Biome, PlanetSurfaceConfig, PlanetSurfaceMap } from '../shared/shared';
import { buildGeodesicGrid, getTileDirection } from '../engine/worldgen/geodesicGrid';
import { surfaceDirFromTile, surfaceDirFromUv, type SurfaceDir } from '../engine/worldgen/planetSurfaceGenerator';

type TileDirection = SurfaceDir;

export type SurfaceTextureMode = 'shaded' | 'biome';

const BIOME_BASE_COLORS: Record<Biome, string> = {
  ocean: '#0c355e',
  coast: '#cdb98a',
  lake: '#2b5d9c',
  ice: '#eef5ff',
  fractured_ice: '#d9e6f2',
  dusty_ice: '#c7d2de',
  cryovolcanic: '#8fa2c7',
  tundra: '#a9b79b',
  taiga: '#5e7f56',
  grassland: '#7ea85c',
  forest: '#2f6b3a',
  rainforest: '#1f5f3b',
  desert: '#d9c189',
  ash_desert: '#9d8f7e',
  thermal_polygons: '#b1b7bc',
  lava_flats: '#5b2b24',
  vitrified: '#5f5f69',
  oxidized: '#a5633f',
  compressed_plateau: '#a19884',
  chemical_erosion: '#8b8f7c',
  fossil_basin: '#b39d7a',
  rocky: '#7f7f7f',
  mountain: '#9aa1a7',
  volcanic: '#4f3a3a',
  cratered: '#8a9097'
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const isWaterBiome = (biome: Biome): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';

const normalizeElevation = (elev: number, seaLevel: number): number => {
  const delta = elev - seaLevel;
  return clamp(delta / 1200, -1.2, 1.4);
};

const applyShading = (color: THREE.Color, elevNorm: number, tempC: number): THREE.Color => {
  const brightness = clamp(1 + elevNorm * 0.18, 0.6, 1.35);
  const tempBias = clamp(tempC / 80, -0.2, 0.2);
  const warmed = color.clone().lerp(new THREE.Color('#e6d3a4'), Math.max(0, tempBias));
  const cooled = warmed.lerp(new THREE.Color('#c7dcff'), Math.max(0, -tempBias));
  return cooled.multiplyScalar(brightness);
};

const getTileDirectionRect = (config: PlanetSurfaceConfig, tileIndex: number): TileDirection => {
  if (config.gridKind === 'geodesic') {
    return { x: 1, y: 0, z: 0 };
  }
  const w = config.w;
  const h = config.h;
  const q = tileIndex % w;
  const r = Math.floor(tileIndex / w);
  return surfaceDirFromTile(q, r, w, h, 0.5, 0.5);
};

export const buildSurfaceTileDirections = (config: PlanetSurfaceConfig, tileCount: number): TileDirection[] => {
  if (config.gridKind === 'geodesic') {
    const grid = buildGeodesicGrid(config.frequency);
    return Array.from({ length: tileCount }, (_, idx) => {
      const dir = getTileDirection(grid, idx);
      return dir ?? { x: 1, y: 0, z: 0 };
    });
  }
  return Array.from({ length: tileCount }, (_, idx) => getTileDirectionRect(config, idx));
};

const findClosestTileIndex = (dir: TileDirection, tileDirections: TileDirection[]): number => {
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < tileDirections.length; i += 1) {
    const t = tileDirections[i];
    const dot = dir.x * t.x + dir.y * t.y + dir.z * t.z;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
};

export const createPlanetSurfaceTexture = (params: {
  map: PlanetSurfaceMap;
  tileDirections: TileDirection[];
  resolution: number;
  mode?: SurfaceTextureMode;
}): THREE.Texture | null => {
  const { map, tileDirections } = params;
  const resolution = Math.max(16, Math.floor(params.resolution));
  const width = resolution;
  const height = Math.max(8, Math.floor(resolution / 2));
  const mode: SurfaceTextureMode = params.mode ?? 'shaded';

  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(width, height);
  const data = image.data;

  for (let y = 0; y < height; y += 1) {
    const v = height > 1 ? y / (height - 1) : 0;
    for (let x = 0; x < width; x += 1) {
      const u = width > 1 ? x / (width - 1) : 0;
      const dir = surfaceDirFromUv(u, v);
      const tileIndex = findClosestTileIndex(dir, tileDirections);
      const tile = map.tiles[tileIndex];
      const baseColor = BIOME_BASE_COLORS[tile.biome] ?? '#888888';
      let color = new THREE.Color(baseColor);
      if (mode === 'shaded') {
        const elevNorm = normalizeElevation(tile.elev, map.seaLevelElev);
        const tempC = tile.tempC2 / 2;
        const isWater = isWaterBiome(tile.biome);
        if (isWater) {
          const depthShade = clamp(-elevNorm * 0.2, 0, 0.15);
          color = color.lerp(new THREE.Color('#08213f'), depthShade);
        }
        color = applyShading(color, elevNorm, tempC);
      }

      const index = (y * width + x) * 4;
      data[index] = Math.round(color.r * 255);
      data[index + 1] = Math.round(color.g * 255);
      data[index + 2] = Math.round(color.b * 255);
      data[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  texture.anisotropy = 4;

  return texture;
};
