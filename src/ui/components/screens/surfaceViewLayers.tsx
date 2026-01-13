import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Shape,
  ShapeGeometry
} from 'three';
import { Biome, HexCoord, PlanetSurfaceMap, Settlement, SettlementType } from '../../../shared/shared';
import { isPassable } from '../../../engine/planetSurface';
import { clamp, drawHex, gridToPixel, gridToProjectionPixel, HEX_SIZE, PROJECTION_CELL_SIZE, SurfaceMapMode } from './surfaceViewCore';

export type CameraState = { zoom: number; offset: { x: number; y: number } };

type FactionLike = { color?: string | null } | null | undefined;

type FactionMarker = {
  coord: HexCoord;
  faction?: FactionLike;
};

export type SurfaceOverlayData = {
  map: PlanetSurfaceMap;
  activeMapConfig: PlanetSurfaceMap['descriptor']['config'];
  mapMode: SurfaceMapMode;
  camera: CameraState;
  viewport: { width: number; height: number };
  renderDpr: number;
  hovered: HexCoord | null;
  selected: HexCoord | null;
  selectedArmyCoord: HexCoord | null;
  movePreviewPath: HexCoord[] | null;
  reachableCosts: Map<string, number> | null;
  armyMarkers: FactionMarker[];
  buildingMarkers: FactionMarker[];
  landingMarkers: FactionMarker[];
  settlements: Array<Settlement & { coord: HexCoord }>;
  showLabels: boolean;
};

const OTAN_SYMBOL_COLOR = '#0f172a';

type UseMemoDisposableDeps = React.DependencyList;

const useDisposableMemo = <T extends { dispose: () => void }>(factory: () => T, deps: UseMemoDisposableDeps): T => {
  const resource = useMemo(factory, deps);
  useEffect(() => {
    return () => {
      resource.dispose();
    };
  }, [resource]);
  return resource;
};

const hexToRgba = (hex: string, alpha: number): string => {
  const raw = hex.trim();
  if (!raw.startsWith('#')) return `rgba(15, 23, 42, ${alpha})`;
  const value = raw.slice(1);
  if (value.length === 3) {
    const r = parseInt(value[0] + value[0], 16);
    const g = parseInt(value[1] + value[1], 16);
    const b = parseInt(value[2] + value[2], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (value.length === 6) {
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return `rgba(15, 23, 42, ${alpha})`;
};

const drawOtanInfantry = (
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  hexSize: number,
  frameColor: string,
  showSymbol: boolean,
  showEchelon: boolean
) => {
  const frameW = clamp(hexSize * 1.25, 10, 22);
  const frameH = frameW * 0.68;
  const left = center.x - frameW / 2;
  const top = center.y - frameH / 2;
  const right = center.x + frameW / 2;
  const bottom = center.y + frameH / 2;
  const lineWidth = clamp(frameW * 0.08, 1, 2.5);

  ctx.fillStyle = hexToRgba(frameColor, 0.16);
  ctx.strokeStyle = frameColor;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.rect(left, top, frameW, frameH);
  ctx.fill();
  ctx.stroke();

  if (showSymbol) {
    const inset = frameW * 0.18;
    ctx.strokeStyle = OTAN_SYMBOL_COLOR;
    ctx.lineWidth = clamp(frameW * 0.07, 1, 2.2);
    ctx.beginPath();
    ctx.moveTo(left + inset, top + inset);
    ctx.lineTo(right - inset, bottom - inset);
    ctx.moveTo(left + inset, bottom - inset);
    ctx.lineTo(right - inset, top + inset);
    ctx.stroke();
  }

  if (showEchelon) {
    const barGap = Math.max(2, frameH * 0.12);
    const barHeight = Math.max(4, frameH * 0.45);
    ctx.strokeStyle = frameColor;
    ctx.lineWidth = clamp(frameW * 0.08, 1, 2.2);
    ctx.beginPath();
    ctx.moveTo(center.x, top - barGap);
    ctx.lineTo(center.x, top - barGap - barHeight);
    ctx.stroke();
  }
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

type SettlementMarkerShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'hex';

const SETTLEMENT_MARKER_STYLE: Record<SettlementType, {
  shape: SettlementMarkerShape;
  sizeFactor: number;
  fill: string;
  ring: 'none' | 'single' | 'double';
  labelZoom: number;
  labelScale: number;
}> = {
  outpost: { shape: 'triangle', sizeFactor: 0.15, fill: 'rgba(180, 180, 180, 0.85)', ring: 'none', labelZoom: 1.8, labelScale: 0.85 },
  colony: { shape: 'circle', sizeFactor: 0.16, fill: 'rgba(195, 195, 195, 0.90)', ring: 'none', labelZoom: 1.65, labelScale: 0.90 },
  frontierTown: { shape: 'square', sizeFactor: 0.18, fill: 'rgba(210, 210, 210, 0.92)', ring: 'none', labelZoom: 1.35, labelScale: 0.95 },
  city: { shape: 'diamond', sizeFactor: 0.21, fill: 'rgba(225, 225, 225, 0.94)', ring: 'none', labelZoom: 1.05, labelScale: 1.00 },
  metropolis: { shape: 'circle', sizeFactor: 0.24, fill: 'rgba(240, 240, 240, 0.96)', ring: 'single', labelZoom: 0.90, labelScale: 1.15 },
  megalopolis: { shape: 'hex', sizeFactor: 0.28, fill: 'rgba(248, 248, 248, 0.98)', ring: 'double', labelZoom: 0.80, labelScale: 1.25 }
};

const SETTLEMENT_MARKER_STROKE = 'rgba(30, 30, 30, 0.95)';
const SETTLEMENT_LABEL_FILL = 'rgba(250, 250, 250, 0.95)';
const SETTLEMENT_LABEL_STROKE = 'rgba(20, 20, 20, 0.85)';

const createHexShape = (radius: number): Shape => {
  const shape = new Shape();
  for (let i = 0; i < 6; i += 1) {
    const angle = Math.PI / 180 * (60 * i - 30);
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
};

export const SurfaceMapCameraSync: React.FC<{ cameraState: CameraState }> = ({ cameraState }) => {
  const camera = useThree(state => state.camera);
  const size = useThree(state => state.size);
  const invalidate = useThree(state => state.invalidate);

  useEffect(() => {
    if (!(camera instanceof OrthographicCamera)) return;

    camera.left = -size.width / 2;
    camera.right = size.width / 2;
    camera.top = size.height / 2;
    camera.bottom = -size.height / 2;
    camera.near = 0.1;
    camera.far = 1000;

    camera.zoom = cameraState.zoom;
    camera.position.set(
      (size.width / 2 - cameraState.offset.x) / cameraState.zoom,
      (cameraState.offset.y - size.height / 2) / cameraState.zoom,
      100
    );
    camera.lookAt(camera.position.x, camera.position.y, 0);
    camera.updateProjectionMatrix();

    invalidate();
  }, [
    camera,
    cameraState.offset.x,
    cameraState.offset.y,
    cameraState.zoom,
    invalidate,
    size.height,
    size.width
  ]);

  return null;
};

export const SurfaceTerrainLayer: React.FC<{ map: PlanetSurfaceMap; mapKey: string }> = React.memo(({ map, mapKey }) => {
  const config = map.descriptor.config;
  const count = config.w * config.h;
  const fillRef = useRef<InstancedMesh>(null);
  const temp = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  const invalidate = useThree(state => state.invalidate);

  const fillShape = useMemo(() => createHexShape(HEX_SIZE), []);
  const hexCornerOffsets = useMemo(() => {
    const corners: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < 6; i += 1) {
      const angle = Math.PI / 180 * (60 * i - 30);
      corners.push({ x: HEX_SIZE * Math.cos(angle), y: HEX_SIZE * Math.sin(angle) });
    }
    return corners;
  }, []);

  const fillGeometry = useDisposableMemo(() => {
    const geometry = new ShapeGeometry(fillShape);
    const vertexCount = geometry.attributes.position.count;
    const colors = new Float32Array(vertexCount * 3);
    colors.fill(1);
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    return geometry;
  }, [fillShape]);
  const fillMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false }),
    []
  );
  const gridGeometry = useDisposableMemo(() => {
    const positions: number[] = [];
    const z = 0.02;

    const neighborOf = (q: number, r: number, edge: number): { q: number; r: number } | null => {
      const odd = (r & 1) === 1;
      switch (edge) {
        case 0:
          return { q: q + 1, r };
        case 1:
          return { q: q + (odd ? 1 : 0), r: r + 1 };
        case 2:
          return { q: q + (odd ? 0 : -1), r: r + 1 };
        case 3:
          return { q: q - 1, r };
        case 4:
          return { q: q + (odd ? 0 : -1), r: r - 1 };
        case 5:
          return { q: q + (odd ? 1 : 0), r: r - 1 };
        default:
          return null;
      }
    };

    const inBounds = (coord: { q: number; r: number } | null): coord is { q: number; r: number } => {
      if (!coord) return false;
      return coord.q >= 0 && coord.q < config.w && coord.r >= 0 && coord.r < config.h;
    };

    const isLower = (a: { q: number; r: number }, b: { q: number; r: number }): boolean => (
      a.r < b.r || (a.r === b.r && a.q < b.q)
    );

    for (let r = 0; r < config.h; r += 1) {
      for (let q = 0; q < config.w; q += 1) {
        const { x, y } = gridToPixel({ q, r }, HEX_SIZE);
        const cx = x;
        const cy = -y;

        for (let edge = 0; edge < 6; edge += 1) {
          const neighbor = neighborOf(q, r, edge);
          const shouldDraw = !inBounds(neighbor) || isLower({ q, r }, neighbor);
          if (!shouldDraw) continue;

          const a = hexCornerOffsets[edge];
          const b = hexCornerOffsets[(edge + 1) % 6];
          positions.push(cx + a.x, cy + a.y, z, cx + b.x, cy + b.y, z);
        }
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(positions), 3));
    return geometry;
  }, [config.h, config.w, hexCornerOffsets, mapKey]);

  const gridMaterial = useDisposableMemo(() => new LineBasicMaterial({
    color: '#94a3b8',
    transparent: true,
    opacity: 0.28,
    depthTest: false,
    depthWrite: false
  }), []);

  useLayoutEffect(() => {
    const fill = fillRef.current;
    if (!fill) return;

    for (let r = 0; r < config.h; r += 1) {
      for (let q = 0; q < config.w; q += 1) {
        const index = r * config.w + q;
        const tile = map.tiles[index] ?? null;
        const { x, y } = gridToPixel({ q, r }, HEX_SIZE);

        temp.position.set(x, -y, 0);
        temp.rotation.set(0, 0, 0);
        temp.scale.set(1, 1, 1);
        temp.updateMatrix();
        fill.setMatrixAt(index, temp.matrix);

        color.set(tile ? (biomeColors[tile.biome] ?? '#334155') : '#1f2937');
        fill.setColorAt(index, color);
      }
    }

    fill.count = count;
    fill.instanceMatrix.needsUpdate = true;
    if (fill.instanceColor) fill.instanceColor.needsUpdate = true;

    invalidate();
  }, [color, config.h, config.w, invalidate, map.tiles, mapKey, temp]);

  return (
    <group>
      <instancedMesh ref={fillRef} args={[fillGeometry, fillMaterial, count]} frustumCulled={false} />
      <lineSegments
        geometry={gridGeometry}
        material={gridMaterial}
        frustumCulled={false}
        renderOrder={1}
      />
    </group>
  );
});

export const SurfaceProjectionLayer: React.FC<{ map: PlanetSurfaceMap; mapKey: string }> = React.memo(({ map, mapKey }) => {
  const config = map.descriptor.config;
  const count = config.w * config.h;
  const fillRef = useRef<InstancedMesh>(null);
  const temp = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  const invalidate = useThree(state => state.invalidate);

  const fillGeometry = useDisposableMemo(() => {
    const geometry = new PlaneGeometry(PROJECTION_CELL_SIZE, PROJECTION_CELL_SIZE);
    const vertexCount = geometry.attributes.position.count;
    const colors = new Float32Array(vertexCount * 3);
    colors.fill(1);
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    return geometry;
  }, []);
  const fillMaterial = useDisposableMemo(
    () => new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false }),
    []
  );
  const gridGeometry = useDisposableMemo(() => {
    const positions: number[] = [];
    const z = 0.02;
    const mapWidth = config.w * PROJECTION_CELL_SIZE;
    const mapHeight = config.h * PROJECTION_CELL_SIZE;

    for (let q = 0; q <= config.w; q += 1) {
      const x = q * PROJECTION_CELL_SIZE;
      positions.push(x, 0, z, x, -mapHeight, z);
    }
    for (let r = 0; r <= config.h; r += 1) {
      const y = r * PROJECTION_CELL_SIZE;
      positions.push(0, -y, z, mapWidth, -y, z);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(positions), 3));
    return geometry;
  }, [config.h, config.w, mapKey]);

  const gridMaterial = useDisposableMemo(() => new LineBasicMaterial({
    color: '#94a3b8',
    transparent: true,
    opacity: 0.28,
    depthTest: false,
    depthWrite: false
  }), []);

  useLayoutEffect(() => {
    const fill = fillRef.current;
    if (!fill) return;

    for (let r = 0; r < config.h; r += 1) {
      for (let q = 0; q < config.w; q += 1) {
        const index = r * config.w + q;
        const tile = map.tiles[index] ?? null;
        const { x, y } = gridToProjectionPixel({ q, r }, config, PROJECTION_CELL_SIZE);

        temp.position.set(x, -y, 0);
        temp.rotation.set(0, 0, 0);
        temp.scale.set(1, 1, 1);
        temp.updateMatrix();
        fill.setMatrixAt(index, temp.matrix);

        color.set(tile ? (biomeColors[tile.biome] ?? '#334155') : '#1f2937');
        fill.setColorAt(index, color);
      }
    }

    fill.count = count;
    fill.instanceMatrix.needsUpdate = true;
    if (fill.instanceColor) fill.instanceColor.needsUpdate = true;

    invalidate();
  }, [color, config.h, config.w, count, invalidate, map.tiles, mapKey, temp]);

  return (
    <group>
      <instancedMesh ref={fillRef} args={[fillGeometry, fillMaterial, count]} frustumCulled={false} />
      <lineSegments
        geometry={gridGeometry}
        material={gridMaterial}
        frustumCulled={false}
        renderOrder={1}
      />
    </group>
  );
});

export const drawSurfaceOverlay = (ctx: CanvasRenderingContext2D, data: SurfaceOverlayData) => {
  const {
    map,
    activeMapConfig,
    mapMode,
    camera,
    viewport,
    renderDpr,
    hovered,
    selected,
    selectedArmyCoord,
    movePreviewPath,
    reachableCosts,
    armyMarkers,
    buildingMarkers,
    landingMarkers,
    settlements,
    showLabels
  } = data;

  ctx.save();
  ctx.scale(renderDpr, renderDpr);
  ctx.clearRect(0, 0, viewport.width, viewport.height);

  const cellSize = mapMode === 'projection' ? PROJECTION_CELL_SIZE : HEX_SIZE;
  const cellSizePx = cellSize * camera.zoom;
  const coordToWorld = (coord: HexCoord) => (
    mapMode === 'projection'
      ? gridToProjectionPixel(coord, activeMapConfig, cellSize)
      : gridToPixel(coord, cellSize)
  );
  const coordToScreen = (coord: HexCoord) => {
    const { x, y } = coordToWorld(coord);
    return {
      x: x * camera.zoom + camera.offset.x,
      y: y * camera.zoom + camera.offset.y
    };
  };
  const drawCell = (center: { x: number; y: number }, options: { fill?: string; stroke?: string; lineWidth?: number }) => {
    if (mapMode !== 'projection') {
      drawHex(ctx, center, cellSizePx, options);
      return;
    }
    const half = cellSizePx / 2;
    ctx.beginPath();
    ctx.rect(center.x - half, center.y - half, cellSizePx, cellSizePx);
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

  if (reachableCosts) {
    reachableCosts.forEach((_cost, key) => {
      const [qStr, rStr] = key.split('|');
      const q = Number(qStr);
      const r = Number(rStr);
      if (!Number.isFinite(q) || !Number.isFinite(r)) return;
      const tile = map.tiles[r * activeMapConfig.w + q];
      if (!tile || !isPassable(tile.biome)) return;
      const center = coordToScreen({ q, r });
      drawCell(center, { fill: 'rgba(56, 189, 248, 0.10)' });
    });
  }

  if (movePreviewPath && movePreviewPath.length > 1) {
    ctx.beginPath();
    movePreviewPath.forEach((c, i) => {
      const { x, y } = coordToWorld(c);
      const px = x * camera.zoom + camera.offset.x;
      const py = y * camera.zoom + camera.offset.y;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
    ctx.lineWidth = Math.max(2, cellSizePx * 0.08);
    ctx.stroke();
  }

  const labelGrid = new Set<string>();
  const labelCell = Math.max(70, cellSizePx * 3.2);

  settlements.forEach(settlement => {
    const center = coordToScreen(settlement.coord);

    const style = SETTLEMENT_MARKER_STYLE[settlement.type] ?? SETTLEMENT_MARKER_STYLE.city;
    const size = Math.max(3, cellSizePx * style.sizeFactor);
    const stroke = SETTLEMENT_MARKER_STROKE;

    if (style.shape === 'hex') {
      drawHex(ctx, center, size, {
        fill: style.fill,
        stroke,
        lineWidth: Math.max(1, size * 0.12)
      });
    } else {
      ctx.beginPath();
      if (style.shape === 'circle') {
        ctx.arc(center.x, center.y, size, 0, Math.PI * 2);
      } else if (style.shape === 'square') {
        ctx.rect(center.x - size, center.y - size, size * 2, size * 2);
      } else if (style.shape === 'diamond') {
        ctx.moveTo(center.x, center.y - size);
        ctx.lineTo(center.x + size, center.y);
        ctx.lineTo(center.x, center.y + size);
        ctx.lineTo(center.x - size, center.y);
        ctx.closePath();
      } else if (style.shape === 'triangle') {
        ctx.moveTo(center.x, center.y - size);
        ctx.lineTo(center.x + size, center.y + size);
        ctx.lineTo(center.x - size, center.y + size);
        ctx.closePath();
      }
      ctx.fillStyle = style.fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, size * 0.12);
      ctx.fill();
      ctx.stroke();
    }

    if (style.ring === 'single') {
      ctx.beginPath();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, size * 0.10);
      ctx.arc(center.x, center.y, size * 1.55, 0, Math.PI * 2);
      ctx.stroke();
    } else if (style.ring === 'double') {
      drawHex(ctx, center, size * 1.55, { stroke, lineWidth: Math.max(1, size * 0.10) });
      drawHex(ctx, center, size * 1.05, { stroke, lineWidth: Math.max(1, size * 0.08) });
    }

    if (settlement.isCapital) {
      ctx.beginPath();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, size * 0.18);
      ctx.moveTo(center.x - size * 0.55, center.y);
      ctx.lineTo(center.x + size * 0.55, center.y);
      ctx.moveTo(center.x, center.y - size * 0.55);
      ctx.lineTo(center.x, center.y + size * 0.55);
      ctx.stroke();
    }

    if (showLabels && camera.zoom >= style.labelZoom) {
      const fontPx = Math.round(clamp(cellSizePx * 0.45 * style.labelScale, 9, 18));
      const lx = center.x;
      const ly = center.y - size * 1.2;

      const cellKey = `${Math.floor(lx / labelCell)},${Math.floor(ly / labelCell)}`;
      if (!labelGrid.has(cellKey)) {
        labelGrid.add(cellKey);
        ctx.font = `${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = Math.max(2, fontPx * 0.25);
        ctx.strokeStyle = SETTLEMENT_LABEL_STROKE;
        ctx.fillStyle = SETTLEMENT_LABEL_FILL;
        ctx.strokeText(settlement.name, lx, ly);
        ctx.fillText(settlement.name, lx, ly);
      }
    }
  });

  buildingMarkers.forEach(marker => {
    const center = coordToScreen(marker.coord);
    const size = Math.max(3, cellSizePx * 0.2);
    ctx.fillStyle = marker.faction?.color ?? '#e2e8f0';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(center.x - size, center.y - size, size * 2, size * 2);
    ctx.fill();
    ctx.stroke();
  });

  const iconWidth = clamp(cellSizePx * 1.25, 10, 22);
  const showSymbol = iconWidth >= 12;
  const showEchelon = iconWidth >= 15;

  armyMarkers.forEach(marker => {
    const center = coordToScreen(marker.coord);
    const frameColor = marker.faction?.color ?? '#93c5fd';
    drawOtanInfantry(ctx, center, cellSizePx, frameColor, showSymbol, showEchelon);
  });

  landingMarkers.forEach(marker => {
    const center = coordToScreen(marker.coord);
    const frameColor = marker.faction?.color ?? '#93c5fd';
    ctx.save();
    ctx.setLineDash([Math.max(4, cellSizePx * 0.35), Math.max(3, cellSizePx * 0.25)]);
    drawCell(center, { stroke: hexToRgba(frameColor, 0.95), lineWidth: Math.max(1.5, cellSizePx * 0.1) });
    ctx.setLineDash([]);
    ctx.restore();
  });

  const drawHighlight = (coord: HexCoord, color: string) => {
    const center = coordToScreen(coord);
    drawCell(center, { stroke: color, lineWidth: 2 });
  };

  if (hovered) drawHighlight(hovered, 'rgba(94, 234, 212, 0.9)');
  if (selected) drawHighlight(selected, 'rgba(59, 130, 246, 0.9)');
  if (selectedArmyCoord) drawHighlight(selectedArmyCoord, 'rgba(56, 189, 248, 0.9)');

  ctx.restore();
};
