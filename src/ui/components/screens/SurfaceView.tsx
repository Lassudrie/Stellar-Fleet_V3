import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Army,
  ArmyState,
  Biome,
  FactionId,
  FactionState,
  GroundBuilding,
  HexCoord,
  PlanetBody,
  PlanetSurfaceMap,
  Settlement,
  SettlementControlState,
  SettlementType,
  StarSystem
} from '../../../shared/shared';
import { useI18n } from '../../i18n';
import type { GameCommand } from '../../../engine/commands';
import {
  computeEffectiveMP,
  computeReachable,
  computeStackingFactors,
  computeSupplyDistanceMapFromSurfaceMap,
  computeZocSnapshotFromArmies,
  deriveTerrainTypeFromSurfaceMap,
  findPathWithCost,
  hasLineOfSight,
  hexDistance,
  hexKey as engineHexKey,
  isInEnemyZoc,
  isSupplied,
  MOVE_COST,
  previewEngagement,
  STACKING_CAP,
  SUPPLY_RADIUS
} from '../../../engine/ground';
import { GROUND_UNIT_STATS } from '../../../content/data/groundUnits';
import { isPassable } from '../../../engine/planetSurface';
import { useMapControlsCamera, zoomAroundPoint } from '../../hooks';
import {
  CENTER_SLOP_PX,
  CLICK_DRAG_THRESHOLD_SQ,
  clamp,
  clampAffinity,
  computeMapBoundsPx,
  deriveFallbackPos,
  getTileAt,
  gridToPixel,
  HEX_SIZE,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizePos,
  pixelToGrid,
  quantizeZoom,
  sameHex,
  surfaceMapKey,
  TerrainBuffer,
  TERRAIN_ZOOM_STEP,
  PAN_MARGIN_PX,
  renderTerrainLayer,
  drawHex
} from './surfaceViewCore';

interface SurfaceViewProps {
  map: PlanetSurfaceMap | null;
  mapStatus?: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  system: StarSystem | null;
  body: PlanetBody | null;
  armies: Army[];
  buildings: GroundBuilding[];
  settlementControl?: Record<string, SettlementControlState>;
  factions: FactionState[];
  playerFactionId: FactionId;
  onBackToGalaxy: () => void;
  onBackToSystem?: () => void;
  onIssueCommand?: (cmd: GameCommand) => void;
}

type CameraState = { zoom: number; offset: { x: number; y: number } };
type WheelInput = { clientX: number; clientY: number; deltaY: number; currentTarget: EventTarget | null };
type PointerSnapshot = {
  pointerId: number;
  clientX: number;
  clientY: number;
  pointerType: string;
  currentTarget: HTMLCanvasElement;
};

const INTERACTION_COOLDOWN_MS = 140;
const MAX_DPR_MOBILE = 1.25;
const MAX_DPR_DESKTOP = 1.75;

const OTAN_SYMBOL_COLOR = '#0f172a';

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
  ocean: '#0a75c2',        // deep ocean blue
  coast: '#2bb9a8',        // bright teal shallows
  lake: '#4f9dfd',         // clear lake blue
  ice: '#f2f7fb',          // icy white-blue
  fractured_ice: '#d7e6f6', // fractured ice
  dusty_ice: '#c9d2c8',     // dusty ice
  cryovolcanic: '#9aaec7',  // cryovolcanic plains
  tundra: '#ced4a4',       // pale sage tundra
  taiga: '#1b6b4b',        // pine green
  grassland: '#8ccb4a',    // fresh prairie green
  forest: '#1e7c2f',       // dense forest green
  rainforest: '#22a95f',   // lush rainforest jade
  desert: '#e3b04c',       // warm sand
  ash_desert: '#a88463',    // mineral ash
  thermal_polygons: '#b6a46d', // thermal polygon terrain
  lava_flats: '#b3402c',    // cooled lava
  vitrified: '#6b7c8a',     // glassy plains
  oxidized: '#b35a3a',      // oxidized metal
  compressed_plateau: '#7c7f75', // compressed plateau
  chemical_erosion: '#7aa081', // chemical alteration
  fossil_basin: '#c1a07a',  // fossil basin
  rocky: '#9b8974',        // stone brown
  mountain: '#565f6b',     // slate mountain
  volcanic: '#e05b3c',     // lava orange
  cratered: '#8a60c6'      // impact purple
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

const SurfaceView: React.FC<SurfaceViewProps> = ({
  map: mapProp,
  mapStatus = 'ready',
  system,
  body,
  armies,
  buildings,
  settlementControl,
  factions,
  playerFactionId,
  onBackToGalaxy,
  onBackToSystem,
  onIssueCommand
}) => {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const userCameraRef = useRef(false);
  const lastViewportRef = useRef<{ width: number; height: number }>({ width: 1280, height: 720 });
  const lastFittedBodyIdRef = useRef<string | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const [camera, setCamera] = useState<CameraState>({ zoom: 1, offset: { x: 0, y: 0 } });
  const [hovered, setHovered] = useState<HexCoord | null>(null);
  const [selected, setSelected] = useState<HexCoord | null>(null);
  const [selectedArmyId, setSelectedArmyId] = useState<string | null>(null);
  const [orderMode, setOrderMode] = useState<'none' | 'move' | 'attack'>('none');
  const [readyMapCache, setReadyMapCache] = useState<{ key: string; map: PlanetSurfaceMap } | null>(null);
  const terrainBufferRef = useRef<TerrainBuffer | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const pointerMoveFrameRef = useRef<number | null>(null);
  const interactionDeadlineRef = useRef(0);
  const pendingWheelEvent = useRef<WheelInput | null>(null);
  const pendingPointerEvents = useRef<Map<number, PointerSnapshot>>(new Map());

  const factionIndex = useMemo(() => factions.reduce<Record<FactionId, FactionState>>((acc, faction) => {
    acc[faction.id] = faction;
    return acc;
  }, {}), [factions]);

  const mapKeyFromProp = useMemo(() => (mapProp ? surfaceMapKey(mapProp) : null), [mapProp]);

  useEffect(() => {
    setReadyMapCache(prev => {
      if (mapProp && mapStatus === 'ready' && mapKeyFromProp) {
        if (prev?.key === mapKeyFromProp && prev.map === mapProp) return prev;
        return { key: mapKeyFromProp, map: mapProp };
      }

      if (mapKeyFromProp && prev && prev.key !== mapKeyFromProp) {
        return null;
      }

      if (!mapKeyFromProp && body?.id && prev && prev.map.bodyId !== body.id) {
        return null;
      }

      return prev;
    });
  }, [body?.id, mapKeyFromProp, mapProp, mapStatus]);

  const currentMapKey = useMemo(() => {
    if (mapProp && mapKeyFromProp) return mapKeyFromProp;
    if (readyMapCache && body?.id === readyMapCache.map.bodyId) return readyMapCache.key;
    return null;
  }, [body?.id, mapKeyFromProp, mapProp, readyMapCache]);

  const map = useMemo(() => {
    if (mapProp && mapKeyFromProp) return mapProp;
    if (readyMapCache && currentMapKey === readyMapCache.key) return readyMapCache.map;
    return null;
  }, [currentMapKey, mapKeyFromProp, mapProp, readyMapCache]);

  const primarySettlement = useMemo(() => {
    if (!map || map.settlements.length === 0) return null;
    return map.settlements.reduce<Settlement | null>((best, cur) => {
      if (!best) return cur;
      const curPop = cur.population ?? 0;
      const bestPop = best.population ?? 0;
      if (curPop > bestPop) return cur;
      if (curPop === bestPop && cur.isCapital && !best.isCapital) return cur;
      return best;
    }, null);
  }, [map]);

  useEffect(() => {
    terrainBufferRef.current = null;
  }, [currentMapKey]);

  useEffect(() => () => {
    if (wheelFrameRef.current !== null) {
      cancelAnimationFrame(wheelFrameRef.current);
      wheelFrameRef.current = null;
    }
    if (pointerMoveFrameRef.current !== null) {
      cancelAnimationFrame(pointerMoveFrameRef.current);
      pointerMoveFrameRef.current = null;
    }
    pendingWheelEvent.current = null;
    pendingPointerEvents.current.clear();
  }, []);

  const activeMapConfig = map?.descriptor.config ?? null;

  const clampOffset = useCallback(
    (offset: { x: number; y: number }, zoom: number): { x: number; y: number } => {
      if (!activeMapConfig) return offset;

      const bounds = computeMapBoundsPx(activeMapConfig, HEX_SIZE);
      const mapW = bounds.width * zoom;
      const mapH = bounds.height * zoom;

      let x = offset.x;
      let y = offset.y;

      if (mapW <= viewport.width) {
        // Do NOT hard-snap to center; clamp around center with a small tolerance to avoid jumps.
        const centerX = (viewport.width - mapW) / 2 - bounds.minX * zoom;
        x = clamp(x, centerX - CENTER_SLOP_PX, centerX + CENTER_SLOP_PX);
      } else {
        const minX = viewport.width - PAN_MARGIN_PX - bounds.maxX * zoom;
        const maxX = PAN_MARGIN_PX - bounds.minX * zoom;
        x = clamp(x, minX, maxX);
      }

      if (mapH <= viewport.height) {
        const centerY = (viewport.height - mapH) / 2 - bounds.minY * zoom;
        y = clamp(y, centerY - CENTER_SLOP_PX, centerY + CENTER_SLOP_PX);
      } else {
        const minY = viewport.height - PAN_MARGIN_PX - bounds.maxY * zoom;
        const maxY = PAN_MARGIN_PX - bounds.minY * zoom;
        y = clamp(y, minY, maxY);
      }

      return { x, y };
    },
    [activeMapConfig, viewport.height, viewport.width]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      setViewport({
        width: container.clientWidth,
        height: container.clientHeight
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);

    return () => observer.disconnect();
  }, []);

  // Prefer touch handlers on coarse pointers to avoid flaky PointerEvent streams on some Android devices.
  const supportsPointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;
  const prefersTouchFallback = typeof window !== 'undefined' && (
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches)
    || (typeof window.matchMedia !== 'function' && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  );
  const touchFallbackEnabled = !supportsPointerEvents || prefersTouchFallback;
  const pointerHandlersEnabled = supportsPointerEvents && !prefersTouchFallback;
  const markInteraction = useCallback(() => {
    if (typeof performance === 'undefined') return;
    interactionDeadlineRef.current = performance.now() + INTERACTION_COOLDOWN_MS;
  }, []);
  const isInteractionActive = useCallback(() => {
    if (typeof performance === 'undefined') return false;
    return performance.now() < interactionDeadlineRef.current;
  }, []);
  const getRenderDpr = useCallback(() => {
    if (typeof window === 'undefined') return 1;
    const raw = window.devicePixelRatio || 1;
    const cap = prefersTouchFallback ? MAX_DPR_MOBILE : MAX_DPR_DESKTOP;
    return Math.min(raw, cap);
  }, [prefersTouchFallback]);

  useEffect(() => {
    if (!map || !activeMapConfig) return;
    const bodyId = map.bodyId;
    const mapChanged = lastFittedBodyIdRef.current !== bodyId;
    if (mapChanged) {
      lastFittedBodyIdRef.current = bodyId;
      userCameraRef.current = false; // new map => allow auto-focus
    }
    // If the user already interacted with the camera, do not re-center on every viewport change.
    if (userCameraRef.current && !mapChanged) return;

    const bounds = computeMapBoundsPx(activeMapConfig, HEX_SIZE);
    const targetZoom = clamp(1, MIN_ZOOM, MAX_ZOOM);
    const focusWorld = primarySettlement
      ? gridToPixel(primarySettlement.coord, HEX_SIZE)
      : {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2
      };

    const desiredOffset = {
      x: viewport.width / 2 - focusWorld.x * targetZoom,
      y: viewport.height / 2 - focusWorld.y * targetZoom
    };

    const offset = clampOffset(desiredOffset, targetZoom);
    setCamera({ zoom: targetZoom, offset });
    setHovered(null);
    setSelected(null);
  }, [map?.bodyId, activeMapConfig, viewport.width, viewport.height, primarySettlement, clampOffset]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = getRenderDpr();
    const nextWidth = Math.max(1, Math.floor(viewport.width * dpr));
    const nextHeight = Math.max(1, Math.floor(viewport.height * dpr));

    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;

    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
  }, [getRenderDpr, viewport.width, viewport.height]);

  const cameraControls = useMapControlsCamera({
    camera,
    clampOffset,
    maxZoom: MAX_ZOOM,
    minZoom: MIN_ZOOM,
    setCamera,
    tapDragThresholdSq: CLICK_DRAG_THRESHOLD_SQ
  });

  const normalizeTouchPoint = useCallback((touch: React.Touch, rect: DOMRect) => ({
    clientX: clamp(touch.clientX, rect.left, rect.right),
    clientY: clamp(touch.clientY, rect.top, rect.bottom)
  }), []);

  const touchToPointerEvent = useCallback((
    touchEvent: React.TouchEvent<HTMLCanvasElement>,
    touch: React.Touch,
    rect: DOMRect
  ): React.PointerEvent<HTMLCanvasElement> => {
    const target = touchEvent.currentTarget;
    const normalized = normalizeTouchPoint(touch, rect);
    return {
      pointerId: touch.identifier,
      clientX: normalized.clientX,
      clientY: normalized.clientY,
      offsetX: normalized.clientX - rect.left,
      offsetY: normalized.clientY - rect.top,
      currentTarget: target,
      target,
      pointerType: 'touch',
      preventDefault: () => touchEvent.preventDefault(),
      stopPropagation: () => touchEvent.stopPropagation(),
      persist: () => {},
      setPointerCapture: () => {
        try {
          target.setPointerCapture(touch.identifier);
        } catch {
          // ignore
        }
      },
      releasePointerCapture: () => {
        try {
          target.releasePointerCapture(touch.identifier);
        } catch {
          // ignore
        }
      }
    } as unknown as React.PointerEvent<HTMLCanvasElement>;
  }, [normalizeTouchPoint]);

  type TouchListLike = TouchList | React.TouchList;

  const forwardTouchEvent = useCallback((
    touchEvent: React.TouchEvent<HTMLCanvasElement>,
    handler: (event: React.PointerEvent<HTMLCanvasElement>) => void,
    touchList?: TouchListLike
  ) => {
    const rect = touchEvent.currentTarget.getBoundingClientRect();
    const list = touchList ?? touchEvent.changedTouches;
    for (let i = 0; i < list.length; i += 1) {
      const touch = list.item(i);
      if (!touch) continue;
      const pointerLike = touchToPointerEvent(touchEvent, touch, rect);
      handler(pointerLike);
    }
  }, [touchToPointerEvent]);

  // When viewport changes on mobile (address bar / chrome), preserve the world center to avoid jumps,
  // but only once the user has interacted with the camera.
  useEffect(() => {
    const prevVp = lastViewportRef.current;
    const nextVp = viewport;
    if (prevVp.width === nextVp.width && prevVp.height === nextVp.height) return;

    if (map && activeMapConfig && userCameraRef.current) {
      setCamera(prev => {
        const prevCenterWorldX = (prevVp.width / 2 - prev.offset.x) / prev.zoom;
        const prevCenterWorldY = (prevVp.height / 2 - prev.offset.y) / prev.zoom;
        const nextOffset = {
          x: nextVp.width / 2 - prevCenterWorldX * prev.zoom,
          y: nextVp.height / 2 - prevCenterWorldY * prev.zoom
        };
        return { ...prev, offset: clampOffset(nextOffset, prev.zoom) };
      });
    }

    lastViewportRef.current = nextVp;
  }, [viewport.width, viewport.height, map, activeMapConfig, clampOffset]);

  const normalizedArmies = useMemo(() => {
    if (!map || !activeMapConfig) return [];
    return armies
      .filter(army => army.state === ArmyState.DEPLOYED && army.containerId === map.bodyId)
      .map(army => {
        const coord = normalizePos(army.surfacePos, activeMapConfig) ?? deriveFallbackPos(army.id, activeMapConfig);
        return {
          army,
          coord,
          faction: factionIndex[army.factionId]
        };
      });
  }, [activeMapConfig, armies, factionIndex, map]);

  const normalizedBuildings = useMemo(() => {
    if (!map || !activeMapConfig) return [];
    return buildings
      .filter(building => building.surfacePos.bodyId === map.bodyId)
      .map(building => ({
        building,
        coord: normalizePos(building.surfacePos, activeMapConfig) ?? deriveFallbackPos(building.id, activeMapConfig),
        faction: factionIndex[building.factionId]
      }));
  }, [activeMapConfig, buildings, factionIndex, map]);

  const settlements = useMemo(() => {
    if (!map || !activeMapConfig) return [];
    return map.settlements.map(entry => ({
      ...entry,
      coord: normalizePos({ ...entry.coord, bodyId: map.bodyId }, activeMapConfig) ?? deriveFallbackPos(entry.id, activeMapConfig)
    }));
  }, [activeMapConfig, map]);

  const occupancyByHex = useMemo(() => {
    if (!map) return new Map<string, Army[]>();
    const next = new Map<string, Army[]>();
    normalizedArmies.forEach(entry => {
      const key = engineHexKey(entry.coord);
      const list = next.get(key) ?? [];
      list.push(entry.army);
      next.set(key, list);
    });
    return next;
  }, [map, normalizedArmies]);

  const stackingFactors = useMemo(() => {
    const occupancy = new Map<string, string[]>();
    occupancyByHex.forEach((armiesOnHex, key) => {
      occupancy.set(
        key,
        armiesOnHex.map(army => army.id)
      );
    });
    return computeStackingFactors(occupancy);
  }, [occupancyByHex]);

  const pickCoord = useCallback((clientX: number, clientY: number, rectOverride?: DOMRect): HexCoord | null => {
    if (!map) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = rectOverride ?? canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const worldX = (x - camera.offset.x) / camera.zoom;
    const worldY = (y - camera.offset.y) / camera.zoom;

    const bounds = computeMapBoundsPx(map.descriptor.config, HEX_SIZE);
    if (worldX < bounds.minX || worldX > bounds.maxX || worldY < bounds.minY || worldY > bounds.maxY) return null;

    const rounded = pixelToGrid(worldX, worldY, HEX_SIZE);
    const normalized = normalizePos({ ...rounded, bodyId: map.bodyId }, map.descriptor.config);
    return normalized;
  }, [camera.offset.x, camera.offset.y, camera.zoom, map]);

  const requestTerrainBuffer = useCallback((dpr: number): TerrainBuffer | null => {
    if (!map || !activeMapConfig || !currentMapKey) return null;
    const targetZoom = quantizeZoom(camera.zoom, TERRAIN_ZOOM_STEP, MIN_ZOOM, MAX_ZOOM);
    const cached = terrainBufferRef.current;
    const hot = isInteractionActive();
    if (cached && cached.key === currentMapKey && cached.dpr === dpr) {
      if (cached.zoom === targetZoom || hot) {
        return cached;
      }
    }
    if (hot && cached && cached.key === currentMapKey && cached.dpr === dpr) {
      return cached;
    }

    const buffer = renderTerrainLayer(map, activeMapConfig, targetZoom, dpr, HEX_SIZE, biomeColors);
    terrainBufferRef.current = buffer;
    return buffer;
  }, [activeMapConfig, camera.zoom, currentMapKey, isInteractionActive, map, renderTerrainLayer]);

  // draw() is defined later, after overlay computations.

  const queueWheel = useCallback((event: WheelEvent) => {
    userCameraRef.current = true;
    markInteraction();
    if (event.cancelable) event.preventDefault();
    pendingWheelEvent.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      deltaY: event.deltaY,
      currentTarget: event.currentTarget
    };
    if (wheelFrameRef.current === null) {
      wheelFrameRef.current = requestAnimationFrame(() => {
        wheelFrameRef.current = null;
        const pending = pendingWheelEvent.current;
        pendingWheelEvent.current = null;
        if (!pending) return;
        const target = pending.currentTarget as HTMLElement | null;
        if (!target) return;
        const rect = target.getBoundingClientRect();
        const focus = {
          x: pending.clientX - rect.left,
          y: pending.clientY - rect.top
        };
        const zoomFactor = pending.deltaY < 0 ? 1.1 : 0.9;
        setCamera(prev => zoomAroundPoint(prev, focus, prev.zoom * zoomFactor, clampOffset, MIN_ZOOM, MAX_ZOOM));
      });
    }
  }, [clampOffset, markInteraction, setCamera]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => queueWheel(event);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [queueWheel]);

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    userCameraRef.current = true;
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    cameraControls.handlePointerDown(event);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    pendingPointerEvents.current.set(event.pointerId, {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType,
      currentTarget: event.currentTarget
    });
    if (pointerMoveFrameRef.current === null) {
      pointerMoveFrameRef.current = requestAnimationFrame(() => {
        pointerMoveFrameRef.current = null;
        const pendingMap = pendingPointerEvents.current;
        pendingPointerEvents.current = new Map<number, PointerSnapshot>();

        const canvas = canvasRef.current;
        const rect = canvas ? canvas.getBoundingClientRect() : null;

        // Process all pending pointer moves
        let anyInteracting = false;
        for (const pending of pendingMap.values()) {
          const interacting = cameraControls.handlePointerMove({
            ...pending,
            offsetX: rect ? pending.clientX - rect.left : undefined,
            offsetY: rect ? pending.clientY - rect.top : undefined
          });
          if (interacting) {
            anyInteracting = true;
          }
        }

        if (anyInteracting) {
          markInteraction();
          setHovered(null);
          return;
        }

        if (!map || pendingMap.size === 0) return;

        // Use the last pointer event for hover (or primary pointer if available)
        const lastEvent = Array.from(pendingMap.values())[pendingMap.size - 1];
        const coord = pickCoord(lastEvent.clientX, lastEvent.clientY, rect ?? undefined);
        setHovered(prev => (sameHex(prev, coord) ? prev : coord));
      });
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // We only mark pointer streams as reliable once we have seen moves; up events alone should not disable touch fallback.
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    // Clean up pending moves for this pointer
    pendingPointerEvents.current.delete(event.pointerId);
    
    const wasTap = cameraControls.handlePointerUp(event);
    if (!wasTap || !map) return;

    const coord = pickCoord(event.clientX, event.clientY);
    setSelected(coord);

    if (coord && onIssueCommand && selectedArmyId && body) {
      const selectedArmy = armies.find(a => a.id === selectedArmyId) ?? null;
      if (selectedArmy && selectedArmy.state === ArmyState.DEPLOYED && selectedArmy.containerId === body.id) {
        if (orderMode === 'move') {
          onIssueCommand({ type: 'ORDER_GROUND_MOVE', armyId: selectedArmyId, to: { bodyId: body.id, q: coord.q, r: coord.r } });
          setOrderMode('none');
        } else if (orderMode === 'attack') {
          const target = normalizedArmies
            .filter(m => m.coord.q === coord.q && m.coord.r === coord.r)
            .map(m => m.army)
            .find(a => a.factionId !== playerFactionId);
          if (target) {
            onIssueCommand({ type: 'ORDER_GROUND_ATTACK', attackerId: selectedArmyId, targetArmyId: target.id });
            setOrderMode('none');
          }
        }
      }
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // Pointer cancel often fires when the browser takes over the gesture; do not disable the touch fallback because of it.
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    // Clean up pending moves for this pointer
    pendingPointerEvents.current.delete(event.pointerId);
    
    cameraControls.handlePointerCancel(event);
    setHovered(null);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLCanvasElement>) => {
    userCameraRef.current = true;
    event.preventDefault();
    forwardTouchEvent(event, handlePointerDown, event.changedTouches);
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    forwardTouchEvent(event, handlePointerMove, event.touches);
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    forwardTouchEvent(event, handlePointerUp, event.changedTouches);
  };

  const handleTouchCancel = (event: React.TouchEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    forwardTouchEvent(event, handlePointerCancel, event.changedTouches);
  };

  const activeCoord = selected ?? hovered;
  const activeTile = map && activeCoord ? getTileAt(map, activeCoord) : null;
  const tileArmies = useMemo(() => {
    if (!map || !activeCoord) return [];
    return normalizedArmies.filter(entry => entry.coord.q === activeCoord.q && entry.coord.r === activeCoord.r);
  }, [activeCoord, map, normalizedArmies]);

  const selectedArmy = useMemo(() => {
    if (!selectedArmyId) return null;
    const army = armies.find(a => a.id === selectedArmyId) ?? null;
    if (!army) return null;
    if (army.state !== ArmyState.DEPLOYED) return null;
    if (!body || army.containerId !== body.id) return null;
    return army;
  }, [armies, body, selectedArmyId]);

  const selectedArmyCoord = useMemo(() => {
    if (!selectedArmy || !activeMapConfig) return null;
    return normalizePos(selectedArmy.surfacePos, activeMapConfig);
  }, [activeMapConfig, selectedArmy]);

  const supplyByFaction = useMemo(() => {
    if (!map) return new Map<FactionId, Uint16Array>();
    const mapByFaction = new Map<FactionId, Uint16Array>();
    const factionIds = Array.from(new Set(normalizedArmies.map(m => m.army.factionId)));
    factionIds.forEach(fid => {
      mapByFaction.set(fid, computeSupplyDistanceMapFromSurfaceMap(map, buildings, settlementControl, fid));
    });
    return mapByFaction;
  }, [buildings, map, normalizedArmies, settlementControl]);

  const isArmySupplied = useCallback((army: Army, coord: HexCoord | null): boolean => {
    if (!map || !coord) return false;
    const dist = supplyByFaction.get(army.factionId) ?? null;
    return isSupplied(dist, coord, map, SUPPLY_RADIUS);
  }, [map, supplyByFaction]);

  const zocSnapshot = useMemo(() => {
    if (!map) return null;
    const { w, h, wrapX } = map.descriptor.config;
    const armiesOnBody = normalizedArmies.map(m => m.army);
    return computeZocSnapshotFromArmies({ bodyId: map.bodyId, w, h, wrapX, armies: armiesOnBody });
  }, [map, normalizedArmies]);

  const movementStepCostCenti = useCallback((from: HexCoord, to: HexCoord, army: Army): number => {
    if (!map) return 0;
    const terrain = deriveTerrainTypeFromSurfaceMap(map, buildings, to);
    const baseCost = MOVE_COST[terrain];
    const affinity = clampAffinity(GROUND_UNIT_STATS[army.unitType].terrainMoveAffinity[terrain]);
    let cost = Math.max(1, Math.round(baseCost * affinity * 100));

    const key = engineHexKey(to);
    const occupants = occupancyByHex.get(key) ?? [];
    const friendlyCount = occupants.filter(occupant => occupant.factionId === army.factionId && occupant.id !== army.id).length;
    if (friendlyCount > 0) cost *= 2;

    return cost;
  }, [buildings, map, occupancyByHex]);

  const movePreview = useMemo(() => {
    if (!map || !selectedArmy || !selectedArmyCoord || !hovered) return null;
    if (orderMode !== 'move') return null;

    const supplied = isArmySupplied(selectedArmy, selectedArmyCoord);
    const mpEff = computeEffectiveMP(selectedArmy, supplied);
    const mpCenti = mpEff * 100;

    const blocked = (c: HexCoord): boolean => {
      const key = engineHexKey(c);
      const occupants = occupancyByHex.get(key) ?? [];
      const enemyOnHex = occupants.some(occupant => occupant.factionId !== selectedArmy.factionId);
      if (enemyOnHex) return true;
      const friendlyCount = occupants.filter(occupant => occupant.factionId === selectedArmy.factionId).length;
      return friendlyCount >= STACKING_CAP;
    };

    const res = findPathWithCost({
      from: selectedArmyCoord,
      to: hovered,
      w: map.descriptor.config.w,
      h: map.descriptor.config.h,
      wrapX: map.descriptor.config.wrapX,
      isBlocked: blocked,
      stepCostCenti: (a, b) => movementStepCostCenti(a, b, selectedArmy)
    });

    if (!res) return { path: null, costCenti: null, mpEff, mpCenti, supplied };

    let mpUsedCenti = 0;
    const previewPath: HexCoord[] = [res.path[0]];
    let pos = res.path[0];
    for (let i = 1; i < res.path.length; i += 1) {
      const next = res.path[i];
      const cost = movementStepCostCenti(pos, next, selectedArmy);
      if (mpUsedCenti + cost > mpCenti) break;
      mpUsedCenti += cost;
      previewPath.push(next);
      pos = next;
      if (zocSnapshot && isInEnemyZoc(zocSnapshot, next, selectedArmy.factionId)) break;
    }

    return { path: previewPath, costCenti: mpUsedCenti, mpEff, mpCenti, supplied };
  }, [
    hovered,
    isArmySupplied,
    map,
    movementStepCostCenti,
    occupancyByHex,
    orderMode,
    selectedArmy,
    selectedArmyCoord,
    zocSnapshot
  ]);

  const reachableCosts = useMemo(() => {
    if (!map || !selectedArmy || !selectedArmyCoord) return null;
    const supplied = isArmySupplied(selectedArmy, selectedArmyCoord);
    const mpEff = computeEffectiveMP(selectedArmy, supplied);
    const mpCenti = mpEff * 100;
    const blocked = (c: HexCoord): boolean => {
      const key = engineHexKey(c);
      const occupants = occupancyByHex.get(key) ?? [];
      const enemyOnHex = occupants.some(occupant => occupant.factionId !== selectedArmy.factionId);
      if (enemyOnHex) return true;
      const friendlyCount = occupants.filter(occupant => occupant.factionId === selectedArmy.factionId).length;
      return friendlyCount >= STACKING_CAP;
    };
    return computeReachable({
      from: selectedArmyCoord,
      w: map.descriptor.config.w,
      h: map.descriptor.config.h,
      wrapX: map.descriptor.config.wrapX,
      isBlocked: blocked,
      stepCostCenti: (a, b) => movementStepCostCenti(a, b, selectedArmy),
      maxCostCenti: mpCenti,
      canExpand: coord => {
        if (!zocSnapshot) return true;
        if (coord.q === selectedArmyCoord.q && coord.r === selectedArmyCoord.r) return true;
        return !isInEnemyZoc(zocSnapshot, coord, selectedArmy.factionId);
      }
    });
  }, [isArmySupplied, map, movementStepCostCenti, occupancyByHex, selectedArmy, selectedArmyCoord, zocSnapshot]);

  const combatPreview = useMemo(() => {
    if (!map || !selectedArmy || !selectedArmyCoord || !hovered) return null;

    const enemy = normalizedArmies
      .filter(m => m.coord.q === hovered.q && m.coord.r === hovered.r)
      .map(m => m.army)
      .find(a => a.factionId !== playerFactionId);
    if (!enemy) return null;
    if (!enemy.surfacePos) return null;

    const dist = hexDistance(
      selectedArmyCoord,
      hovered,
      map.descriptor.config.w,
      map.descriptor.config.wrapX
    );
    if (dist < selectedArmy.rangeMin || dist > selectedArmy.rangeMax) return null;
    if (!hasLineOfSight({ map, buildings, from: selectedArmyCoord, to: hovered })) return null;

    const terrainType = deriveTerrainTypeFromSurfaceMap(map, buildings, hovered);
    const suppliedAtt = isArmySupplied(selectedArmy, selectedArmyCoord);
    const suppliedDef = isArmySupplied(enemy, hovered);

    const preview = previewEngagement({
      map,
      buildings,
      attackers: [
        {
          army: selectedArmy,
          supplied: suppliedAtt,
          stackingFactor: stackingFactors.get(selectedArmy.id) ?? 1
        }
      ],
      defender: {
        army: enemy,
        supplied: suppliedDef,
        stackingFactor: stackingFactors.get(enemy.id) ?? 1
      }
    });

    return { enemy, terrainType, preview, range: dist };
  }, [
    buildings,
    hovered,
    isArmySupplied,
    map,
    normalizedArmies,
    playerFactionId,
    selectedArmy,
    selectedArmyCoord,
    stackingFactors
  ]);

  const resolvedMapStatus = mapStatus === 'idle' ? 'loading' : mapStatus;

  const draw = useCallback(() => {
    if (!map || !activeMapConfig) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = getRenderDpr();
    const terrainBuffer = requestTerrainBuffer(dpr);
    const hot = isInteractionActive();

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    if (terrainBuffer) {
      const destX = camera.offset.x + terrainBuffer.bounds.minX * camera.zoom;
      const destY = camera.offset.y + terrainBuffer.bounds.minY * camera.zoom;
      const destW = terrainBuffer.bounds.width * camera.zoom;
      const destH = terrainBuffer.bounds.height * camera.zoom;
      ctx.drawImage(terrainBuffer.canvas, destX, destY, destW, destH);
    } else {
      const fallbackGridStroke = 'rgba(148, 163, 184, 0.22)';
      const fallbackHexSize = HEX_SIZE * camera.zoom;
      for (let r = 0; r < activeMapConfig.h; r += 1) {
        for (let q = 0; q < activeMapConfig.w; q += 1) {
          const tile = map.tiles[r * activeMapConfig.w + q];
          if (!tile) continue;
          const { x, y } = gridToPixel({ q, r }, HEX_SIZE);
          const center = {
            x: x * camera.zoom + camera.offset.x,
            y: y * camera.zoom + camera.offset.y
          };
          const color = biomeColors[tile.biome] ?? '#334155';
          drawHex(ctx, center, fallbackHexSize, { fill: color, stroke: fallbackGridStroke, lineWidth: 0.75 });
        }
      }
    }

    const hexSize = HEX_SIZE * camera.zoom;

    // --- Overlays ---
    if (reachableCosts) {
      reachableCosts.forEach((_cost, key) => {
        const [qStr, rStr] = key.split('|');
        const q = Number(qStr);
        const r = Number(rStr);
        if (!Number.isFinite(q) || !Number.isFinite(r)) return;
        const tile = map.tiles[r * activeMapConfig.w + q];
        if (!tile || !isPassable(tile.biome)) return;
        const { x, y } = gridToPixel({ q, r }, HEX_SIZE);
        const center = { x: x * camera.zoom + camera.offset.x, y: y * camera.zoom + camera.offset.y };
        drawHex(ctx, center, hexSize, { fill: 'rgba(56, 189, 248, 0.10)' });
      });
    }

    if (movePreview?.path && movePreview.path.length > 1) {
      ctx.beginPath();
      movePreview.path.forEach((c, i) => {
        const { x, y } = gridToPixel(c, HEX_SIZE);
        const px = x * camera.zoom + camera.offset.x;
        const py = y * camera.zoom + camera.offset.y;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.lineWidth = Math.max(2, hexSize * 0.08);
      ctx.stroke();
    }

    const labelGrid = new Set<string>();
    const labelCell = Math.max(70, hexSize * 3.2);

    settlements.forEach(settlement => {
      const { x, y } = gridToPixel(settlement.coord, HEX_SIZE);
      const center = {
        x: x * camera.zoom + camera.offset.x,
        y: y * camera.zoom + camera.offset.y
      };

      const style = SETTLEMENT_MARKER_STYLE[settlement.type] ?? SETTLEMENT_MARKER_STYLE.city;
      const size = Math.max(3, hexSize * style.sizeFactor);
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

      // Capital overlay (grayscale cross)
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

      // Labels
      if (!hot && camera.zoom >= style.labelZoom) {
        const fontPx = Math.round(clamp(hexSize * 0.45 * style.labelScale, 9, 18));
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

    normalizedBuildings.forEach(marker => {
      const { x, y } = gridToPixel(marker.coord, HEX_SIZE);
      const center = {
        x: x * camera.zoom + camera.offset.x,
        y: y * camera.zoom + camera.offset.y
      };
      const size = Math.max(3, hexSize * 0.2);
      ctx.fillStyle = marker.faction?.color ?? '#e2e8f0';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(center.x - size, center.y - size, size * 2, size * 2);
      ctx.fill();
      ctx.stroke();
    });

    const iconWidth = clamp(hexSize * 1.25, 10, 22);
    const showSymbol = iconWidth >= 12;
    const showEchelon = iconWidth >= 15;

    normalizedArmies.forEach(marker => {
      const { x, y } = gridToPixel(marker.coord, HEX_SIZE);
      const center = {
        x: x * camera.zoom + camera.offset.x,
        y: y * camera.zoom + camera.offset.y
      };
      const frameColor = marker.faction?.color ?? '#93c5fd';
      drawOtanInfantry(ctx, center, hexSize, frameColor, showSymbol, showEchelon);
    });

    const drawHighlight = (coord: HexCoord, color: string) => {
      const { x, y } = gridToPixel(coord, HEX_SIZE);
      const center = {
        x: x * camera.zoom + camera.offset.x,
        y: y * camera.zoom + camera.offset.y
      };
      drawHex(ctx, center, hexSize * 1.02, { stroke: color, lineWidth: 2 });
    };

    if (hovered) drawHighlight(hovered, 'rgba(94, 234, 212, 0.9)');
    if (selected) drawHighlight(selected, 'rgba(59, 130, 246, 0.9)');
    if (selectedArmyCoord) drawHighlight(selectedArmyCoord, 'rgba(56, 189, 248, 0.9)');

    ctx.restore();
  }, [
    activeMapConfig,
    camera.offset.x,
    camera.offset.y,
    camera.zoom,
    hovered,
    map,
    movePreview,
    normalizedArmies,
    normalizedBuildings,
    requestTerrainBuffer,
    getRenderDpr,
    isInteractionActive,
    playerFactionId,
    reachableCosts,
    selected,
    selectedArmyCoord,
    settlements,
    viewport.height,
    viewport.width
  ]);

  const scheduleDraw = useCallback(() => {
    if (drawRafRef.current !== null) {
      window.cancelAnimationFrame(drawRafRef.current);
    }

    const rafId = window.requestAnimationFrame(() => {
      drawRafRef.current = null;
      draw();
    });

    drawRafRef.current = rafId;
  }, [draw]);

  useEffect(() => {
    if (!map || resolvedMapStatus === 'missing' || resolvedMapStatus === 'error') return;

    scheduleDraw();

    return () => {
      if (drawRafRef.current !== null) {
        window.cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
    };
  }, [map, resolvedMapStatus, scheduleDraw]);

  useEffect(() => {
    // Auto-select a friendly army when clicking an occupied tile.
    if (!activeCoord) return;
    const friendly = tileArmies.map(x => x.army).find(a => a.factionId === playerFactionId) ?? null;
    setSelectedArmyId(friendly?.id ?? null);
  }, [activeCoord, playerFactionId, tileArmies]);

  const tileBuildings = useMemo(() => {
    if (!map || !activeCoord) return [];
    return normalizedBuildings.filter(entry => entry.coord.q === activeCoord.q && entry.coord.r === activeCoord.r);
  }, [activeCoord, map, normalizedBuildings]);

  const renderPlaceholder = (title: string, subtitle?: string) => (
    <div className="relative w-full h-screen bg-slate-950 text-white flex items-center justify-center">
      <div className="bg-slate-900/80 border border-slate-700 rounded-xl p-6 text-center space-y-4 max-w-lg">
        <div className="text-lg font-semibold">{title}</div>
        {subtitle && <div className="text-sm text-slate-300">{subtitle}</div>}
        <div className="flex justify-center gap-3">
          <button
            onClick={onBackToGalaxy}
            className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sm font-semibold"
          >
            {t('surfaceView.backToGalaxy')}
          </button>
          {onBackToSystem && (
            <button
              onClick={onBackToSystem}
              className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-600 text-sm font-semibold"
            >
              {t('surfaceView.backToSystem')}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  if (!system || !body) {
    return renderPlaceholder(t('surfaceView.noData'));
  }

  const isMapUnavailable = !map;
  const isMapErrored = resolvedMapStatus === 'missing' || resolvedMapStatus === 'error';
  const showLoadingOverlay = !isMapUnavailable && resolvedMapStatus === 'loading';

  if (isMapUnavailable && resolvedMapStatus === 'loading') {
    return renderPlaceholder(t('surfaceView.loadingTitle'), t('surfaceView.loadingSubtitle'));
  }

  if (isMapUnavailable || isMapErrored) {
    return renderPlaceholder(t('surfaceView.noData'));
  }

  return (
    <div className="relative w-full h-screen bg-slate-950 text-white overflow-hidden">
      <div ref={containerRef} className="absolute inset-0">
        <canvas
          ref={canvasRef}
          className={`w-full h-full touch-none ${cameraControls.isInteracting ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ touchAction: 'none' }}
          {...(pointerHandlersEnabled
            ? {
                onPointerDown: handlePointerDown,
                onPointerMove: handlePointerMove,
                onPointerUp: handlePointerUp,
                onPointerCancel: handlePointerCancel,
                onPointerLeave: (event: React.PointerEvent<HTMLCanvasElement>) => {
                  handlePointerCancel(event);
                  setHovered(null);
                }
              }
            : {})}
          {...(touchFallbackEnabled
            ? {
                onTouchStart: handleTouchStart,
                onTouchMove: handleTouchMove,
                onTouchEnd: handleTouchEnd,
                onTouchCancel: handleTouchCancel
              }
            : {})}
        />
      </div>

      {showLoadingOverlay && (
        <div className="pointer-events-none absolute inset-0 z-10 flex justify-end p-4">
          <div className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-sm font-semibold text-slate-100 shadow-lg">
            {t('surfaceView.loadingOverlay')}
          </div>
        </div>
      )}

      <div className="absolute top-4 left-4 right-4 z-10 pointer-events-none flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="pointer-events-auto rounded border border-slate-700 bg-slate-900/80 px-3 py-2 text-sm font-semibold text-slate-100 backdrop-blur">
          {t('surfaceView.bodyHeader', { name: body.name })}
        </div>
        <div className="pointer-events-auto flex justify-start sm:justify-end">
          {onBackToSystem ? (
            <button
              onClick={onBackToSystem}
              className="rounded border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-100 hover:border-slate-500 backdrop-blur"
            >
              {t('surfaceView.backToSystem')}
            </button>
          ) : (
            <button
              onClick={onBackToGalaxy}
              className="rounded border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-100 hover:border-slate-500 backdrop-blur"
            >
              {t('surfaceView.backToGalaxy')}
            </button>
          )}
        </div>
      </div>
      {touchFallbackEnabled && (
        <div className="pointer-events-none absolute top-16 right-4 z-10">
          <div className="rounded border border-slate-700 bg-slate-900/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-200 backdrop-blur">
            Touch input active
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-end">
        <div className="pointer-events-auto m-4 self-end w-full max-w-md">
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 backdrop-blur max-h-[45vh] overflow-auto md:max-h-none">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('surfaceView.tilePanel')}</p>
                {activeCoord ? (
                  <p className="text-base font-bold text-white">
                    {t('surfaceView.tileCoordinate', { q: activeCoord.q, r: activeCoord.r })}
                  </p>
                ) : (
                  <p className="text-sm text-slate-500">{t('surfaceView.hoverHint')}</p>
                )}
              </div>
              <div className="text-xs text-slate-400">
                {t('surfaceView.zoomLevel', { value: camera.zoom.toFixed(2) })}
              </div>
            </div>

            {activeTile && (
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <div className="text-slate-400 text-xs uppercase">{t('surfaceView.tileBiome')}</div>
                  <div className="font-semibold">{activeTile.biome}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs uppercase">{t('surfaceView.tileElevation')}</div>
                  <div className="font-semibold">{activeTile.elev.toFixed(0)}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs uppercase">{t('surfaceView.tileTemperature')}</div>
                  <div className="font-semibold">{(activeTile.tempC2 / 2).toFixed(1)}°C</div>
                </div>
                <div>
                  <div className="text-slate-400 text-xs uppercase">{t('surfaceView.tileMoisture')}</div>
                  <div className="font-semibold">{activeTile.moist}</div>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400" />
                {t('surfaceView.armies')}
              </div>
              {tileArmies.length === 0 ? (
                <div className="text-sm text-slate-500">{t('surfaceView.noArmies')}</div>
              ) : (
                <div className="space-y-1">
                  {tileArmies.map(marker => (
                    <div key={marker.army.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: marker.faction?.color ?? '#e2e8f0' }} />
                        <span className="font-semibold text-slate-100">{marker.faction?.name ?? marker.army.factionId}</span>
                      </div>
                      <button
                        className={`text-xs font-mono px-2 py-0.5 rounded border ${
                          marker.army.id === selectedArmyId
                            ? 'border-sky-400 text-sky-200'
                            : 'border-slate-700 text-slate-300 hover:border-slate-500'
                        }`}
                        onClick={() => setSelectedArmyId(marker.army.id)}
                        title="Select unit"
                      >
                        {marker.army.members.toFixed(0)}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {selectedArmy && (
              <div className="mt-4 border-t border-slate-800 pt-3 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Orders</div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    disabled={!onIssueCommand}
                    onClick={() => setOrderMode(prev => (prev === 'move' ? 'none' : 'move'))}
                    className={`rounded border px-3 py-2 text-xs font-semibold ${
                      orderMode === 'move' ? 'border-sky-400 bg-sky-900/40 text-sky-100' : 'border-slate-700 bg-slate-950/40 text-slate-200 hover:border-slate-500'
                    }`}
                  >
                    Move
                  </button>
                  <button
                    disabled={!onIssueCommand}
                    onClick={() => setOrderMode(prev => (prev === 'attack' ? 'none' : 'attack'))}
                    className={`rounded border px-3 py-2 text-xs font-semibold ${
                      orderMode === 'attack' ? 'border-rose-400 bg-rose-900/30 text-rose-100' : 'border-slate-700 bg-slate-950/40 text-slate-200 hover:border-slate-500'
                    }`}
                  >
                    Attack
                  </button>
                  <button
                    disabled={!onIssueCommand}
                    onClick={() => onIssueCommand?.({ type: 'CANCEL_GROUND_ORDER', armyId: selectedArmy.id })}
                    className="rounded border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={!onIssueCommand}
                    onClick={() => onIssueCommand?.({
                      type: 'SET_GROUND_POSTURE',
                      armyId: selectedArmy.id,
                      posture: selectedArmy.posture === 'prepared_defense' ? 'normal' : 'prepared_defense'
                    })}
                    className="rounded border border-slate-700 bg-slate-950/40 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500"
                  >
                    {selectedArmy.posture === 'prepared_defense' ? 'Unprepare' : 'Prepare'}
                  </button>
                </div>
                <div className="text-[11px] text-slate-400">
                  {orderMode === 'move' && 'Click a hex to set a move order.'}
                  {orderMode === 'attack' && 'Click an enemy unit hex to set an attack order.'}
                </div>

                {orderMode === 'move' && movePreview && (
                  <div className="text-[11px] text-slate-300 space-y-1">
                    <div>
                      MP: <span className="font-mono">{movePreview.mpEff}</span>{' '}
                      (<span className="text-slate-400">{movePreview.supplied ? 'supplied' : 'out of supply'}</span>)
                    </div>
                    <div>
                      Cost:{' '}
                      <span className="font-mono">
                        {movePreview.costCenti === null ? '—' : `${(movePreview.costCenti / 100).toFixed(2)} MP`}
                      </span>
                    </div>
                    {movePreview.costCenti !== null && (
                      <div className="text-slate-400">
                        Used: {((movePreview.costCenti / Math.max(1, movePreview.mpCenti)) * 100).toFixed(0)}%
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {combatPreview && (
              <div className="mt-4 border-t border-slate-800 pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Combat preview</div>
                  <div className="text-[10px] text-slate-500">
                    {combatPreview.terrainType} · R{combatPreview.range}
                  </div>
                </div>
                <div className="text-[11px] text-slate-200">
                  Target: <span className="font-mono">{combatPreview.enemy.id}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Attack power</div>
                    <div className="font-mono text-slate-100">{combatPreview.preview.attackPower.toFixed(1)}</div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Defense power</div>
                    <div className="font-mono text-slate-100">{combatPreview.preview.defensePower.toFixed(1)}</div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Loss rates</div>
                    <div className="font-mono text-slate-100">A {(combatPreview.preview.lossRateAtk * 100).toFixed(1)}%</div>
                    <div className="font-mono text-slate-100">D {(combatPreview.preview.lossRateDef * 100).toFixed(1)}%</div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Losses (est.)</div>
                    <div className="font-mono text-slate-100">A {combatPreview.preview.lossesAtkTotal}</div>
                    <div className="font-mono text-slate-100">D {combatPreview.preview.lossesDef}</div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-2">
                <span className="w-2 h-2 rounded bg-amber-400" />
                {t('surfaceView.buildings')}
              </div>
              {tileBuildings.length === 0 ? (
                <div className="text-sm text-slate-500">{t('surfaceView.noBuildings')}</div>
              ) : (
                <div className="space-y-1">
                  {tileBuildings.map(marker => (
                    <div key={marker.building.id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: marker.faction?.color ?? '#fde68a' }} />
                        <span className="font-semibold text-slate-100">
                          {marker.building.name ?? marker.building.type}
                        </span>
                      </div>
                      <div className="text-xs text-slate-300 font-mono">{marker.building.type}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SurfaceView;
