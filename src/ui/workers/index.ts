import {
  createTerrainField,
  generateSurfaceMapForState,
  getAstroForBody,
  getSurfaceDescriptor,
  surfaceDirFromUv
} from '../../engine/planetSurface';
import { generateWorld } from '../../engine/worldgen/worldGenerator';
import { deserializeGameState } from '../../engine/serialization';
import { getPlanetById } from '../../engine/planets';
import type { GameScenario } from '../../content/scenarios';
import type { Biome, GameState, PlanetSurfaceMap, StarSystem } from '../../shared/shared';
import { FeatureBits } from '../../shared/shared';
import type {
  SurfaceMapWorkerRequest,
  SurfaceMapWorkerResponseMessage,
  SurfaceTextureResolution,
  SurfaceTextureWorkerRequest,
  SurfaceTextureWorkerResponseMessage,
  BootstrapWorkerResponseMessage,
  BootstrapWorkerRequestPayload,
  BootstrapProgressDetail
} from './surfaceMapWorker';

export type { CloudShadowSettings, SurfaceTextureOptions } from './surfaceMapWorker';

const canUseWorker = typeof window !== 'undefined' && typeof Worker !== 'undefined';

type TerrainDetailLevel = 'full' | 'medium' | 'low';

const resolveTerrainDetailLevel = (resolution: SurfaceTextureResolution): TerrainDetailLevel => {
  if (resolution.width <= 256) return 'low';
  if (resolution.width <= 512) return 'medium';
  return 'full';
};

type PendingRequest = {
  kind: 'surfaceMap';
  resolve: (map: PlanetSurfaceMap | null) => void;
  reject: (error: Error) => void;
};

export type SurfaceTextureResult = {
  width: number;
  height: number;
  rgba: Uint8Array;
  normalRgba: Uint8Array | null;
  aoRgba: Uint8Array | null;
  roughnessRgba: Uint8Array | null;
  heightRgba: Uint8Array | null;
  emissiveRgba: Uint8Array | null;
};

type PendingTextureRequest = {
  kind: 'surfaceTexture';
  resolve: (result: SurfaceTextureResult | null) => void;
  reject: (error: Error) => void;
};

export type BootstrapProgressUpdate = {
  stage: 'worldgen' | 'deserialize';
  progress: number;
  detail?: BootstrapProgressDetail;
};

type PendingBootstrapRequest = {
  resolve: (state: GameState) => void;
  reject: (error: Error) => void;
  onProgress?: (update: BootstrapProgressUpdate) => void;
};

export class SurfaceMapWorkerClient {
  private worker: Worker | null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest | PendingTextureRequest>();

  constructor() {
    if (!canUseWorker) {
      this.worker = null;
      return;
    }

    try {
      this.worker = new Worker(new URL('./surfaceMapWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = this.handleMessage;
      this.worker.onerror = this.handleError;
    } catch (error) {
      console.warn('[SurfaceMapWorkerClient] Worker instantiation failed, falling back to sync path', error);
      this.worker = null;
    }
  }

  requestSurfaceMap(request: SurfaceMapWorkerRequest): Promise<PlanetSurfaceMap | null> {
    if (!this.worker) {
      return Promise.resolve(this.generateSync(request));
    }

    const id = this.nextRequestId++;
    return new Promise<PlanetSurfaceMap | null>((resolve, reject) => {
      this.pending.set(id, { kind: 'surfaceMap', resolve, reject });
      this.worker?.postMessage({ kind: 'surfaceMap', id, payload: request });
    });
  }

  requestSurfaceTexture(
    request: SurfaceMapWorkerRequest,
    resolution: SurfaceTextureResolution
  ): Promise<SurfaceTextureResult | null> {
    if (!this.worker) {
      if (request.allowSync === false) {
        return Promise.resolve(null);
      }
      return Promise.resolve(this.generateTextureSync(request, resolution));
    }

    const id = this.nextRequestId++;
    const payload: SurfaceTextureWorkerRequest = { ...request, resolution };

    return new Promise<SurfaceTextureResult | null>((resolve, reject) => {
      this.pending.set(id, { kind: 'surfaceTexture', resolve, reject });
      this.worker?.postMessage({ kind: 'surfaceTexture', id, payload });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(entry => entry.reject(new Error('Worker disposed')));
    this.pending.clear();
  }

  private generateSync(request: SurfaceMapWorkerRequest): PlanetSurfaceMap | null {
    return generateSurfaceMapForState(request.state as GameState, request.bodyId);
  }

  private handleMessage = (event: MessageEvent<SurfaceMapWorkerResponseMessage | SurfaceTextureWorkerResponseMessage | BootstrapWorkerResponseMessage>) => {
    const data = event.data;
    if ((data as { kind?: string }).kind && data.kind !== 'surfaceMap' && data.kind !== 'surfaceTexture') return;
    const { id } = data as SurfaceMapWorkerResponseMessage | SurfaceTextureWorkerResponseMessage;
    const pendingRequest = this.pending.get(id);
    if (!pendingRequest) return;
    this.pending.delete(id);

    if (data.kind === 'surfaceMap') {
      const { payload } = data as SurfaceMapWorkerResponseMessage;
      if (pendingRequest.kind !== 'surfaceMap') return;
      if (payload.error) {
        pendingRequest.reject(new Error(payload.error));
        return;
      }
      pendingRequest.resolve(payload.map);
      return;
    }

    if (data.kind === 'surfaceTexture') {
      const { payload } = data as SurfaceTextureWorkerResponseMessage;
      if (pendingRequest.kind !== 'surfaceTexture') return;
      if (payload.error) {
        pendingRequest.reject(new Error(payload.error));
        return;
      }
      if (!payload.rgba) {
        pendingRequest.resolve(null);
        return;
      }
      pendingRequest.resolve({
        width: payload.width,
        height: payload.height,
        rgba: payload.rgba,
        normalRgba: payload.normalRgba ?? null,
        aoRgba: payload.aoRgba ?? null,
        roughnessRgba: payload.roughnessRgba ?? null,
        heightRgba: payload.heightRgba ?? null,
        emissiveRgba: payload.emissiveRgba ?? null
      });
    }
  };

  private handleError = (event: ErrorEvent) => {
    const error = new Error(event.message || 'Worker error');
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(entry => entry.reject(error));
    this.pending.clear();
  };

  private generateTextureSync(request: SurfaceMapWorkerRequest, resolution: SurfaceTextureResolution): SurfaceTextureResult | null {
    const state = request.state as GameState;
    const descriptor = getSurfaceDescriptor(state, request.bodyId);
    const astro = descriptor ? getAstroForBody(state, request.bodyId, descriptor) : null;
    const map = generateSurfaceMapForState(state, request.bodyId);
    if (!descriptor || !astro || !map) return null;

    const { w, h, wrapX } = map.descriptor.config;
    const width = Math.max(1, Math.floor(resolution.width));
    const height = Math.max(1, Math.floor(resolution.height));
    const includeNormalMap = request.textureOptions?.includeNormalMap ?? true;
    const includeAoMap = request.textureOptions?.includeAoMap ?? true;
    const includeRoughnessMap = request.textureOptions?.includeRoughnessMap ?? true;
    const includeHeightMap = request.textureOptions?.includeHeightMap ?? false;
    const includeEmissiveMap = request.textureOptions?.includeEmissiveMap ?? false;
    const textureSource = request.textureOptions?.source ?? 'field';
    const roughnessRgba = includeRoughnessMap ? new Uint8Array(width * height * 4) : null;
    const heightRgba = includeHeightMap ? new Uint8Array(width * height * 4) : null;
    const emissiveRgba = includeEmissiveMap ? new Uint8Array(width * height * 4) : null;
    const heightField = (includeNormalMap || includeAoMap || includeHeightMap) ? new Float32Array(width * height) : null;

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
    const smoothstep = (edge0: number, edge1: number, x: number): number => {
      if (edge0 === edge1) return x < edge0 ? 0 : 1;
      const t = clamp01((x - edge0) / (edge1 - edge0));
      return t * t * (3 - 2 * t);
    };
    const hexToRgb8 = (hex: string): { r: number; g: number; b: number } => {
      const raw = hex.startsWith('#') ? hex.slice(1) : hex;
      const int = Number.parseInt(raw, 16);
      return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
    };
    const srgbToLinear = (s: number): number => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
    const linearToSrgb = (l: number): number => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
    const linearToSrgbByte = (l: number): number => Math.round(clamp01(linearToSrgb(Math.max(0, l))) * 255);

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

    const biomeLinearRgb = (() => {
      const out: Record<Biome, [number, number, number]> = {} as Record<Biome, [number, number, number]>;
      (Object.keys(biomeColors) as Biome[]).forEach((biome) => {
        const { r, g, b } = hexToRgb8(biomeColors[biome]);
        out[biome] = [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
      });
      return out;
    })();

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

    const hash2 = (x: number, y: number, hashSeed: number): number => {
      const xi = x | 0;
      const yi = y | 0;
      let h = hashSeed >>> 0;
      h ^= Math.imul(xi, 0x9e3779b1);
      h ^= Math.imul(yi, 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
      h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967295;
    };

    const createSeededRandom = (randomSeed: number): (() => number) => {
      let state = randomSeed >>> 0;
      return () => {
        state += 0x6d2b79f5;
        let result = Math.imul(state ^ (state >>> 15), 1 | state);
        result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
        return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
      };
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

    const buildSettlementField = (
      map: PlanetSurfaceMap,
      width: number,
      height: number
    ): Float32Array | null => {
      if (!map.settlements.length) return null;
      const { w, h, wrapX } = map.descriptor.config;
      const field = new Float32Array(width * height);
      const seedBase = map.descriptor.seed >>> 0;

      map.settlements.forEach((settlement, index) => {
        const coord = settlement.coord;
        const seed = Math.floor(hash2(coord.q + index * 17, coord.r, seedBase) * 0xffffffff);
        const rand = createSeededRandom(seed);
        const u = (coord.q + 0.5) / w;
        const v = (coord.r + 0.5) / h;
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

    const useWrap = Boolean(wrapX);
    const cloudShadowConfig = request.cloudShadow && request.cloudShadow.strength > 0 ? request.cloudShadow : null;
    const cloudNoiseScaleX = cloudShadowConfig ? Math.max(2, Math.round(cloudShadowConfig.noiseScale)) : 0;
    const cloudNoiseScaleY = cloudShadowConfig ? Math.max(1, Math.round(cloudNoiseScaleX * 0.6)) : 0;
    const settlementField = includeEmissiveMap ? buildSettlementField(map, width, height) : null;
    let hasEmissive = false;
    const cityMask = FeatureBits.City | FeatureBits.Capital;

    if (textureSource === 'tiles') {
      const rgba = new Uint8Array(width * height * 4);
      const seaLevel = map.seaLevelElev * 0.001;

      let heightMin = 0;
      let heightMax = 0;
      if (heightField) {
        heightMin = Number.POSITIVE_INFINITY;
        heightMax = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < map.tiles.length; i += 1) {
          const elev = (map.tiles[i]?.elev ?? 0) * 0.001;
          heightMin = Math.min(heightMin, elev);
          heightMax = Math.max(heightMax, elev);
        }
        if (!Number.isFinite(heightMin) || !Number.isFinite(heightMax)) {
          heightMin = 0;
          heightMax = 0;
        }
      }

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
          const tile = map.tiles[rIndex * w + qIndex];
          const baseColor = biomeLinearRgb[tile?.biome ?? 'rocky'];
          let rLin = baseColor[0];
          let gLin = baseColor[1];
          let bLin = baseColor[2];

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

          const landWeight = isWaterBiome(tile?.biome ?? 'ocean') ? 0 : 1;
          const waterWeight = 1 - landWeight;

          if (roughnessRgba) {
            const roughness = clamp01(biomeRoughness(tile?.biome ?? 'rocky'));
            const roughByte = Math.round(roughness * 255);
            roughnessRgba[idx] = roughByte;
            roughnessRgba[idx + 1] = roughByte;
            roughnessRgba[idx + 2] = roughByte;
            roughnessRgba[idx + 3] = Math.round(clamp01(waterWeight) * 255);
          }

          if (heightField) {
            heightField[pixelIndex] = (tile?.elev ?? 0) * 0.001;
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

            const t00 = map.tiles[r0 * w + q0];
            const t10 = map.tiles[r0 * w + q1];
            const t01 = map.tiles[r1 * w + q0];
            const t11 = map.tiles[r1 * w + q1];
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
        return {
          width,
          height,
          rgba,
          normalRgba: null,
          aoRgba: null,
          roughnessRgba,
          heightRgba,
          emissiveRgba: finalEmissiveRgba
        };
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

      return {
        width,
        height,
        rgba,
        normalRgba,
        aoRgba,
        roughnessRgba,
        heightRgba,
        emissiveRgba: finalEmissiveRgba
      };
    }

    const terrain = createTerrainField({
      descriptor,
      planetData: astro.planetData,
      moonData: astro.moonData,
      detailLevel: resolveTerrainDetailLevel(resolution)
    });
    const coastColor = biomeLinearRgb.coast;
    const seaLevel = terrain.seaLevelElev;

    let heightMin = Number.POSITIVE_INFINITY;
    let heightMax = Number.NEGATIVE_INFINITY;

    const rgba = new Uint8Array(width * height * 4);

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
        const shoreMix = sample.coast * (sample.isWater ? 0.65 : 0.35);
        let rLin = lerp(baseColor[0], coastColor[0], shoreMix);
        let gLin = lerp(baseColor[1], coastColor[1], shoreMix);
        let bLin = lerp(baseColor[2], coastColor[2], shoreMix);

        const landWeight = sample.isWater ? 0 : 1;
        const waterWeight = 1 - landWeight;
        const tempNorm = clamp01((sample.tempC + 50) / 100);
        const moistNorm = clamp01(sample.moist);
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
          const baseRough = biomeRoughness(sample.biome);
          const dryness = clamp01(1 - moistNorm);
          let landRoughness = baseRough + (sample.relief - 0.5) * 0.18 * detailFactor + dryness * 0.08;
          landRoughness += sample.detail * 0.04 * detailFactor;
          landRoughness = clamp01(landRoughness);
          const waterRoughness = clamp01(0.04 + shallow * 0.06 + sample.detail * 0.02);
          const coastBlend = sample.coast * 0.6;
          let roughness = lerp(landRoughness, waterRoughness, sample.isWater ? 1 - coastBlend : coastBlend);
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
          heightField[pixelIndex] = sample.height;
          if (sample.height < heightMin) heightMin = sample.height;
          if (sample.height > heightMax) heightMax = sample.height;
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

          const t00 = map.tiles[r0 * w + q0];
          const t10 = map.tiles[r0 * w + q1];
          const t01 = map.tiles[r1 * w + q0];
          const t11 = map.tiles[r1 * w + q1];
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
      return {
        width,
        height,
        rgba,
        normalRgba: null,
        aoRgba: null,
        roughnessRgba,
        heightRgba,
        emissiveRgba: finalEmissiveRgba
      };
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

    return {
      width,
      height,
      rgba,
      normalRgba,
      aoRgba,
      roughnessRgba,
      heightRgba,
      emissiveRgba: finalEmissiveRgba
    };
  }

}

export class BootstrapWorkerClient {
  private worker: Worker | null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingBootstrapRequest>();

  constructor() {
    if (!canUseWorker) {
      this.worker = null;
      return;
    }

    try {
      this.worker = new Worker(new URL('./surfaceMapWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = this.handleMessage;
      this.worker.onerror = this.handleError;
    } catch (error) {
      console.warn('[BootstrapWorkerClient] Worker instantiation failed, falling back to sync path', error);
      this.worker = null;
    }
  }

  startNewGame(scenario: GameScenario, onProgress?: (update: BootstrapProgressUpdate) => void): Promise<GameState> {
    if (!this.worker) {
      return Promise.resolve(this.generateNewGameSync(scenario, onProgress));
    }

    const id = this.nextRequestId++;
    const payload: BootstrapWorkerRequestPayload = { type: 'START_NEW_GAME', scenario };
    return new Promise<GameState>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker?.postMessage({ kind: 'bootstrap', id, payload });
    });
  }

  loadGame(saveJson: string, onProgress?: (update: BootstrapProgressUpdate) => void): Promise<GameState> {
    if (!this.worker) {
      return Promise.resolve(this.loadGameSync(saveJson, onProgress));
    }

    const id = this.nextRequestId++;
    const payload: BootstrapWorkerRequestPayload = { type: 'LOAD_GAME', saveJson };
    return new Promise<GameState>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker?.postMessage({ kind: 'bootstrap', id, payload });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(entry => entry.reject(new Error('Worker disposed')));
    this.pending.clear();
  }

  private generateNewGameSync(scenario: GameScenario, onProgress?: (update: BootstrapProgressUpdate) => void): GameState {
    return generateWorld(scenario, { onProgress: update => onProgress?.(update) }).state;
  }

  private loadGameSync(saveJson: string, onProgress?: (update: BootstrapProgressUpdate) => void): GameState {
    return deserializeGameState(saveJson, { onProgress: update => onProgress?.(update) });
  }

  private handleMessage = (event: MessageEvent<BootstrapWorkerResponseMessage | SurfaceMapWorkerResponseMessage>) => {
    if (event.data.kind !== 'bootstrap') return;
    const { id, payload } = event.data;
    const pendingRequest = this.pending.get(id);
    if (!pendingRequest) return;

    if (payload.type === 'progress') {
      pendingRequest.onProgress?.({ stage: payload.stage, progress: payload.progress, detail: payload.detail });
      return;
    }

    this.pending.delete(id);

    if (payload.type === 'done') {
      pendingRequest.resolve(payload.state);
      return;
    }

    pendingRequest.reject(new Error(payload.message));
  };

  private handleError = (event: ErrorEvent) => {
    const error = new Error(event.message || 'Worker error');
    this.worker?.terminate();
    this.worker = null;
    this.pending.forEach(entry => entry.reject(error));
    this.pending.clear();
  };
}

export const buildSurfaceMapWorkerRequest = (
  state: GameState,
  bodyId: string,
  bodyMeta?: SurfaceMapWorkerRequest['bodyMeta']
): SurfaceMapWorkerRequest | null => {
  const descriptor = getSurfaceDescriptor(state, bodyId);
  if (!descriptor) return null;

  const match = getPlanetById(state.systems, bodyId);
  if (!match) return null;

  const astro = getAstroForBody(state, bodyId, descriptor);
  if (!astro) return null;

  const scopedSystem: StarSystem = {
    ...match.system,
    planets: match.system.planets.map(planet => (planet.id === bodyId ? { ...planet, ownerFactionId: astro.ownerFactionId ?? planet.ownerFactionId } : planet))
  };

  const scopedDescriptors: GameState['planetSurfaceDescriptorsByBodyId'] = {
    [bodyId]: descriptor
  };

  return {
    bodyId,
    state: {
      planetSurfaceDescriptorsByBodyId: scopedDescriptors,
      systems: [scopedSystem]
    },
    bodyMeta
  };
};
