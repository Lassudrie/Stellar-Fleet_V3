import { Biome, HexCoord, PlanetSurfaceMap, SurfacePos } from '../../../shared/shared';
import { fnv1a32 } from '../../../engine/planetSurface';

export const HEX_SIZE = 12;
export const MIN_ZOOM = 0.20;
export const MAX_ZOOM = 4.00;
export const TERRAIN_ZOOM_STEP = 0.05;
export const CLICK_DRAG_THRESHOLD_PX = 6;
export const CLICK_DRAG_THRESHOLD_SQ = CLICK_DRAG_THRESHOLD_PX * CLICK_DRAG_THRESHOLD_PX;
export const PAN_MARGIN_PX = 40;
export const CENTER_SLOP_PX = 24; // tolerance to prevent hard snapping when map is smaller than viewport

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const clampAffinity = (v: number | undefined): number => clamp(v ?? 1, 0.7, 1.3);

export const approxRngRange = (r0: number, eps = 0.08): { min: number; max: number } => {
  const min = r0 * ((1 - eps) / (1 + eps));
  const max = r0 * ((1 + eps) / (1 - eps));
  return { min, max };
};

export const sameHex = (a: HexCoord | null, b: HexCoord | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.q === b.q && a.r === b.r;
};

export const wrapQ = (q: number, w: number, wrapX: boolean): number => {
  if (!wrapX) return q;
  const m = q % w;
  return m < 0 ? m + w : m;
};

export const axialToPixel = (q: number, r: number, size: number): { x: number; y: number } => ({
  x: size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
  y: size * (1.5 * r)
});

export const pixelToAxial = (x: number, y: number, size: number): { q: number; r: number } => ({
  q: (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size,
  r: (2 / 3 * y) / size
});

export const roundAxial = ({ q, r }: { q: number; r: number }): HexCoord => {
  let x = q;
  let z = r;
  let y = -x - z;

  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);

  const xDiff = Math.abs(rx - x);
  const yDiff = Math.abs(ry - y);
  const zDiff = Math.abs(rz - z);

  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }

  return { q: rx, r: rz };
};

export const offsetToAxial = (coord: HexCoord): HexCoord => ({
  q: coord.q - Math.floor(coord.r / 2),
  r: coord.r
});

export const axialToOffset = (coord: HexCoord): HexCoord => ({
  q: coord.q + Math.floor(coord.r / 2),
  r: coord.r
});

export const gridToPixel = (coord: HexCoord, size: number): { x: number; y: number } => {
  const axial = offsetToAxial(coord);
  return axialToPixel(axial.q, axial.r, size);
};

export const pixelToGrid = (x: number, y: number, size: number): HexCoord => {
  const axial = roundAxial(pixelToAxial(x, y, size));
  return axialToOffset(axial);
};

export type MapBoundsPx = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
};

export const computeMapBoundsPx = (config: PlanetSurfaceMap['descriptor']['config'], size: number): MapBoundsPx => {
  // Analytical O(1) calculation for odd-r offset hex grid bounds
  // For odd-r offset: q ranges [0, w-1], r ranges [0, h-1]
  // offset-to-axial: q_axial = q - floor(r/2)
  // axial-to-pixel: x = sqrt(3) * size * q_axial + sqrt(3)/2 * size * r, y = 1.5 * size * r
  // Combined: x = sqrt(3) * size * (q - floor(r/2)) + sqrt(3)/2 * size * r
  //          y = 1.5 * size * r
  
  const sqrt3 = Math.sqrt(3);
  const halfW = (sqrt3 / 2) * size;
  const halfH = size;
  
  const w = config.w;
  const h = config.h;
  
  // Top: r=0, y = 0
  // Bottom: r=h-1, y = 1.5 * size * (h-1)
  const minY = -halfH;
  const maxY = 1.5 * size * (h - 1) + halfH;
  
  // Rightmost: q=w-1, r=h-1
  // x = sqrt(3) * size * ((w-1) - floor((h-1)/2)) + sqrt(3)/2 * size * (h-1)
  const rightmostX = sqrt3 * size * ((w - 1) - Math.floor((h - 1) / 2)) + sqrt3 / 2 * size * (h - 1);
  const maxX = rightmostX + halfW;
  
  // Leftmost: q=0, find minimum x over all r
  // For q=0: x = sqrt(3) * size * (-floor(r/2)) + sqrt(3)/2 * size * r
  // For r even: x = sqrt(3) * size * (-r/2) + sqrt(3)/2 * size * r = 0
  // For r odd: x = sqrt(3) * size * (-(r-1)/2) + sqrt(3)/2 * size * r = sqrt(3)/2 * size
  // So leftmost is at x=0 (r=0 or any even r), but we need to account for hex radius
  // Actually, for r=1: x = sqrt(3)/2 * size, which is positive
  // The true leftmost (including hex radius) is at x=0 - halfW = -halfW
  const minX = -halfW;

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
};

export const computeFitZoom = (
  viewport: { width: number; height: number },
  bounds: MapBoundsPx,
  minZoom: number
): number => {
  const pad = 0.94;
  const zx = viewport.width / Math.max(1, bounds.width);
  const zy = viewport.height / Math.max(1, bounds.height);
  const fit = Math.min(zx, zy) * pad;
  // Avoid auto-zooming in above 1 (keeps the feel consistent on large screens).
  return clamp(fit, minZoom, 1);
};

export const quantizeZoom = (zoom: number, step: number, minZoom: number, maxZoom: number): number => {
  const snapped = Math.round(zoom / step) * step;
  return clamp(snapped, minZoom, maxZoom);
};

export const normalizePos = (pos: SurfacePos | undefined, config: PlanetSurfaceMap['descriptor']['config']): HexCoord | null => {
  if (!pos) return null;
  const q = wrapQ(Math.round(pos.q), config.w, config.wrapX);
  const r = Math.round(pos.r);
  if (r < 0 || r >= config.h) return null;
  if (!config.wrapX && (q < 0 || q >= config.w)) return null;
  return { q, r };
};

export const deriveFallbackPos = (entityId: string, config: PlanetSurfaceMap['descriptor']['config']): HexCoord => {
  const hash = fnv1a32(entityId) >>> 0;
  const q = wrapQ(hash % config.w, config.w, config.wrapX);
  const r = Math.floor((hash / config.w) % config.h);
  return { q, r };
};

export const getTileAt = (map: PlanetSurfaceMap, coord: HexCoord) => {
  const { w, h } = map.descriptor.config;
  if (coord.r < 0 || coord.r >= h) return null;
  const q = wrapQ(coord.q, w, map.descriptor.config.wrapX);
  if (!map.descriptor.config.wrapX && (q < 0 || q >= w)) return null;
  const index = coord.r * w + q;
  return map.tiles[index] ?? null;
};

export const surfaceMapKey = (surfaceMap: PlanetSurfaceMap): string => {
  const { descriptor, bodyId } = surfaceMap;
  const { config } = descriptor;
  return [
    bodyId,
    descriptor.seed,
    config.w,
    config.h,
    config.generatorVersion,
    config.wrapX ? 'wrap' : 'nowrap'
  ].join('|');
};

export type TerrainBufferContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type TerrainBuffer = {
  key: string;
  zoom: number;
  dpr: number;
  bounds: MapBoundsPx;
  canvas: OffscreenCanvas | HTMLCanvasElement;
};

export const drawHex = (
  ctx: TerrainBufferContext,
  center: { x: number; y: number },
  size: number,
  options: { fill?: string; stroke?: string; lineWidth?: number }
) => {
  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const angle = Math.PI / 180 * (60 * i - 30);
    const px = center.x + size * Math.cos(angle);
    const py = center.y + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (options.fill) {
    ctx.fillStyle = options.fill;
    ctx.fill();
  }
  if (options.stroke) {
    ctx.strokeStyle = options.stroke;
    if (typeof options.lineWidth === 'number') ctx.lineWidth = options.lineWidth;
    ctx.stroke();
  }
};

export const renderTerrainLayer = (
  mapToRender: PlanetSurfaceMap,
  config: PlanetSurfaceMap['descriptor']['config'],
  zoom: number,
  dpr: number,
  hexSize: number,
  biomePalette: Record<Biome, string>
): TerrainBuffer | null => {
  const bounds = computeMapBoundsPx(config, hexSize);
  const width = Math.max(1, Math.ceil(bounds.width * zoom * dpr));
  const height = Math.max(1, Math.ceil(bounds.height * zoom * dpr));

  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : (() => {
      const el = document.createElement('canvas');
      el.width = width;
      el.height = height;
      return el;
    })();

  const context = canvas.getContext('2d');
  if (!context || !('clearRect' in context)) return null;
  const ctx = context as TerrainBufferContext;

  const gridStroke = 'rgba(148, 163, 184, 0.22)';
  const hex = hexSize * zoom * dpr;

  ctx.clearRect(0, 0, width, height);

  for (let r = 0; r < config.h; r += 1) {
    for (let q = 0; q < config.w; q += 1) {
      const tile = mapToRender.tiles[r * config.w + q];
      if (!tile) continue;
      const { x, y } = gridToPixel({ q, r }, hexSize);
      const center = {
        x: (x - bounds.minX) * zoom * dpr,
        y: (y - bounds.minY) * zoom * dpr
      };
      const color = biomePalette[tile.biome] ?? '#334155';
      drawHex(ctx, center, hex, { fill: color, stroke: gridStroke, lineWidth: 0.75 * dpr });
    }
  }

  return {
    key: surfaceMapKey(mapToRender),
    zoom,
    dpr,
    bounds,
    canvas
  };
};
