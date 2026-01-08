import { generateSurfaceMapForState, getAstroForBody, getSurfaceDescriptor } from '../../engine/planetSurface';
import { generateWorld } from '../../engine/worldgen/worldGenerator';
import { deserializeGameState } from '../../engine/serialization';
import { getPlanetById } from '../../engine/planets';
import type { GameScenario } from '../../content/scenarios';
import type { Biome, GameState, PlanetSurfaceMap, StarSystem } from '../../shared/shared';
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

const canUseWorker = typeof window !== 'undefined' && typeof Worker !== 'undefined';

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
        aoRgba: payload.aoRgba ?? null
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
    const map = generateSurfaceMapForState(request.state as GameState, request.bodyId);
    if (!map) return null;

    const { w, h, wrapX } = map.descriptor.config;
    const seed = map.descriptor.seed >>> 0;
    const width = Math.max(1, Math.floor(resolution.width));
    const height = Math.max(1, Math.floor(resolution.height));
    const heightField = new Float32Array(width * height);

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
    const hexToRgb8 = (hex: string): { r: number; g: number; b: number } => {
      const raw = hex.startsWith('#') ? hex.slice(1) : hex;
      const int = Number.parseInt(raw, 16);
      return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
    };
    const srgbToLinear = (s: number): number => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));
    const linearToSrgb = (l: number): number => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);

    const biomeLinearRgb = (() => {
      const out: Record<Biome, [number, number, number]> = {} as Record<Biome, [number, number, number]>;
      (Object.keys(biomeColors) as Biome[]).forEach((biome) => {
        const { r, g, b } = hexToRgb8(biomeColors[biome]);
        out[biome] = [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
      });
      return out;
    })();

    let elevMin = Number.POSITIVE_INFINITY;
    let elevMax = Number.NEGATIVE_INFINITY;
    for (const tile of map.tiles) {
      elevMin = Math.min(elevMin, tile.elev);
      elevMax = Math.max(elevMax, tile.elev);
    }
    if (!Number.isFinite(elevMin) || !Number.isFinite(elevMax)) {
      elevMin = 0;
      elevMax = 0;
    }
    const elevRange = Math.max(1, elevMax - elevMin);
    const seaLevel = map.seaLevelElev;
    const invElevRange = 1 / elevRange;
    const seaLevelNorm = (seaLevel - elevMin) * invElevRange;

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

    const valueNoise2D = (x: number, y: number, noiseSeed: number, wrapPeriodX?: number): number => {
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const xf = x - x0;
      const yf = y - y0;
      const sx = xf * xf * (3 - 2 * xf);
      const sy = yf * yf * (3 - 2 * yf);
      const xi0 = typeof wrapPeriodX === 'number' ? wrapIndex(x0, wrapPeriodX) : x0;
      const xi1 = typeof wrapPeriodX === 'number' ? wrapIndex(x0 + 1, wrapPeriodX) : x0 + 1;
      const n00 = hash2(xi0, y0, noiseSeed);
      const n10 = hash2(xi1, y0, noiseSeed);
      const n01 = hash2(xi0, y0 + 1, noiseSeed);
      const n11 = hash2(xi1, y0 + 1, noiseSeed);
      const nx0 = lerp(n00, n10, sx);
      const nx1 = lerp(n01, n11, sx);
      return lerp(nx0, nx1, sy);
    };

    const isWaterBiome = (biome: Biome): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';

    const biomeNoiseAmplitude = (biome: Biome): { macro: number; micro: number } => {
      switch (biome) {
        case 'ocean':
        case 'lake':
          return { macro: 0.06, micro: 0.018 };
        case 'coast':
          return { macro: 0.07, micro: 0.024 };
        case 'ice':
        case 'fractured_ice':
        case 'dusty_ice':
        case 'cryovolcanic':
          return { macro: 0.06, micro: 0.02 };
        case 'taiga':
        case 'grassland':
        case 'forest':
        case 'rainforest':
        case 'tundra':
          return { macro: 0.08, micro: 0.03 };
        case 'desert':
        case 'ash_desert':
        case 'thermal_polygons':
          return { macro: 0.09, micro: 0.034 };
        case 'lava_flats':
        case 'volcanic':
        case 'vitrified':
          return { macro: 0.08, micro: 0.028 };
        default:
          return { macro: 0.075, micro: 0.028 };
      }
    };

    const rgba = new Uint8Array(width * height * 4);
    const useWrap = Boolean(wrapX);
    const macroNoiseScaleX = 12;
    const macroNoiseScaleY = 6;
    const microNoiseScaleX = 96;
    const microNoiseScaleY = 48;

    for (let y = 0; y < height; y += 1) {
      const v = (y + 0.5) / height;
      const rFloat = v * (h - 1);
      const r0 = Math.max(0, Math.min(h - 1, Math.floor(rFloat)));
      const r1 = Math.min(r0 + 1, h - 1);
      const rFrac = rFloat - r0;
      const wR0 = 1 - rFrac;
      const wR1 = rFrac;

      for (let x = 0; x < width; x += 1) {
        const u = (x + 0.5) / width;

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

        const c00 = biomeLinearRgb[t00.biome];
        const c10 = biomeLinearRgb[t10.biome];
        const c01 = biomeLinearRgb[t01.biome];
        const c11 = biomeLinearRgb[t11.biome];

        const w00 = wQ0 * wR0;
        const w10 = wQ1 * wR0;
        const w01 = wQ0 * wR1;
        const w11 = wQ1 * wR1;

        let rLin = c00[0] * w00 + c10[0] * w10 + c01[0] * w01 + c11[0] * w11;
        let gLin = c00[1] * w00 + c10[1] * w10 + c01[1] * w01 + c11[1] * w11;
        let bLin = c00[2] * w00 + c10[2] * w10 + c01[2] * w01 + c11[2] * w11;

        const e00 = t00.elev;
        const e10 = t10.elev;
        const e01 = t01.elev;
        const e11 = t11.elev;
        const elev = e00 * w00 + e10 * w10 + e01 * w01 + e11 * w11;
        const heightNorm = (elev - elevMin) * invElevRange;

        const dElevDq = (e10 - e00) * wR0 + (e11 - e01) * wR1;
        const dElevDr = (e01 - e00) * wQ0 + (e11 - e10) * wQ1;
        const slopeNorm = Math.sqrt(dElevDq * dElevDq + dElevDr * dElevDr) / elevRange;

        const slopeShade = Math.max(0.82, 1 - slopeNorm * 1.35);
        const altNorm = (elev - seaLevel) / elevRange;
        const altShade = 1 + Math.max(-0.06, Math.min(0.09, altNorm * 0.12));
        const shade = slopeShade * altShade;

        const amp00 = biomeNoiseAmplitude(t00.biome);
        const amp10 = biomeNoiseAmplitude(t10.biome);
        const amp01 = biomeNoiseAmplitude(t01.biome);
        const amp11 = biomeNoiseAmplitude(t11.biome);
        const macroAmp = amp00.macro * w00 + amp10.macro * w10 + amp01.macro * w01 + amp11.macro * w11;
        const microAmp = amp00.micro * w00 + amp10.micro * w10 + amp01.micro * w01 + amp11.micro * w11;

        const macroNoise = valueNoise2D(u * macroNoiseScaleX, v * macroNoiseScaleY, seed + 1013, useWrap ? macroNoiseScaleX : undefined);
        const microNoise = valueNoise2D(u * microNoiseScaleX, v * microNoiseScaleY, seed + 2017, useWrap ? microNoiseScaleX : undefined);
        const noiseShade = Math.min(1.18, Math.max(0.86, 1 + (macroNoise - 0.5) * macroAmp + (microNoise - 0.5) * microAmp));

        const moist = t00.moist * w00 + t10.moist * w10 + t01.moist * w01 + t11.moist * w11;
        const tempC2 = t00.tempC2 * w00 + t10.tempC2 * w10 + t01.tempC2 * w01 + t11.tempC2 * w11;
        const moistNorm = clamp01(moist / 255);
        const tempC = tempC2 * 0.5;
        const tempNorm = clamp01((tempC + 50) / 100);

        const waterWeight = (isWaterBiome(t00.biome) ? w00 : 0)
          + (isWaterBiome(t10.biome) ? w10 : 0)
          + (isWaterBiome(t01.biome) ? w01 : 0)
          + (isWaterBiome(t11.biome) ? w11 : 0);
        const landWeight = 1 - waterWeight;
        const climateShade = 1 + landWeight * ((moistNorm - 0.5) * 0.05 + (tempNorm - 0.5) * 0.03);

        const waterDepth = clamp01((seaLevel - elev) / elevRange);
        const shallow = 1 - clamp01(waterDepth * 2.4);
        const waterShade = 1 + waterWeight * (shallow * 0.08 - waterDepth * 0.22);

        rLin *= shade;
        gLin *= shade;
        bLin *= shade;

        rLin *= noiseShade * climateShade * waterShade;
        gLin *= noiseShade * climateShade * waterShade;
        bLin *= noiseShade * climateShade * waterShade;

        const rr = Math.round(clamp01(linearToSrgb(Math.max(0, rLin))) * 255);
        const gg = Math.round(clamp01(linearToSrgb(Math.max(0, gLin))) * 255);
        const bb = Math.round(clamp01(linearToSrgb(Math.max(0, bLin))) * 255);

        const idx = (y * width + x) * 4;
        rgba[idx] = rr;
        rgba[idx + 1] = gg;
        rgba[idx + 2] = bb;
        rgba[idx + 3] = 255;
        heightField[y * width + x] = heightNorm;
      }
    }

    const shouldComputeRelief = width >= 256 && height >= 128;
    if (!shouldComputeRelief) {
      return { width, height, rgba, normalRgba: null, aoRgba: null };
    }

    const normalRgba = new Uint8Array(width * height * 4);
    const aoRgba = new Uint8Array(width * height * 4);
    const heightScale = Math.min(1.6, Math.max(0.55, elevRange / 1200));
    const normalStrength = 1.1 * heightScale;
    const aoStrength = 1.5 * heightScale;

    for (let y = 0; y < height; y += 1) {
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < height - 1 ? y + 1 : height - 1;
      const row = y * width;
      const row0 = y0 * width;
      const row1 = y1 * width;

      for (let x = 0; x < width; x += 1) {
        const x0 = useWrap ? (x === 0 ? width - 1 : x - 1) : Math.max(0, x - 1);
        const x1 = useWrap ? (x === width - 1 ? 0 : x + 1) : Math.min(width - 1, x + 1);

        const idx = row + x;
        const hC = heightField[idx];
        const hL = heightField[row + x0];
        const hR = heightField[row + x1];
        const hU = heightField[row0 + x];
        const hD = heightField[row1 + x];

        const dx = hR - hL;
        const dy = hD - hU;
        let nx = -dx * normalStrength;
        let ny = -dy * normalStrength;
        let nz = 1.0;
        const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= invLen;
        ny *= invLen;
        nz *= invLen;

        const nIdx = idx * 4;
        normalRgba[nIdx] = Math.round((nx * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
        normalRgba[nIdx + 3] = 255;

        const hUL = heightField[row0 + x0];
        const hUR = heightField[row0 + x1];
        const hDL = heightField[row1 + x0];
        const hDR = heightField[row1 + x1];
        const neighborAvg = (hL + hR + hU + hD + hUL + hUR + hDL + hDR) / 8;
        const concavity = Math.max(0, neighborAvg - hC);
        const waterFactor = hC < seaLevelNorm ? 0.55 : 1;
        let ao = 1 - concavity * (2.1 * aoStrength) * waterFactor;
        ao = Math.min(1, Math.max(0.6, ao));

        const aoByte = Math.round(ao * 255);
        aoRgba[nIdx] = aoByte;
        aoRgba[nIdx + 1] = aoByte;
        aoRgba[nIdx + 2] = aoByte;
        aoRgba[nIdx + 3] = 255;
      }
    }

    return { width, height, rgba, normalRgba, aoRgba };
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
  bodyId: string
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
    }
  };
};
