import {
  createTerrainField,
  generateSurfaceMapForState,
  getAstroForBody,
  getSurfaceDescriptor,
  getSurfaceTileDir,
  surfaceDirFromUv
} from '../../engine/planetSurface';
import { generateWorld } from '../../engine/worldgen/worldGenerator';
import { deserializeGameState } from '../../engine/serialization';
import type { GameScenario } from '../../content/scenarios';
import type { Biome, GameState, PlanetSurfaceMap, PlanetSurfaceTile, PlanetType } from '../../shared/shared';
import { FeatureBits } from '../../shared/shared';

export interface SurfaceMapWorkerState {
  planetSurfaceDescriptorsByBodyId: GameState['planetSurfaceDescriptorsByBodyId'];
  systems: GameState['systems'];
}

export interface SurfaceMapWorkerRequest {
  bodyId: string;
  state: SurfaceMapWorkerState;
  cloudShadow?: CloudShadowSettings | null;
  textureOptions?: SurfaceTextureOptions | null;
  allowSync?: boolean;
  bodyMeta?: {
    hasAtmosphere?: boolean;
    isMoon?: boolean;
    planetType?: PlanetType | null;
  };
}

export type CloudShadowSettings = {
  strength: number;
  noiseScale: number;
  threshold: number;
  softness: number;
  seed: number;
  seed2: number;
  bandStrength: number;
  bandFrequency: number;
  bandOffset: number;
};

export type SurfaceTextureOptions = {
  includeNormalMap?: boolean;
  includeAoMap?: boolean;
  includeRoughnessMap?: boolean;
  includeHeightMap?: boolean;
  includeEmissiveMap?: boolean;
  source?: 'field' | 'tiles';
};

export type SurfaceTextureResolution = { width: number; height: number };

export interface SurfaceTextureWorkerRequest extends SurfaceMapWorkerRequest {
  resolution: SurfaceTextureResolution;
}

export interface SurfaceMapWorkerResponseMessage {
  kind: 'surfaceMap';
  id: number;
  payload: {
    map: PlanetSurfaceMap | null;
    error?: string;
  };
}

export interface SurfaceTextureWorkerResponseMessage {
  kind: 'surfaceTexture';
  id: number;
  payload: {
    bodyId: string;
    width: number;
    height: number;
    rgba: Uint8Array | null;
    normalRgba?: Uint8Array | null;
    aoRgba?: Uint8Array | null;
    roughnessRgba?: Uint8Array | null;
    heightRgba?: Uint8Array | null;
    emissiveRgba?: Uint8Array | null;
    error?: string;
  };
}

export type BootstrapWorkerRequestPayload =
  | { type: 'START_NEW_GAME'; scenario: GameScenario }
  | { type: 'LOAD_GAME'; saveJson: string };

export type BootstrapProgressDetail = { current: number; total: number };

export type BootstrapWorkerResponseMessage =
  | {
      kind: 'bootstrap';
      id: number;
      payload: {
        type: 'progress';
        stage: 'worldgen' | 'deserialize';
        progress: number;
        detail?: BootstrapProgressDetail;
      };
    }
  | {
      kind: 'bootstrap';
      id: number;
      payload: {
        type: 'done';
        state: GameState;
      };
    }
  | {
      kind: 'bootstrap';
      id: number;
      payload: {
        type: 'error';
        message: string;
      };
    };

type SurfaceMapWorkerRequestMessage = {
  kind: 'surfaceMap';
  id: number;
  payload: SurfaceMapWorkerRequest;
};

type SurfaceTextureWorkerRequestMessage = {
  kind: 'surfaceTexture';
  id: number;
  payload: SurfaceTextureWorkerRequest;
};

type BootstrapWorkerRequestMessage = {
  kind: 'bootstrap';
  id: number;
  payload: BootstrapWorkerRequestPayload;
};

type WorkerRequestMessage =
  | SurfaceMapWorkerRequestMessage
  | SurfaceTextureWorkerRequestMessage
  | BootstrapWorkerRequestMessage
  | { id: number; payload: SurfaceMapWorkerRequest };

const postResponse = (
  message: SurfaceMapWorkerResponseMessage | SurfaceTextureWorkerResponseMessage | BootstrapWorkerResponseMessage,
  transfer?: Transferable[]
) => {
  (self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void }).postMessage(message, transfer);
};

const postBootstrapProgress = (id: number, update: { stage: 'worldgen' | 'deserialize'; progress: number; detail?: BootstrapProgressDetail }) => {
  postResponse({
    kind: 'bootstrap',
    id,
    payload: {
      type: 'progress',
      stage: update.stage,
      progress: update.progress,
      detail: update.detail
    }
  });
};

const postBootstrapDone = (id: number, state: GameState) => {
  postResponse({ kind: 'bootstrap', id, payload: { type: 'done', state } });
};

const postBootstrapError = (id: number, error: unknown) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  postResponse({ kind: 'bootstrap', id, payload: { type: 'error', message: errorMessage } });
};

const biomeColors: Record<Biome, string> = {
  ocean: '#0a75c2',
  coast: '#2bb9a8',
  lake: '#4f9dfd',
  ice: '#f2f7fb',
  fractured_ice: '#d7e6f6',
  dusty_ice: '#c9d2c8',
  cryovolcanic: '#9aaec7',
  tundra: '#ced4a4',
  taiga: '#1b6b4b',
  grassland: '#8ccb4a',
  forest: '#1e7c2f',
  rainforest: '#22a95f',
  desert: '#e3b04c',
  ash_desert: '#a88463',
  thermal_polygons: '#b6a46d',
  lava_flats: '#b3402c',
  vitrified: '#6b7c8a',
  oxidized: '#b35a3a',
  compressed_plateau: '#7c7f75',
  chemical_erosion: '#7aa081',
  fossil_basin: '#c1a07a',
  rocky: '#9b8974',
  mountain: '#565f6b',
  volcanic: '#e05b3c',
  cratered: '#8a60c6'
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const mixRgb = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => ([
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t)
]);

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

const surfaceUvFromDir = (dir: { x: number; y: number; z: number }): { u: number; v: number } => {
  const lon = Math.atan2(dir.z, dir.x);
  const lat = Math.asin(Math.max(-1, Math.min(1, dir.y)));
  const u = (lon + Math.PI) / (Math.PI * 2);
  const v = (lat + Math.PI / 2) / Math.PI;
  return { u, v };
};

type TerrainDetailLevel = 'full' | 'medium' | 'low';

const resolveTerrainDetailLevel = (resolution: SurfaceTextureResolution): TerrainDetailLevel => {
  if (resolution.width <= 256) return 'low';
  if (resolution.width <= 512) return 'medium';
  return 'full';
};

const hexToRgb8 = (hex: string): { r: number; g: number; b: number } => {
  const raw = hex.startsWith('#') ? hex.slice(1) : hex;
  const int = Number.parseInt(raw, 16);
  // #RRGGBB only
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
};

const srgbToLinear = (s: number): number => {
  if (s <= 0.04045) return s / 12.92;
  return Math.pow((s + 0.055) / 1.055, 2.4);
};

const linearToSrgb = (l: number): number => {
  if (l <= 0.0031308) return 12.92 * l;
  return 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
};

const linearToSrgbByte = (l: number): number => Math.round(clamp01(linearToSrgb(Math.max(0, l))) * 255);

const biomeLinearRgb = (() => {
  const out: Record<Biome, [number, number, number]> = {} as Record<Biome, [number, number, number]>;
  (Object.keys(biomeColors) as Biome[]).forEach((biome) => {
    const { r, g, b } = hexToRgb8(biomeColors[biome]);
    out[biome] = [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
  });
  return out;
})();

const ICE_PALETTE = {
  snow: mixRgb(biomeLinearRgb.ice, [1, 1, 1], 0.35),
  compact: biomeLinearRgb.ice,
  old: biomeLinearRgb.fractured_ice,
  dusty: biomeLinearRgb.dusty_ice,
  cryo: biomeLinearRgb.cryovolcanic,
  fracture: biomeLinearRgb.cryovolcanic,
  rock: biomeLinearRgb.rocky
};

const ICE_ROUGHNESS = {
  snow: 0.82,
  compact: 0.28,
  old: 0.54,
  dusty: 0.62,
  cryo: 0.58,
  fracture: 0.6,
  rock: 0.72
};

const CITY_LIGHTS_COLOR = '#fbd38d';
const POLE_BLEND_ROWS = 2;
const POLE_BLEND_STRENGTH = 0.35;

const cityLightLinearRgb = (() => {
  const { r, g, b } = hexToRgb8(CITY_LIGHTS_COLOR);
  return [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
})();

const wrapIndex = (index: number, mod: number): number => {
  if (mod <= 0) return 0;
  const m = index % mod;
  return m < 0 ? m + mod : m;
};

const hash2 = (x: number, y: number, seed: number): number => {
  const xi = x | 0;
  const yi = y | 0;
  let h = seed >>> 0;
  h ^= Math.imul(xi, 0x9e3779b1);
  h ^= Math.imul(yi, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
};

const createSeededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
};

const randomUnitDir = (rand: () => number): { x: number; y: number; z: number } => {
  const u = rand();
  const v = rand();
  const theta = u * Math.PI * 2;
  const z = v * 2 - 1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: r * Math.cos(theta), y: z, z: r * Math.sin(theta) };
};

const buildFracturePlanes = (
  seed: number,
  count: number,
  tectonicsIndex: number
): Array<{ dir: { x: number; y: number; z: number }; width: number; strength: number }> => {
  const rand = createSeededRandom(seed);
  const planes: Array<{ dir: { x: number; y: number; z: number }; width: number; strength: number }> = [];
  const widthScale = 0.75 + tectonicsIndex * 0.5;
  for (let i = 0; i < count; i += 1) {
    planes.push({
      dir: randomUnitDir(rand),
      width: lerp(0.008, 0.02, rand()) * widthScale,
      strength: lerp(0.55, 1, rand())
    });
  }
  return planes;
};

const blendPolarRows = (buffer: Uint8Array, width: number, height: number): void => {
  if (height <= POLE_BLEND_ROWS * 2 + 1) return;
  for (let row = 0; row < POLE_BLEND_ROWS; row += 1) {
    const t = ((POLE_BLEND_ROWS - row) / (POLE_BLEND_ROWS + 1)) * POLE_BLEND_STRENGTH;
    const yTop = row;
    const yTopNext = row + 1;
    const yBottom = height - 1 - row;
    const yBottomPrev = height - 2 - row;
    const topOffset = yTop * width * 4;
    const topNextOffset = yTopNext * width * 4;
    const bottomOffset = yBottom * width * 4;
    const bottomPrevOffset = yBottomPrev * width * 4;

    for (let x = 0; x < width * 4; x += 1) {
      buffer[topOffset + x] = Math.round(lerp(buffer[topOffset + x], buffer[topNextOffset + x], t));
      buffer[bottomOffset + x] = Math.round(lerp(buffer[bottomOffset + x], buffer[bottomPrevOffset + x], t));
    }
  }
};

const blendPolarRowsFloat = (buffer: Float32Array, width: number, height: number): void => {
  if (height <= POLE_BLEND_ROWS * 2 + 1) return;
  for (let row = 0; row < POLE_BLEND_ROWS; row += 1) {
    const t = ((POLE_BLEND_ROWS - row) / (POLE_BLEND_ROWS + 1)) * POLE_BLEND_STRENGTH;
    const yTop = row;
    const yTopNext = row + 1;
    const yBottom = height - 1 - row;
    const yBottomPrev = height - 2 - row;
    const topOffset = yTop * width;
    const topNextOffset = yTopNext * width;
    const bottomOffset = yBottom * width;
    const bottomPrevOffset = yBottomPrev * width;

    for (let x = 0; x < width; x += 1) {
      buffer[topOffset + x] = lerp(buffer[topOffset + x], buffer[topNextOffset + x], t);
      buffer[bottomOffset + x] = lerp(buffer[bottomOffset + x], buffer[bottomPrevOffset + x], t);
    }
  }
};

const valueNoise2D = (x: number, y: number, seed: number, wrapPeriodX?: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const xf = x - x0;
  const yf = y - y0;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const xi0 = typeof wrapPeriodX === 'number' ? wrapIndex(x0, wrapPeriodX) : x0;
  const xi1 = typeof wrapPeriodX === 'number' ? wrapIndex(x0 + 1, wrapPeriodX) : x0 + 1;
  const n00 = hash2(xi0, y0, seed);
  const n10 = hash2(xi1, y0, seed);
  const n01 = hash2(xi0, y0 + 1, seed);
  const n11 = hash2(xi1, y0 + 1, seed);
  const nx0 = lerp(n00, n10, sx);
  const nx1 = lerp(n01, n11, sx);
  return lerp(nx0, nx1, sy);
};

const buildSettlementField = (
  map: PlanetSurfaceMap,
  width: number,
  height: number
): Float32Array | null => {
  if (!map.settlements.length) return null;
  const config = map.descriptor.config;
  const wrapX = config.gridKind === 'geodesic' ? false : Boolean(config.wrapX);
  const field = new Float32Array(width * height);
  const seedBase = map.descriptor.seed >>> 0;

  map.settlements.forEach((settlement, index) => {
    const coord = settlement.coord;
    let u: number | null = null;
    let v: number | null = null;
    if (config.gridKind === 'geodesic') {
      const dir = getSurfaceTileDir(map.descriptor, settlement.tileId);
      if (!dir) return;
      const uv = surfaceUvFromDir(dir);
      u = uv.u;
      v = uv.v;
    } else if (coord) {
      u = (coord.q + 0.5) / config.w;
      v = (coord.r + 0.5) / config.h;
    }
    if (u === null || v === null) return;
    const seedX = coord ? coord.q : settlement.tileId;
    const seedY = coord ? coord.r : settlement.tileId;
    const seed = Math.floor(hash2(seedX + index * 17, seedY, seedBase) * 0xffffffff);
    const rand = createSeededRandom(seed);
    const cx = u * width;
    const cy = v * height;
    const pop = Math.max(0, settlement.population ?? 0);
    const popNorm = clamp01(Math.log10(pop + 10) / 6);
    const radius = lerp(1.4, 6.2, popNorm) * (0.85 + rand() * 0.4);
    const intensity = lerp(0.35, 1, popNorm) * (settlement.isCapital ? 1.25 : 1);

    const x0 = Math.floor(cx - radius);
    const x1 = Math.ceil(cx + radius);
    const y0 = Math.floor(cy - radius);
    const y1 = Math.ceil(cy + radius);

    for (let y = y0; y <= y1; y += 1) {
      if (y < 0 || y >= height) continue;
      const dy = y - cy;
      for (let x = x0; x <= x1; x += 1) {
        let xx = x;
        if (wrapX) {
          xx = wrapIndex(x, width);
        } else if (x < 0 || x >= width) {
          continue;
        }
        const dx = x - cx;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        const t = dist / radius;
        const falloff = (1 - t);
        const glow = falloff * falloff * intensity;
        const idx = y * width + xx;
        if (glow > field[idx]) {
          field[idx] = glow;
        }
      }
    }
  });

  return field;
};

const blendSeamColumns = (buffer: Uint8Array, width: number, height: number): void => {
  if (width < 2) return;
  for (let y = 0; y < height; y += 1) {
    const left = (y * width) * 4;
    const right = (y * width + (width - 1)) * 4;
    for (let c = 0; c < 4; c += 1) {
      const avg = Math.round((buffer[left + c] + buffer[right + c]) * 0.5);
      buffer[left + c] = avg;
      buffer[right + c] = avg;
    }
  }
};

const blendSeamNormals = (buffer: Uint8Array, width: number, height: number): void => {
  if (width < 2) return;
  for (let y = 0; y < height; y += 1) {
    const left = (y * width) * 4;
    const right = (y * width + (width - 1)) * 4;
    const nxL = buffer[left] / 255 * 2 - 1;
    const nyL = buffer[left + 1] / 255 * 2 - 1;
    const nzL = buffer[left + 2] / 255 * 2 - 1;
    const nxR = buffer[right] / 255 * 2 - 1;
    const nyR = buffer[right + 1] / 255 * 2 - 1;
    const nzR = buffer[right + 2] / 255 * 2 - 1;
    let nx = (nxL + nxR) * 0.5;
    let ny = (nyL + nyR) * 0.5;
    let nz = (nzL + nzR) * 0.5;
    const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= invLen;
    ny *= invLen;
    nz *= invLen;
    const r = Math.round((nx * 0.5 + 0.5) * 255);
    const g = Math.round((ny * 0.5 + 0.5) * 255);
    const b = Math.round((nz * 0.5 + 0.5) * 255);
    buffer[left] = r;
    buffer[left + 1] = g;
    buffer[left + 2] = b;
    buffer[right] = r;
    buffer[right + 1] = g;
    buffer[right + 2] = b;
  }
};

const biomeRoughness = (biome: Biome): number => {
  switch (biome) {
    case 'ocean':
      return 0.1;
    case 'coast':
      return 0.22;
    case 'lake':
      return 0.12;
    case 'ice':
      return 0.45;
    case 'fractured_ice':
      return 0.5;
    case 'dusty_ice':
      return 0.55;
    case 'cryovolcanic':
      return 0.6;
    case 'tundra':
      return 0.65;
    case 'taiga':
      return 0.6;
    case 'grassland':
      return 0.55;
    case 'forest':
      return 0.5;
    case 'rainforest':
      return 0.45;
    case 'desert':
      return 0.8;
    case 'ash_desert':
      return 0.85;
    case 'thermal_polygons':
      return 0.78;
    case 'lava_flats':
    case 'volcanic':
      return 0.7;
    case 'vitrified':
      return 0.68;
    case 'oxidized':
      return 0.72;
    case 'compressed_plateau':
      return 0.72;
    case 'chemical_erosion':
      return 0.68;
    case 'fossil_basin':
      return 0.7;
    case 'rocky':
      return 0.82;
    case 'mountain':
      return 0.88;
    case 'cratered':
      return 0.85;
    default:
      return 0.7;
  }
};

const isWaterBiome = (biome: Biome): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';

const isIceBiome = (biome: Biome): boolean =>
  biome === 'ice' || biome === 'fractured_ice' || biome === 'dusty_ice' || biome === 'cryovolcanic';

const getTile = (tiles: PlanetSurfaceTile[], w: number, q: number, r: number): PlanetSurfaceTile => {
  return tiles[r * w + q];
};

const renderSurfaceTextureFromTiles = (
  map: PlanetSurfaceMap,
  resolution: SurfaceTextureResolution,
  cloudShadow?: CloudShadowSettings | null,
  textureOptions?: SurfaceTextureOptions | null
): {
  rgba: Uint8Array;
  normalRgba: Uint8Array | null;
  aoRgba: Uint8Array | null;
  roughnessRgba: Uint8Array | null;
  heightRgba: Uint8Array | null;
  emissiveRgba: Uint8Array | null;
} => {
  const config = map.descriptor.config;
  if (config.gridKind === 'geodesic') {
    throw new Error('Tile-based textures are not supported for geodesic grids.');
  }
  const { w, h, wrapX } = config;
  const width = Math.max(1, Math.floor(resolution.width));
  const height = Math.max(1, Math.floor(resolution.height));
  const rgba = new Uint8Array(width * height * 4);
  const includeNormalMap = textureOptions?.includeNormalMap ?? true;
  const includeAoMap = textureOptions?.includeAoMap ?? true;
  const includeRoughnessMap = textureOptions?.includeRoughnessMap ?? true;
  const includeHeightMap = textureOptions?.includeHeightMap ?? false;
  const includeEmissiveMap = textureOptions?.includeEmissiveMap ?? false;
  const roughnessRgba = includeRoughnessMap ? new Uint8Array(width * height * 4) : null;
  const heightRgba = includeHeightMap ? new Uint8Array(width * height * 4) : null;
  const emissiveRgba = includeEmissiveMap ? new Uint8Array(width * height * 4) : null;
  const heightField = (includeNormalMap || includeAoMap || includeHeightMap) ? new Float32Array(width * height) : null;
  const useWrap = Boolean(wrapX);
  const baseSeed = map.descriptor.seed >>> 0;
  const envRand = createSeededRandom(baseSeed ^ 0x61c88647);
  const tectonicsIndex = clamp01(0.25 + envRand() * 0.6);
  const erosionIndex = clamp01(0.2 + envRand() * 0.5);
  const iceAgeScaleX = 3;
  const iceAgeScaleY = 2;
  const iceAgeSeed = baseSeed ^ 0x2b9947b1;
  const iceAgeWrap = useWrap ? iceAgeScaleX : undefined;
  const fractureNoiseScaleX = 7;
  const fractureNoiseScaleY = 4;
  const fractureNoiseSeed = baseSeed ^ 0x51f0c9d3;
  const fractureNoiseWrap = useWrap ? fractureNoiseScaleX : undefined;
  const fracturePlaneCount = Math.max(2, Math.round(2 + tectonicsIndex * 2));
  const fracturePlanes = buildFracturePlanes(baseSeed ^ 0x7f4a7c15, fracturePlaneCount, tectonicsIndex);

  const cloudShadowConfig = cloudShadow && cloudShadow.strength > 0 ? cloudShadow : null;
  const cloudNoiseScaleX = cloudShadowConfig ? Math.max(2, Math.round(cloudShadowConfig.noiseScale)) : 0;
  const cloudNoiseScaleY = cloudShadowConfig ? Math.max(1, Math.round(cloudNoiseScaleX * 0.6)) : 0;
  const settlementField = includeEmissiveMap ? buildSettlementField(map, width, height) : null;
  let hasEmissive = false;
  const cityMask = FeatureBits.City | FeatureBits.Capital;
  const seaLevel = map.seaLevelElev * 0.001;

  let heightMin = Number.POSITIVE_INFINITY;
  let heightMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < map.tiles.length; i += 1) {
    const elev = (map.tiles[i]?.elev ?? 0) * 0.001;
    heightMin = Math.min(heightMin, elev);
    heightMax = Math.max(heightMax, elev);
  }
  if (!Number.isFinite(heightMin) || !Number.isFinite(heightMax)) {
    heightMin = 0;
    heightMax = 0;
  }
  const heightRange = Math.max(1e-6, heightMax - heightMin);
  const invHeightRange = 1 / heightRange;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const latNorm = Math.abs(v - 0.5) * 2;
    const poleBlend = 1 - smoothstep(0.55, 0.92, latNorm);
    const detailFactor = lerp(0.35, 1, poleBlend);
    const rIndex = Math.max(0, Math.min(h - 1, Math.floor(v * h)));

    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const qBase = Math.floor(u * w);
      const qIndex = useWrap ? wrapIndex(qBase, w) : Math.max(0, Math.min(w - 1, qBase));
      const tile = getTile(map.tiles, w, qIndex, rIndex);
      const biome = tile?.biome ?? 'rocky';
      const baseColor = biomeLinearRgb[biome];
      let rLin = baseColor[0];
      let gLin = baseColor[1];
      let bLin = baseColor[2];

      const isWater = isWaterBiome(biome);
      const isIceSurface = isIceBiome(biome);
      const landWeight = isWater ? 0 : 1;
      const waterWeight = 1 - landWeight;
      const elev = (tile?.elev ?? 0) * 0.001;
      const heightNorm = clamp01((elev - heightMin) * invHeightRange);
      const landness = elev >= seaLevel ? clamp01((elev - seaLevel) * invHeightRange) : 0;
      const oceanness = elev < seaLevel ? clamp01((seaLevel - elev) * invHeightRange) : 0;
      const tempC = (tile?.tempC2 ?? 0) / 2;
      const moistNorm = clamp01((tile?.moist ?? 0) / 255);

      let iceRoughnessOverride: number | null = null;
      let iceHeightOffset = 0;
      let iceFracture = 0;

      if (isIceSurface) {
        const qLeft = useWrap ? wrapIndex(qIndex - 1, w) : Math.max(0, qIndex - 1);
        const qRight = useWrap ? wrapIndex(qIndex + 1, w) : Math.min(w - 1, qIndex + 1);
        const rUp = Math.max(0, rIndex - 1);
        const rDown = Math.min(h - 1, rIndex + 1);
        const elevL = (getTile(map.tiles, w, qLeft, rIndex)?.elev ?? 0) * 0.001;
        const elevR = (getTile(map.tiles, w, qRight, rIndex)?.elev ?? 0) * 0.001;
        const elevU = (getTile(map.tiles, w, qIndex, rUp)?.elev ?? 0) * 0.001;
        const elevD = (getTile(map.tiles, w, qIndex, rDown)?.elev ?? 0) * 0.001;
        const dx = elevR - elevL;
        const dy = elevD - elevU;
        const slope = clamp01(Math.sqrt(dx * dx + dy * dy) * invHeightRange * 1.6);
        const cold = clamp01((-tempC - 4) / 44);
        const warm = 1 - cold;
        const stability = clamp01((1 - slope)
          * (0.6 + 0.4 * (1 - tectonicsIndex))
          * (0.7 + 0.3 * (1 - erosionIndex))
          * (0.8 + 0.2 * (1 - oceanness)));
        const ageNoise = valueNoise2D(u * iceAgeScaleX, v * iceAgeScaleY, iceAgeSeed, iceAgeWrap);
        const age = clamp01((cold * 0.65 + stability * 0.35) * (0.65 + 0.35 * ageNoise));
        const snowWeight = clamp01((cold - 0.55) / 0.35)
          * clamp01((heightNorm - 0.25) / 0.55)
          * clamp01(moistNorm * 1.1 + 0.1);
        const oldWeight = clamp01((age - 0.6) / 0.35) * (1 - snowWeight);
        const rockWeight = clamp01((warm - 0.25) * 1.4 + slope * 0.7);
        const dustyBias = biome === 'dusty_ice' ? 0.65 : 0;
        const cryoBias = biome === 'cryovolcanic' ? 0.75 : 0;

        let rIce = ICE_PALETTE.compact[0];
        let gIce = ICE_PALETTE.compact[1];
        let bIce = ICE_PALETTE.compact[2];

        rIce = lerp(rIce, ICE_PALETTE.snow[0], snowWeight);
        gIce = lerp(gIce, ICE_PALETTE.snow[1], snowWeight);
        bIce = lerp(bIce, ICE_PALETTE.snow[2], snowWeight);

        rIce = lerp(rIce, ICE_PALETTE.old[0], oldWeight);
        gIce = lerp(gIce, ICE_PALETTE.old[1], oldWeight);
        bIce = lerp(bIce, ICE_PALETTE.old[2], oldWeight);

        rIce = lerp(rIce, ICE_PALETTE.dusty[0], dustyBias);
        gIce = lerp(gIce, ICE_PALETTE.dusty[1], dustyBias);
        bIce = lerp(bIce, ICE_PALETTE.dusty[2], dustyBias);

        rIce = lerp(rIce, ICE_PALETTE.cryo[0], cryoBias);
        gIce = lerp(gIce, ICE_PALETTE.cryo[1], cryoBias);
        bIce = lerp(bIce, ICE_PALETTE.cryo[2], cryoBias);

        rIce = lerp(rIce, ICE_PALETTE.rock[0], rockWeight);
        gIce = lerp(gIce, ICE_PALETTE.rock[1], rockWeight);
        bIce = lerp(bIce, ICE_PALETTE.rock[2], rockWeight);

        if (fracturePlanes.length) {
          const dir = surfaceDirFromUv(u, v);
          let fractureBase = 0;
          for (const plane of fracturePlanes) {
            const d = Math.abs(dir.x * plane.dir.x + dir.y * plane.dir.y + dir.z * plane.dir.z);
            const line = 1 - smoothstep(0, plane.width, d);
            fractureBase = Math.max(fractureBase, line * plane.strength);
          }
          const breakNoise = valueNoise2D(u * fractureNoiseScaleX, v * fractureNoiseScaleY, fractureNoiseSeed, fractureNoiseWrap);
          const breakMask = smoothstep(0.32, 0.78, breakNoise);
          let fracture = clamp01(fractureBase * breakMask);
          if (biome === 'fractured_ice') {
            fracture = clamp01(fracture + 0.25);
          }
          fracture *= oldWeight * (0.35 + 0.65 * tectonicsIndex);
          iceFracture = fracture;

          rIce = lerp(rIce, ICE_PALETTE.fracture[0], fracture);
          gIce = lerp(gIce, ICE_PALETTE.fracture[1], fracture);
          bIce = lerp(bIce, ICE_PALETTE.fracture[2], fracture);
        }

        rLin = rIce;
        gLin = gIce;
        bLin = bIce;

        let roughness = ICE_ROUGHNESS.compact;
        roughness = lerp(roughness, ICE_ROUGHNESS.snow, snowWeight);
        roughness = lerp(roughness, ICE_ROUGHNESS.old, oldWeight);
        roughness = lerp(roughness, ICE_ROUGHNESS.dusty, dustyBias);
        roughness = lerp(roughness, ICE_ROUGHNESS.cryo, cryoBias);
        roughness = lerp(roughness, ICE_ROUGHNESS.rock, rockWeight);
        roughness = lerp(roughness, ICE_ROUGHNESS.fracture, iceFracture);
        iceRoughnessOverride = roughness;
        iceHeightOffset = -iceFracture * 0.02;
      }

      let cloudShadowFactor = 1;
      if (cloudShadowConfig) {
        const shadowStrength = cloudShadowConfig.strength * detailFactor;
        if (shadowStrength > 0.001) {
          const shadowX = u * cloudNoiseScaleX;
          const shadowY = v * cloudNoiseScaleY;
          const wrapPeriod = useWrap ? cloudNoiseScaleX : undefined;
          const n1 = valueNoise2D(shadowX, shadowY, cloudShadowConfig.seed, wrapPeriod);
          const n2 = valueNoise2D(shadowX * 1.9, shadowY * 1.9, cloudShadowConfig.seed2, wrapPeriod ? wrapPeriod * 2 : undefined);
          let field = lerp(n1, n2, 0.35);
          if (cloudShadowConfig.bandStrength > 0 && cloudShadowConfig.bandFrequency > 0) {
            const lat = Math.sin((v - 0.5) * Math.PI);
            const stripe = 0.5 + 0.5 * Math.sin((lat + cloudShadowConfig.bandOffset) * cloudShadowConfig.bandFrequency);
            const band = smoothstep(0.25, 0.78, stripe);
            field *= lerp(1, band, clamp01(cloudShadowConfig.bandStrength));
          }
          const shadow = smoothstep(cloudShadowConfig.threshold, cloudShadowConfig.threshold + cloudShadowConfig.softness, field);
          cloudShadowFactor = 1 - shadowStrength * shadow;
        }
      }

      rLin *= cloudShadowFactor;
      gLin *= cloudShadowFactor;
      bLin *= cloudShadowFactor;

      const pixelIndex = y * width + x;
      const idx = pixelIndex * 4;
      rgba[idx] = linearToSrgbByte(rLin);
      rgba[idx + 1] = linearToSrgbByte(gLin);
      rgba[idx + 2] = linearToSrgbByte(bLin);
      rgba[idx + 3] = 255;

      if (roughnessRgba) {
        let roughness = clamp01(iceRoughnessOverride ?? biomeRoughness(biome));
        if (iceRoughnessOverride !== null) {
          roughness = clamp01(roughness + (1 - landness) * 0.04);
        }
        const roughByte = Math.round(roughness * 255);
        roughnessRgba[idx] = roughByte;
        roughnessRgba[idx + 1] = roughByte;
        roughnessRgba[idx + 2] = roughByte;
        roughnessRgba[idx + 3] = Math.round(clamp01(waterWeight) * 255);
      }

      if (heightField) {
        heightField[pixelIndex] = elev + iceHeightOffset;
      }

      if (emissiveRgba) {
        const rFloat = v * (h - 1);
        const r0 = Math.max(0, Math.min(h - 1, Math.floor(rFloat)));
        const r1 = Math.min(r0 + 1, h - 1);
        const rFrac = rFloat - r0;
        const wR0 = 1 - rFrac;
        const wR1 = rFrac;

        let qFloat: number;
        let q0: number;
        let q1: number;
        let qFrac: number;
        if (useWrap) {
          qFloat = u * w;
          const qFloor = Math.floor(qFloat);
          q0 = wrapIndex(qFloor, w);
          q1 = wrapIndex(qFloor + 1, w);
          qFrac = qFloat - qFloor;
        } else {
          qFloat = u * (w - 1);
          q0 = Math.max(0, Math.min(w - 1, Math.floor(qFloat)));
          q1 = Math.min(q0 + 1, w - 1);
          qFrac = qFloat - q0;
        }

        const wQ0 = 1 - qFrac;
        const wQ1 = qFrac;

        const t00 = getTile(map.tiles, w, q0, r0);
        const t10 = getTile(map.tiles, w, q1, r0);
        const t01 = getTile(map.tiles, w, q0, r1);
        const t11 = getTile(map.tiles, w, q1, r1);
        const w00 = wQ0 * wR0;
        const w10 = wQ1 * wR0;
        const w01 = wQ0 * wR1;
        const w11 = wQ1 * wR1;

        const cityWeight = ((t00.featureBits & cityMask) !== 0 ? w00 : 0)
          + ((t10.featureBits & cityMask) !== 0 ? w10 : 0)
          + ((t01.featureBits & cityMask) !== 0 ? w01 : 0)
          + ((t11.featureBits & cityMask) !== 0 ? w11 : 0);

        const settlementGlow = settlementField ? settlementField[pixelIndex] : 0;
        const featureGlow = cityWeight * 0.4;
        let emissiveLevel = (settlementGlow + featureGlow) * landWeight;
        emissiveLevel = clamp01(emissiveLevel);
        if (emissiveLevel > 0.001) {
          hasEmissive = true;
          emissiveRgba[idx] = linearToSrgbByte(cityLightLinearRgb[0] * emissiveLevel);
          emissiveRgba[idx + 1] = linearToSrgbByte(cityLightLinearRgb[1] * emissiveLevel);
          emissiveRgba[idx + 2] = linearToSrgbByte(cityLightLinearRgb[2] * emissiveLevel);
          emissiveRgba[idx + 3] = 255;
        } else {
          emissiveRgba[idx] = 0;
          emissiveRgba[idx + 1] = 0;
          emissiveRgba[idx + 2] = 0;
          emissiveRgba[idx + 3] = 0;
        }
      }
    }
  }

  let seaLevelNorm = 0;
  if (heightField) {
    for (let i = 0; i < heightField.length; i += 1) {
      heightField[i] = (heightField[i] - heightMin) * invHeightRange;
    }
    seaLevelNorm = (seaLevel - heightMin) * invHeightRange;
  }

  if (heightRgba && heightField) {
    for (let i = 0; i < heightField.length; i += 1) {
      const heightNorm = heightField[i];
      const landBlend = clamp01((heightNorm - (seaLevelNorm - 0.02)) / 0.04);
      const heightForMap = lerp(seaLevelNorm, heightNorm, landBlend);
      const heightEncoded = clamp01(0.5 + (heightForMap - seaLevelNorm) * 0.85);
      const heightByte = Math.round(heightEncoded * 255);
      const idx = i * 4;
      heightRgba[idx] = heightByte;
      heightRgba[idx + 1] = heightByte;
      heightRgba[idx + 2] = heightByte;
      heightRgba[idx + 3] = 255;
    }
  }

  const finalEmissiveRgba = emissiveRgba && hasEmissive ? emissiveRgba : null;

  const shouldComputeRelief = Boolean(heightField) && (includeNormalMap || includeAoMap) && width >= 256 && height >= 128;
  if (!shouldComputeRelief) {
    return { rgba, normalRgba: null, aoRgba: null, roughnessRgba, heightRgba, emissiveRgba: finalEmissiveRgba };
  }

  const normalRgba = includeNormalMap ? new Uint8Array(width * height * 4) : null;
  const aoRgba = includeAoMap ? new Uint8Array(width * height * 4) : null;
  const elevRange = heightRange * 1000;
  const heightScale = Math.min(1.6, Math.max(0.55, elevRange / 1200));
  const normalStrength = 1.1 * heightScale;
  const aoStrength = 1.5 * heightScale;
  const heightFieldData = heightField as Float32Array;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const latNorm = Math.abs(v - 0.5) * 2;
    const poleBlend = 1 - smoothstep(0.55, 0.92, latNorm);
    const detailFactor = lerp(0.35, 1, poleBlend);
    const rowNormalStrength = normalStrength * detailFactor;
    const rowAoStrength = aoStrength * detailFactor;
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < height - 1 ? y + 1 : height - 1;
    const row = y * width;
    const row0 = y0 * width;
    const row1 = y1 * width;

    for (let x = 0; x < width; x += 1) {
      const x0 = useWrap ? (x === 0 ? width - 1 : x - 1) : Math.max(0, x - 1);
      const x1 = useWrap ? (x === width - 1 ? 0 : x + 1) : Math.min(width - 1, x + 1);

      const idx = row + x;
      const hC = heightFieldData[idx];
      const hL = heightFieldData[row + x0];
      const hR = heightFieldData[row + x1];
      const hU = heightFieldData[row0 + x];
      const hD = heightFieldData[row1 + x];

      const dx = hR - hL;
      const dy = hD - hU;
      let nx = -dx * rowNormalStrength;
      let ny = -dy * rowNormalStrength;
      let nz = 1.0;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const nIdx = idx * 4;
      if (normalRgba) {
        normalRgba[nIdx] = Math.round((nx * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 3] = 255;
      }

      const hUL = heightFieldData[row0 + x0];
      const hUR = heightFieldData[row0 + x1];
      const hDL = heightFieldData[row1 + x0];
      const hDR = heightFieldData[row1 + x1];
      const neighborAvg = (hL + hR + hU + hD + hUL + hUR + hDL + hDR) / 8;
      const concavity = Math.max(0, neighborAvg - hC);
      const waterFactor = hC < seaLevelNorm ? 0.55 : 1;
      let ao = 1 - concavity * (2.1 * rowAoStrength) * waterFactor;
      ao = Math.min(1, Math.max(0.6, ao));

      if (aoRgba) {
        const aoByte = Math.round(ao * 255);
        aoRgba[nIdx] = aoByte;
        aoRgba[nIdx + 1] = aoByte;
        aoRgba[nIdx + 2] = aoByte;
        aoRgba[nIdx + 3] = 255;
      }
    }
  }

  return { rgba, normalRgba, aoRgba, roughnessRgba, heightRgba, emissiveRgba: finalEmissiveRgba };
};

const renderSurfaceTexture = (
  map: PlanetSurfaceMap,
  terrain: ReturnType<typeof createTerrainField>,
  resolution: SurfaceTextureResolution,
  cloudShadow?: CloudShadowSettings | null,
  textureOptions?: SurfaceTextureOptions | null
): {
  rgba: Uint8Array;
  normalRgba: Uint8Array | null;
  aoRgba: Uint8Array | null;
  roughnessRgba: Uint8Array | null;
  heightRgba: Uint8Array | null;
  emissiveRgba: Uint8Array | null;
} => {
  const config = map.descriptor.config;
  if (textureOptions?.source === 'tiles' && config.gridKind !== 'geodesic') {
    return renderSurfaceTextureFromTiles(map, resolution, cloudShadow, textureOptions);
  }
  const width = Math.max(1, Math.floor(resolution.width));
  const height = Math.max(1, Math.floor(resolution.height));
  const rgba = new Uint8Array(width * height * 4);
  const includeNormalMap = textureOptions?.includeNormalMap ?? true;
  const includeAoMap = textureOptions?.includeAoMap ?? true;
  const includeRoughnessMap = textureOptions?.includeRoughnessMap ?? true;
  const includeHeightMap = textureOptions?.includeHeightMap ?? false;
  const includeEmissiveMap = textureOptions?.includeEmissiveMap ?? false;
  const roughnessRgba = includeRoughnessMap ? new Uint8Array(width * height * 4) : null;
  const heightRgba = includeHeightMap ? new Uint8Array(width * height * 4) : null;
  const emissiveRgba = includeEmissiveMap ? new Uint8Array(width * height * 4) : null;
  const heightField = (includeNormalMap || includeAoMap || includeHeightMap) ? new Float32Array(width * height) : null;
  const useWrap = config.gridKind === 'geodesic' ? false : Boolean(config.wrapX);
  const env = terrain.env;
  const baseSeed = map.descriptor.seed >>> 0;
  const iceAgeScaleX = 3;
  const iceAgeScaleY = 2;
  const iceAgeSeed = baseSeed ^ 0x2b9947b1;
  const iceAgeWrap = useWrap ? iceAgeScaleX : undefined;
  const fractureNoiseScaleX = 7;
  const fractureNoiseScaleY = 4;
  const fractureNoiseSeed = baseSeed ^ 0x51f0c9d3;
  const fractureNoiseWrap = useWrap ? fractureNoiseScaleX : undefined;
  const fracturePlaneCount = Math.max(2, Math.round(2 + env.tectonicsIndex * 2));
  const fracturePlanes = buildFracturePlanes(baseSeed ^ 0x7f4a7c15, fracturePlaneCount, env.tectonicsIndex);

  const cloudShadowConfig = cloudShadow && cloudShadow.strength > 0 ? cloudShadow : null;
  const cloudNoiseScaleX = cloudShadowConfig ? Math.max(2, Math.round(cloudShadowConfig.noiseScale)) : 0;
  const cloudNoiseScaleY = cloudShadowConfig ? Math.max(1, Math.round(cloudNoiseScaleX * 0.6)) : 0;
  const settlementField = includeEmissiveMap ? buildSettlementField(map, width, height) : null;
  let hasEmissive = false;
  const cityMask = FeatureBits.City | FeatureBits.Capital;
  const coastColor = biomeLinearRgb.coast;
  const seaLevel = terrain.seaLevelElev;

  let heightMin = Number.POSITIVE_INFINITY;
  let heightMax = Number.NEGATIVE_INFINITY;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const latNorm = Math.abs(v - 0.5) * 2;
    const poleBlend = 1 - smoothstep(0.55, 0.92, latNorm);
    const detailFactor = lerp(0.35, 1, poleBlend);

    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const dir = surfaceDirFromUv(u, v);
      const sample = terrain.sample(dir);

      const baseColor = biomeLinearRgb[sample.biome];
      const isFrozenSurface = sample.isWater && terrain.hydrologyMode === 'frozen';
      const shoreMix = sample.coast * (sample.isWater && !isFrozenSurface ? 0.65 : 0.35);
      let rLin = lerp(baseColor[0], coastColor[0], shoreMix);
      let gLin = lerp(baseColor[1], coastColor[1], shoreMix);
      let bLin = lerp(baseColor[2], coastColor[2], shoreMix);

      const tempNorm = clamp01((sample.tempC + 50) / 100);
      const moistNorm = clamp01(sample.moist);
      const isIceSurface = isFrozenSurface || isIceBiome(sample.biome);
      const landWeight = sample.isWater && !isFrozenSurface ? 0 : 1;
      const waterWeight = 1 - landWeight;

      let iceRoughnessOverride: number | null = null;
      let iceHeightOffset = 0;
      let iceFracture = 0;

      if (isIceSurface) {
        const cold = clamp01((-sample.tempC - 4) / 44);
        const warm = 1 - cold;
        const altitude = clamp01(sample.landness);
        const slope = clamp01(sample.relief * 1.1 + Math.abs(sample.detail) * 0.45);
        const stability = clamp01((1 - slope) * (0.6 + 0.4 * (1 - env.tectonicsIndex)) * (0.7 + 0.3 * (1 - env.erosionIndex)));
        const ageNoise = valueNoise2D(u * iceAgeScaleX, v * iceAgeScaleY, iceAgeSeed, iceAgeWrap);
        const age = clamp01((cold * 0.65 + stability * 0.35) * (0.65 + 0.35 * ageNoise));
        const snowWeight = clamp01((cold - 0.55) / 0.35)
          * clamp01((altitude - 0.25) / 0.55)
          * clamp01(moistNorm * 1.1 + 0.1);
        const oldWeight = clamp01((age - 0.6) / 0.35) * (1 - snowWeight);
        const rockWeight = clamp01((warm - 0.25) * 1.4 + slope * 0.7);
        const dustyBias = sample.biome === 'dusty_ice' ? 0.65 : 0;
        const cryoBias = sample.biome === 'cryovolcanic' ? 0.75 : 0;

        let rIce = ICE_PALETTE.compact[0];
        let gIce = ICE_PALETTE.compact[1];
        let bIce = ICE_PALETTE.compact[2];

        rIce = lerp(rIce, ICE_PALETTE.snow[0], snowWeight);
        gIce = lerp(gIce, ICE_PALETTE.snow[1], snowWeight);
        bIce = lerp(bIce, ICE_PALETTE.snow[2], snowWeight);

        rIce = lerp(rIce, ICE_PALETTE.old[0], oldWeight);
        gIce = lerp(gIce, ICE_PALETTE.old[1], oldWeight);
        bIce = lerp(bIce, ICE_PALETTE.old[2], oldWeight);

        rIce = lerp(rIce, ICE_PALETTE.dusty[0], dustyBias);
        gIce = lerp(gIce, ICE_PALETTE.dusty[1], dustyBias);
        bIce = lerp(bIce, ICE_PALETTE.dusty[2], dustyBias);

        rIce = lerp(rIce, ICE_PALETTE.cryo[0], cryoBias);
        gIce = lerp(gIce, ICE_PALETTE.cryo[1], cryoBias);
        bIce = lerp(bIce, ICE_PALETTE.cryo[2], cryoBias);

        rIce = lerp(rIce, ICE_PALETTE.rock[0], rockWeight);
        gIce = lerp(gIce, ICE_PALETTE.rock[1], rockWeight);
        bIce = lerp(bIce, ICE_PALETTE.rock[2], rockWeight);

        if (fracturePlanes.length) {
          let fractureBase = 0;
          for (const plane of fracturePlanes) {
            const d = Math.abs(dir.x * plane.dir.x + dir.y * plane.dir.y + dir.z * plane.dir.z);
            const line = 1 - smoothstep(0, plane.width, d);
            fractureBase = Math.max(fractureBase, line * plane.strength);
          }
          const breakNoise = valueNoise2D(u * fractureNoiseScaleX, v * fractureNoiseScaleY, fractureNoiseSeed, fractureNoiseWrap);
          const breakMask = smoothstep(0.32, 0.78, breakNoise);
          let fracture = clamp01(fractureBase * breakMask);
          if (sample.biome === 'fractured_ice') {
            fracture = clamp01(fracture + 0.25);
          }
          fracture *= oldWeight * (0.35 + 0.65 * env.tectonicsIndex);
          iceFracture = fracture;

          rIce = lerp(rIce, ICE_PALETTE.fracture[0], fracture);
          gIce = lerp(gIce, ICE_PALETTE.fracture[1], fracture);
          bIce = lerp(bIce, ICE_PALETTE.fracture[2], fracture);
        }

        rLin = rIce;
        gLin = gIce;
        bLin = bIce;

        let roughness = ICE_ROUGHNESS.compact;
        roughness = lerp(roughness, ICE_ROUGHNESS.snow, snowWeight);
        roughness = lerp(roughness, ICE_ROUGHNESS.old, oldWeight);
        roughness = lerp(roughness, ICE_ROUGHNESS.dusty, dustyBias);
        roughness = lerp(roughness, ICE_ROUGHNESS.cryo, cryoBias);
        roughness = lerp(roughness, ICE_ROUGHNESS.rock, rockWeight);
        roughness = lerp(roughness, ICE_ROUGHNESS.fracture, iceFracture);
        iceRoughnessOverride = roughness;
        iceHeightOffset = -iceFracture * 0.02;
      }

      const climateShade = 1 + landWeight * ((moistNorm - 0.5) * 0.05 + (tempNorm - 0.5) * 0.03);
      const reliefShade = 1 + (sample.relief - 0.5) * 0.14 * detailFactor;
      const detailShade = 1 + sample.detail * 0.08 * detailFactor;
      const altShade = 1 + landWeight * (sample.landness - 0.5) * 0.12 - waterWeight * sample.oceanness * 0.12;
      const shallow = 1 - clamp01(sample.oceanness * 1.8);
      const waterShade = 1 + waterWeight * (shallow * 0.08 - sample.oceanness * 0.2);

      let cloudShadowFactor = 1;
      if (cloudShadowConfig) {
        const shadowStrength = cloudShadowConfig.strength * detailFactor;
        if (shadowStrength > 0.001) {
          const shadowX = u * cloudNoiseScaleX;
          const shadowY = v * cloudNoiseScaleY;
          const wrapPeriod = useWrap ? cloudNoiseScaleX : undefined;
          const n1 = valueNoise2D(shadowX, shadowY, cloudShadowConfig.seed, wrapPeriod);
          const n2 = valueNoise2D(shadowX * 1.9, shadowY * 1.9, cloudShadowConfig.seed2, wrapPeriod ? wrapPeriod * 2 : undefined);
          let field = lerp(n1, n2, 0.35);
          if (cloudShadowConfig.bandStrength > 0 && cloudShadowConfig.bandFrequency > 0) {
            const lat = Math.sin((v - 0.5) * Math.PI);
            const stripe = 0.5 + 0.5 * Math.sin((lat + cloudShadowConfig.bandOffset) * cloudShadowConfig.bandFrequency);
            const band = smoothstep(0.25, 0.78, stripe);
            field *= lerp(1, band, clamp01(cloudShadowConfig.bandStrength));
          }
          const shadow = smoothstep(cloudShadowConfig.threshold, cloudShadowConfig.threshold + cloudShadowConfig.softness, field);
          cloudShadowFactor = 1 - shadowStrength * shadow;
        }
      }

      rLin *= reliefShade * detailShade * climateShade * waterShade * altShade * cloudShadowFactor;
      gLin *= reliefShade * detailShade * climateShade * waterShade * altShade * cloudShadowFactor;
      bLin *= reliefShade * detailShade * climateShade * waterShade * altShade * cloudShadowFactor;

      if (sample.crater !== 0) {
        const craterShade = Math.max(0.7, Math.min(1.15, 1 + sample.crater * 0.35));
        rLin *= craterShade;
        gLin *= craterShade;
        bLin *= craterShade;
      }

      const pixelIndex = y * width + x;
      const idx = pixelIndex * 4;
      rgba[idx] = Math.round(clamp01(linearToSrgb(Math.max(0, rLin))) * 255);
      rgba[idx + 1] = Math.round(clamp01(linearToSrgb(Math.max(0, gLin))) * 255);
      rgba[idx + 2] = Math.round(clamp01(linearToSrgb(Math.max(0, bLin))) * 255);
      rgba[idx + 3] = 255;

      if (roughnessRgba) {
        const baseRough = iceRoughnessOverride ?? biomeRoughness(sample.biome);
        const dryness = clamp01(1 - moistNorm);
        let landRoughness = baseRough;
        if (iceRoughnessOverride === null) {
          landRoughness += (sample.relief - 0.5) * 0.18 * detailFactor + dryness * 0.08;
        } else {
          landRoughness += (sample.relief - 0.5) * 0.12 * detailFactor;
        }
        landRoughness += sample.detail * 0.04 * detailFactor;
        landRoughness = clamp01(landRoughness);
        const waterRoughness = clamp01(0.04 + shallow * 0.06 + sample.detail * 0.02);
        const coastBlend = sample.coast * 0.6;
        const waterBlend = sample.isWater && !isFrozenSurface ? 1 - coastBlend : coastBlend;
        let roughness = lerp(landRoughness, waterRoughness, waterBlend);
        if (sample.crater < 0) {
          roughness = clamp01(roughness + (-sample.crater) * 0.22);
        }

        const roughByte = Math.round(roughness * 255);
        roughnessRgba[idx] = roughByte;
        roughnessRgba[idx + 1] = roughByte;
        roughnessRgba[idx + 2] = roughByte;
        roughnessRgba[idx + 3] = Math.round(clamp01(waterWeight) * 255);
      }

      if (heightField) {
        const heightValue = sample.height + iceHeightOffset;
        heightField[pixelIndex] = heightValue;
        if (heightValue < heightMin) heightMin = heightValue;
        if (heightValue > heightMax) heightMax = heightValue;
      }

      if (emissiveRgba) {
        let cityWeight = 0;
        const rFloat = v * (h - 1);
        const r0 = Math.max(0, Math.min(h - 1, Math.floor(rFloat)));
        const r1 = Math.min(r0 + 1, h - 1);
        const rFrac = rFloat - r0;
        const wR0 = 1 - rFrac;
        const wR1 = rFrac;

        let qFloat: number;
        let q0: number;
        let q1: number;
        let qFrac: number;
        if (useWrap) {
          qFloat = u * w;
          const qFloor = Math.floor(qFloat);
          q0 = wrapIndex(qFloor, w);
          q1 = wrapIndex(qFloor + 1, w);
          qFrac = qFloat - qFloor;
        } else {
          qFloat = u * (w - 1);
          q0 = Math.max(0, Math.min(w - 1, Math.floor(qFloat)));
          q1 = Math.min(q0 + 1, w - 1);
          qFrac = qFloat - q0;
        }

        const wQ0 = 1 - qFrac;
        const wQ1 = qFrac;

        const t00 = getTile(map.tiles, w, q0, r0);
        const t10 = getTile(map.tiles, w, q1, r0);
        const t01 = getTile(map.tiles, w, q0, r1);
        const t11 = getTile(map.tiles, w, q1, r1);
        const w00 = wQ0 * wR0;
        const w10 = wQ1 * wR0;
        const w01 = wQ0 * wR1;
        const w11 = wQ1 * wR1;

        cityWeight = ((t00.featureBits & cityMask) !== 0 ? w00 : 0)
          + ((t10.featureBits & cityMask) !== 0 ? w10 : 0)
          + ((t01.featureBits & cityMask) !== 0 ? w01 : 0)
          + ((t11.featureBits & cityMask) !== 0 ? w11 : 0);

        const settlementGlow = settlementField ? settlementField[pixelIndex] : 0;
        const featureGlow = cityWeight * 0.4;
        let emissiveLevel = (settlementGlow + featureGlow) * landWeight;
        emissiveLevel = clamp01(emissiveLevel);
        if (emissiveLevel > 0.001) {
          hasEmissive = true;
          emissiveRgba[idx] = linearToSrgbByte(cityLightLinearRgb[0] * emissiveLevel);
          emissiveRgba[idx + 1] = linearToSrgbByte(cityLightLinearRgb[1] * emissiveLevel);
          emissiveRgba[idx + 2] = linearToSrgbByte(cityLightLinearRgb[2] * emissiveLevel);
          emissiveRgba[idx + 3] = 255;
        } else {
          emissiveRgba[idx] = 0;
          emissiveRgba[idx + 1] = 0;
          emissiveRgba[idx + 2] = 0;
          emissiveRgba[idx + 3] = 0;
        }
      }
    }
  }

  let heightRange = 0;
  let invHeightRange = 0;
  let seaLevelNorm = 0;
  if (heightField) {
    heightRange = Math.max(1e-6, heightMax - heightMin);
    invHeightRange = 1 / heightRange;
    for (let i = 0; i < heightField.length; i += 1) {
      heightField[i] = (heightField[i] - heightMin) * invHeightRange;
    }
    seaLevelNorm = (seaLevel - heightMin) * invHeightRange;
    blendPolarRowsFloat(heightField, width, height);
  }

  if (heightRgba && heightField) {
    for (let i = 0; i < heightField.length; i += 1) {
      const heightNorm = heightField[i];
      const landBlend = clamp01((heightNorm - (seaLevelNorm - 0.02)) / 0.04);
      const heightForMap = lerp(seaLevelNorm, heightNorm, landBlend);
      const heightEncoded = clamp01(0.5 + (heightForMap - seaLevelNorm) * 0.85);
      const heightByte = Math.round(heightEncoded * 255);
      const idx = i * 4;
      heightRgba[idx] = heightByte;
      heightRgba[idx + 1] = heightByte;
      heightRgba[idx + 2] = heightByte;
      heightRgba[idx + 3] = 255;
    }
  }

  const finalEmissiveRgba = emissiveRgba && hasEmissive ? emissiveRgba : null;

  const shouldComputeRelief = Boolean(heightField) && (includeNormalMap || includeAoMap) && width >= 256 && height >= 128;
  if (!shouldComputeRelief) {
    if (useWrap) {
      blendSeamColumns(rgba, width, height);
      if (roughnessRgba) {
        blendSeamColumns(roughnessRgba, width, height);
      }
      if (heightRgba) {
        blendSeamColumns(heightRgba, width, height);
      }
      if (finalEmissiveRgba) {
        blendSeamColumns(finalEmissiveRgba, width, height);
      }
    }
    blendPolarRows(rgba, width, height);
    if (roughnessRgba) {
      blendPolarRows(roughnessRgba, width, height);
    }
    if (heightRgba) {
      blendPolarRows(heightRgba, width, height);
    }
    if (finalEmissiveRgba) {
      blendPolarRows(finalEmissiveRgba, width, height);
    }
    return { rgba, normalRgba: null, aoRgba: null, roughnessRgba, heightRgba, emissiveRgba: finalEmissiveRgba };
  }

  const normalRgba = includeNormalMap ? new Uint8Array(width * height * 4) : null;
  const aoRgba = includeAoMap ? new Uint8Array(width * height * 4) : null;
  const elevRange = heightRange * 1000;
  const heightScale = Math.min(1.6, Math.max(0.55, elevRange / 1200));
  const normalStrength = 1.1 * heightScale;
  const aoStrength = 1.5 * heightScale;
  const heightFieldData = heightField as Float32Array;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    const latNorm = Math.abs(v - 0.5) * 2;
    const poleBlend = 1 - smoothstep(0.55, 0.92, latNorm);
    const detailFactor = lerp(0.35, 1, poleBlend);
    const rowNormalStrength = normalStrength * detailFactor;
    const rowAoStrength = aoStrength * detailFactor;
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < height - 1 ? y + 1 : height - 1;
    const row = y * width;
    const row0 = y0 * width;
    const row1 = y1 * width;

    for (let x = 0; x < width; x += 1) {
      const x0 = useWrap ? (x === 0 ? width - 1 : x - 1) : Math.max(0, x - 1);
      const x1 = useWrap ? (x === width - 1 ? 0 : x + 1) : Math.min(width - 1, x + 1);

      const idx = row + x;
      const hC = heightFieldData[idx];
      const hL = heightFieldData[row + x0];
      const hR = heightFieldData[row + x1];
      const hU = heightFieldData[row0 + x];
      const hD = heightFieldData[row1 + x];

      const dx = hR - hL;
      const dy = hD - hU;
      let nx = -dx * rowNormalStrength;
      let ny = -dy * rowNormalStrength;
      let nz = 1.0;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      const nIdx = idx * 4;
      if (normalRgba) {
        normalRgba[nIdx] = Math.round((nx * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 3] = 255;
      }

      const hUL = heightFieldData[row0 + x0];
      const hUR = heightFieldData[row0 + x1];
      const hDL = heightFieldData[row1 + x0];
      const hDR = heightFieldData[row1 + x1];
      const neighborAvg = (hL + hR + hU + hD + hUL + hUR + hDL + hDR) / 8;
      const concavity = Math.max(0, neighborAvg - hC);
      const waterFactor = hC < seaLevelNorm ? 0.55 : 1;
      let ao = 1 - concavity * (2.1 * rowAoStrength) * waterFactor;
      ao = Math.min(1, Math.max(0.6, ao));

      if (aoRgba) {
        const aoByte = Math.round(ao * 255);
        aoRgba[nIdx] = aoByte;
        aoRgba[nIdx + 1] = aoByte;
        aoRgba[nIdx + 2] = aoByte;
        aoRgba[nIdx + 3] = 255;
      }
    }
  }

  if (useWrap) {
    blendSeamColumns(rgba, width, height);
    if (roughnessRgba) {
      blendSeamColumns(roughnessRgba, width, height);
    }
    if (aoRgba) {
      blendSeamColumns(aoRgba, width, height);
    }
    if (normalRgba) {
      blendSeamNormals(normalRgba, width, height);
    }
    if (heightRgba) {
      blendSeamColumns(heightRgba, width, height);
    }
    if (finalEmissiveRgba) {
      blendSeamColumns(finalEmissiveRgba, width, height);
    }
  }

  blendPolarRows(rgba, width, height);
  if (roughnessRgba) {
    blendPolarRows(roughnessRgba, width, height);
  }
  if (aoRgba) {
    blendPolarRows(aoRgba, width, height);
  }
  if (normalRgba) {
    blendPolarRows(normalRgba, width, height);
  }
  if (heightRgba) {
    blendPolarRows(heightRgba, width, height);
  }
  if (finalEmissiveRgba) {
    blendPolarRows(finalEmissiveRgba, width, height);
  }

  return { rgba, normalRgba, aoRgba, roughnessRgba, heightRgba, emissiveRgba: finalEmissiveRgba };
};
self.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const message = event.data;
  const kind = (message as { kind?: string }).kind;

  if (kind === 'bootstrap') {
    const { id, payload } = message as BootstrapWorkerRequestMessage;
    try {
      if (payload.type === 'START_NEW_GAME') {
        const { state } = generateWorld(payload.scenario, {
          onProgress: update => postBootstrapProgress(id, update)
        });
        postBootstrapDone(id, state);
        return;
      }
      if (payload.type === 'LOAD_GAME') {
        const state = deserializeGameState(payload.saveJson, {
          onProgress: update => postBootstrapProgress(id, update)
        });
        postBootstrapDone(id, state);
        return;
      }
      postBootstrapError(id, `Unknown bootstrap payload type: ${(payload as { type?: string }).type}`);
    } catch (error) {
      postBootstrapError(id, error);
    }
    return;
  }

  if (kind === 'surfaceTexture') {
    const { id, payload } = message as SurfaceTextureWorkerRequestMessage;
    try {
      const state = payload.state as GameState;
      const descriptor = getSurfaceDescriptor(state, payload.bodyId);
      const astro = descriptor ? getAstroForBody(state, payload.bodyId, descriptor) : null;
      const map = generateSurfaceMapForState(state, payload.bodyId);
      if (!descriptor || !astro || !map) {
        postResponse({
          kind: 'surfaceTexture',
          id,
          payload: {
            bodyId: payload.bodyId,
            width: payload.resolution.width,
            height: payload.resolution.height,
            rgba: null,
            normalRgba: null,
            aoRgba: null,
            roughnessRgba: null,
            heightRgba: null,
            emissiveRgba: null
          }
        });
        return;
      }

      const useTiles = payload.textureOptions?.source === 'tiles';
      const { rgba, normalRgba, aoRgba, roughnessRgba, heightRgba, emissiveRgba } = useTiles
        ? renderSurfaceTextureFromTiles(map, payload.resolution, payload.cloudShadow ?? null, payload.textureOptions ?? null)
        : renderSurfaceTexture(
          map,
          createTerrainField({
            descriptor,
            planetData: astro.planetData,
            moonData: astro.moonData,
            detailLevel: resolveTerrainDetailLevel(payload.resolution)
          }),
          payload.resolution,
          payload.cloudShadow ?? null,
          payload.textureOptions ?? null
        );
      const transfer: Transferable[] = [rgba.buffer];
      if (normalRgba) transfer.push(normalRgba.buffer);
      if (aoRgba) transfer.push(aoRgba.buffer);
      if (roughnessRgba) transfer.push(roughnessRgba.buffer);
      if (heightRgba) transfer.push(heightRgba.buffer);
      if (emissiveRgba) transfer.push(emissiveRgba.buffer);
      postResponse(
        {
          kind: 'surfaceTexture',
          id,
          payload: {
            bodyId: payload.bodyId,
            width: payload.resolution.width,
            height: payload.resolution.height,
            rgba,
            normalRgba,
            aoRgba,
            roughnessRgba,
            heightRgba,
            emissiveRgba
          }
        },
        transfer
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      postResponse({
        kind: 'surfaceTexture',
        id,
        payload: {
          bodyId: payload.bodyId,
          width: payload.resolution.width,
          height: payload.resolution.height,
          rgba: null,
          normalRgba: null,
          aoRgba: null,
          roughnessRgba: null,
          heightRgba: null,
          emissiveRgba: null,
          error: errorMessage
        }
      });
    }
    return;
  }

  const { id, payload } = message as SurfaceMapWorkerRequestMessage | { id: number; payload: SurfaceMapWorkerRequest };
  try {
    const map = generateSurfaceMapForState(payload.state as GameState, payload.bodyId);
    postResponse({ kind: 'surfaceMap', id, payload: { map } });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    postResponse({ kind: 'surfaceMap', id, payload: { map: null, error: errorMessage } });
  }
};
