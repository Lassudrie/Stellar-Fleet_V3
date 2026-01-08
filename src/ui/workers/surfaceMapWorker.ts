import { generateSurfaceMapForState } from '../../engine/planetSurface';
import { generateWorld } from '../../engine/worldgen/worldGenerator';
import { deserializeGameState } from '../../engine/serialization';
import type { GameScenario } from '../../content/scenarios';
import type { Biome, GameState, PlanetSurfaceMap, PlanetSurfaceTile } from '../../shared/shared';

export interface SurfaceMapWorkerState {
  planetSurfaceDescriptorsByBodyId: GameState['planetSurfaceDescriptorsByBodyId'];
  systems: GameState['systems'];
}

export interface SurfaceMapWorkerRequest {
  bodyId: string;
  state: SurfaceMapWorkerState;
}

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

const biomeLinearRgb = (() => {
  const out: Record<Biome, [number, number, number]> = {} as Record<Biome, [number, number, number]>;
  (Object.keys(biomeColors) as Biome[]).forEach((biome) => {
    const { r, g, b } = hexToRgb8(biomeColors[biome]);
    out[biome] = [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
  });
  return out;
})();

const computeElevRange = (tiles: PlanetSurfaceTile[]): { min: number; max: number } => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const tile of tiles) {
    min = Math.min(min, tile.elev);
    max = Math.max(max, tile.elev);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
  return { min, max };
};

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

const getTile = (tiles: PlanetSurfaceTile[], w: number, q: number, r: number): PlanetSurfaceTile => {
  return tiles[r * w + q];
};

const renderSurfaceTexture = (map: PlanetSurfaceMap, resolution: SurfaceTextureResolution): Uint8Array => {
  const { w, h, wrapX } = map.descriptor.config;
  const seed = map.descriptor.seed >>> 0;
  const width = Math.max(1, Math.floor(resolution.width));
  const height = Math.max(1, Math.floor(resolution.height));
  const rgba = new Uint8Array(width * height * 4);

  const { min: elevMin, max: elevMax } = computeElevRange(map.tiles);
  const elevRange = Math.max(1, elevMax - elevMin);
  const seaLevel = map.seaLevelElev;

  const useWrap = Boolean(wrapX);
  const macroNoiseScaleX = 12;
  const macroNoiseScaleY = 6;
  const microNoiseScaleX = 96;
  const microNoiseScaleY = 48;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height; // 0..1
    const rFloat = v * (h - 1);
    const r0 = Math.max(0, Math.min(h - 1, Math.floor(rFloat)));
    const r1 = Math.min(r0 + 1, h - 1);
    const rFrac = rFloat - r0;
    const wR0 = 1 - rFrac;
    const wR1 = rFrac;

    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width; // 0..1

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

      // Local slope magnitude (normalized) for subtle relief shading (direction-independent).
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
    }
  }

  return rgba;
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
      const map = generateSurfaceMapForState(payload.state as GameState, payload.bodyId);
      if (!map) {
        postResponse({
          kind: 'surfaceTexture',
          id,
          payload: { bodyId: payload.bodyId, width: payload.resolution.width, height: payload.resolution.height, rgba: null }
        });
        return;
      }

      const rgba = renderSurfaceTexture(map, payload.resolution);
      postResponse(
        {
          kind: 'surfaceTexture',
          id,
          payload: { bodyId: payload.bodyId, width: payload.resolution.width, height: payload.resolution.height, rgba }
        },
        [rgba.buffer]
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      postResponse({
        kind: 'surfaceTexture',
        id,
        payload: { bodyId: payload.bodyId, width: payload.resolution.width, height: payload.resolution.height, rgba: null, error: errorMessage }
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
