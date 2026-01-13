import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import {
  Army,
  ArmyState,
  FeatureBits,
  FactionId,
  FactionState,
  Fleet,
  GroundBuilding,
  HexCoord,
  PlanetBody,
  PlanetSurfaceMap,
  Settlement,
  SettlementControlState,
  StarSystem,
  sorted
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
import { isFleetOrbitingSystem } from '../../../engine/orbit';
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
  sameHex,
  surfaceMapKey,
  PAN_MARGIN_PX
} from './surfaceViewCore';
import {
  CameraState,
  SurfaceMapCameraSync,
  SurfaceTerrainLayer,
  drawSurfaceOverlay
} from './surfaceViewLayers';
import {
  SurfaceViewHud,
  SurfaceCombatPreview,
  SurfaceMovePreview
} from './surfaceViewHud';

interface SurfaceViewProps {
  map: PlanetSurfaceMap | null;
  mapStatus?: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  system: StarSystem | null;
  body: PlanetBody | null;
  armies: Army[];
  fleets: Fleet[];
  buildings: GroundBuilding[];
  settlementControl?: Record<string, SettlementControlState>;
  factions: FactionState[];
  playerFactionId: FactionId;
  onBackToGalaxy: () => void;
  onBackToSystem?: () => void;
  onIssueCommand?: (cmd: GameCommand) => void;
}

type WheelInput = { clientX: number; clientY: number; deltaY: number; currentTarget: EventTarget | null };
type PointerSnapshot = {
  pointerId: number;
  clientX: number;
  clientY: number;
  pointerType: string;
  currentTarget: HTMLCanvasElement;
};

const INTERACTION_COOLDOWN_MS = 140;
// Surface view is a 2D tactical map: favor crispness over aggressive DPR caps (especially on mobile).
const MAX_DPR_MOBILE = 2.5;
const MAX_DPR_DESKTOP = 2.5;

const SurfaceView: React.FC<SurfaceViewProps> = ({
  map: mapProp,
  mapStatus = 'ready',
  system,
  body,
  armies,
  fleets,
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
  const [landingArmyId, setLandingArmyId] = useState<string | null>(null);
  const [orderMode, setOrderMode] = useState<'none' | 'move' | 'attack' | 'land'>('none');
  const [readyMapCache, setReadyMapCache] = useState<{ key: string; map: PlanetSurfaceMap } | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const pointerMoveFrameRef = useRef<number | null>(null);
  const interactionDeadlineRef = useRef(0);
  const pendingWheelEvent = useRef<WheelInput | null>(null);
  const pendingPointerEvents = useRef<Map<number, PointerSnapshot>>(new Map());

  const factionIndex = useMemo(() => factions.reduce<Record<FactionId, FactionState>>((acc, faction) => {
    acc[faction.id] = faction;
    return acc;
  }, {}), [factions]);

  const fleetById = useMemo(() => {
    const next = new Map<string, Fleet>();
    fleets.forEach(fleet => {
      next.set(fleet.id, fleet);
    });
    return next;
  }, [fleets]);

  const planetNameById = useMemo(() => {
    const next = new Map<string, string>();
    system?.planets.forEach(planet => {
      next.set(planet.id, planet.name);
    });
    return next;
  }, [system?.planets]);

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

  useEffect(() => {
    setOrderMode('none');
  }, [selectedArmyId]);

  useEffect(() => {
    setLandingArmyId(null);
  }, [body?.id]);

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
  const pointerHandlersEnabled = supportsPointerEvents;
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

  const plannedLandings = useMemo(() => {
    if (!map || !activeMapConfig) return [];
    return armies
      .filter(army => army.state === ArmyState.EMBARKED && army.landingOrder?.type === 'land' && army.landingOrder.to.bodyId === map.bodyId)
      .map(army => {
        const coord =
          normalizePos(army.landingOrder?.to, activeMapConfig) ??
          deriveFallbackPos(`${army.id}:land`, activeMapConfig);
        return {
          army,
          coord,
          faction: factionIndex[army.factionId]
        };
      });
  }, [activeMapConfig, armies, factionIndex, map]);

  const landingCandidates = useMemo(() => {
    if (!system) return [];
    const entries: Array<{
      army: Army;
      plannedBodyId: string | null;
      plannedBodyName: string | null;
      plannedPos: { q: number; r: number } | null;
      faction?: FactionState;
    }> = [];

    armies.forEach(army => {
      if (army.state !== ArmyState.EMBARKED) return;
      if (army.factionId !== playerFactionId) return;

      const fleet = fleetById.get(army.containerId);
      if (!fleet || !isFleetOrbitingSystem(fleet, system)) return;

      let plannedBodyId: string | null = null;
      let plannedBodyName: string | null = null;
      let plannedPos: { q: number; r: number } | null = null;

      if (army.landingOrder?.type === 'land') {
        plannedBodyId = army.landingOrder.to.bodyId;
        plannedBodyName = planetNameById.get(plannedBodyId) ?? plannedBodyId;
        if (plannedBodyId === body?.id && activeMapConfig) {
          const normalized = normalizePos(army.landingOrder.to, activeMapConfig) ?? army.landingOrder.to;
          plannedPos = { q: normalized.q, r: normalized.r };
        }
      }

      entries.push({
        army,
        plannedBodyId,
        plannedBodyName,
        plannedPos,
        faction: factionIndex[army.factionId]
      });
    });

    return sorted(entries, (a, b) => a.army.id.localeCompare(b.army.id));
  }, [activeMapConfig, armies, body?.id, factionIndex, fleetById, planetNameById, playerFactionId, system]);

  const selectedLanding = useMemo(() => {
    if (!landingArmyId) return null;
    return landingCandidates.find(entry => entry.army.id === landingArmyId) ?? null;
  }, [landingArmyId, landingCandidates]);

  useEffect(() => {
    if (orderMode === 'land' && !selectedLanding) {
      setOrderMode('none');
    }
  }, [orderMode, selectedLanding]);

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

  const shouldIgnorePointerEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!touchFallbackEnabled) return false;
    if (event.pointerType !== 'touch') return false;
    return (event as unknown as { nativeEvent?: unknown }).nativeEvent != null;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    userCameraRef.current = true;
    if (shouldIgnorePointerEvent(event)) {
      event.preventDefault();
      return;
    }
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    cameraControls.handlePointerDown(event);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (shouldIgnorePointerEvent(event)) {
      event.preventDefault();
      return;
    }
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
    if (shouldIgnorePointerEvent(event)) {
      event.preventDefault();
      return;
    }
    if (event.pointerType === 'touch') {
      event.preventDefault();
    }
    // Clean up pending moves for this pointer
    pendingPointerEvents.current.delete(event.pointerId);
    
    const wasTap = cameraControls.handlePointerUp(event);
    if (!wasTap || !map) return;

    const coord = pickCoord(event.clientX, event.clientY);

    if (orderMode !== 'none') {
      if (orderMode === 'land') {
        if (coord && onIssueCommand && body && selectedLanding) {
          onIssueCommand({
            type: 'ORDER_GROUND_LAND',
            armyId: selectedLanding.army.id,
            to: { bodyId: body.id, q: coord.q, r: coord.r }
          });
        }
        return;
      }

      if (coord && onIssueCommand && selectedArmyId && body) {
        const selectedArmy = armies.find(a => a.id === selectedArmyId) ?? null;
        const canControl = selectedArmy?.factionId === playerFactionId;
        if (canControl && selectedArmy && selectedArmy.state === ArmyState.DEPLOYED && selectedArmy.containerId === body.id) {
          if (orderMode === 'move') {
            onIssueCommand({ type: 'ORDER_GROUND_MOVE', armyId: selectedArmyId, to: { bodyId: body.id, q: coord.q, r: coord.r } });
            setOrderMode('none');
          } else if (orderMode === 'attack') {
            const target = normalizedArmies
              .filter(m => m.coord.q === coord.q && m.coord.r === coord.r)
              .map(m => m.army)
              .find(a => a.factionId !== selectedArmy.factionId);
            if (target) {
              onIssueCommand({ type: 'ORDER_GROUND_ATTACK', attackerId: selectedArmyId, targetArmyId: target.id });
              setOrderMode('none');
            }
          }
        }
      }
      return;
    }

    setSelected(coord);
    if (coord) {
      const friendly = normalizedArmies
        .filter(m => m.coord.q === coord.q && m.coord.r === coord.r)
        .map(m => m.army)
        .find(a => a.factionId === playerFactionId);
      if (friendly) setSelectedArmyId(friendly.id);
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // Pointer cancel often fires when the browser takes over the gesture; do not disable the touch fallback because of it.
    if (shouldIgnorePointerEvent(event)) {
      event.preventDefault();
      return;
    }
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

  const tilePlannedLandings = useMemo(() => {
    if (!map || !activeCoord) return [];
    return plannedLandings.filter(entry => entry.coord.q === activeCoord.q && entry.coord.r === activeCoord.r);
  }, [activeCoord, map, plannedLandings]);

  const handleSelectLanding = useCallback((armyId: string) => {
    if (orderMode === 'land' && landingArmyId === armyId) {
      setOrderMode('none');
      return;
    }
    setLandingArmyId(armyId);
    setOrderMode('land');
  }, [landingArmyId, orderMode]);

  const selectedArmy = useMemo(() => {
    if (!selectedArmyId) return null;
    const army = armies.find(a => a.id === selectedArmyId) ?? null;
    if (!army) return null;
    if (army.state !== ArmyState.DEPLOYED) return null;
    if (!body || army.containerId !== body.id) return null;
    return army;
  }, [armies, body, selectedArmyId]);

  const canControlSelectedArmy = selectedArmy?.factionId === playerFactionId;

  useEffect(() => {
    if (orderMode === 'land') return;
    if (orderMode !== 'none' && (!selectedArmy || !canControlSelectedArmy)) {
      setOrderMode('none');
    }
  }, [canControlSelectedArmy, orderMode, selectedArmy]);

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

  const movementStepCostCenti = useCallback((_from: HexCoord, to: HexCoord, army: Army): number => {
    if (!map) return 0;
    const { w } = map.descriptor.config;
    const tile = map.tiles[to.r * w + to.q];
    const featureBits = tile?.featureBits ?? 0;
    const hasRoad = (featureBits & FeatureBits.Road) !== 0;
    const hasRiver = (featureBits & FeatureBits.River) !== 0;
    const terrain = deriveTerrainTypeFromSurfaceMap(map, buildings, to);
    const baseCost = hasRoad ? 1 : MOVE_COST[terrain];
    const affinity = clampAffinity(GROUND_UNIT_STATS[army.unitType].terrainMoveAffinity[terrain]);
    let cost = Math.max(1, Math.round(baseCost * affinity * 100));
    if (hasRiver) cost += 100;

    const key = engineHexKey(to);
    const occupants = occupancyByHex.get(key) ?? [];
    const friendlyCount = occupants.filter(occupant => occupant.factionId === army.factionId && occupant.id !== army.id).length;
    if (friendlyCount > 0) cost *= 2;

    return cost;
  }, [buildings, map, occupancyByHex]);

  const movePreview = useMemo<SurfaceMovePreview | null>(() => {
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

  const combatPreview = useMemo<SurfaceCombatPreview | null>(() => {
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
  const renderDpr = useMemo(() => getRenderDpr(), [getRenderDpr]);

  const draw = useCallback(() => {
    if (!map || !activeMapConfig) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawSurfaceOverlay(ctx, {
      map,
      activeMapConfig,
      camera,
      viewport,
      renderDpr,
      hovered,
      selected,
      selectedArmyCoord,
      movePreviewPath: movePreview?.path ?? null,
      reachableCosts,
      armyMarkers: normalizedArmies,
      buildingMarkers: normalizedBuildings,
      landingMarkers: plannedLandings,
      settlements,
      showLabels: !isInteractionActive()
    });
  }, [
    activeMapConfig,
    camera,
    hovered,
    isInteractionActive,
    map,
    movePreview,
    normalizedArmies,
    normalizedBuildings,
    plannedLandings,
    reachableCosts,
    renderDpr,
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
        <Canvas
          orthographic
          frameloop="demand"
          dpr={renderDpr}
          gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          <SurfaceMapCameraSync cameraState={camera} />
          {map && currentMapKey && <SurfaceTerrainLayer key={currentMapKey} map={map} mapKey={currentMapKey} />}
        </Canvas>

        <canvas
          ref={canvasRef}
          className={`absolute inset-0 w-full h-full touch-none ${cameraControls.isInteracting ? 'cursor-grabbing' : 'cursor-grab'}`}
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

      <SurfaceViewHud
        bodyName={body.name}
        onBackToGalaxy={onBackToGalaxy}
        onBackToSystem={onBackToSystem}
        showLoadingOverlay={showLoadingOverlay}
        showTouchBadge={touchFallbackEnabled}
        activeCoord={activeCoord}
        activeTile={activeTile}
        cameraZoom={camera.zoom}
        tileArmies={tileArmies}
        landingCandidates={landingCandidates}
        selectedLanding={selectedLanding}
        landingArmyId={landingArmyId}
        orderMode={orderMode}
        onSelectLanding={handleSelectLanding}
        onSelectArmy={(armyId) => setSelectedArmyId(armyId)}
        selectedArmy={selectedArmy}
        selectedArmyId={selectedArmyId}
        canControlSelectedArmy={canControlSelectedArmy}
        movePreview={movePreview}
        combatPreview={combatPreview}
        tilePlannedLandings={tilePlannedLandings}
        plannedLandingsCount={plannedLandings.length}
        tileBuildings={tileBuildings}
        onIssueCommand={onIssueCommand}
        setOrderMode={setOrderMode}
        playerFactionId={playerFactionId}
      />
    </div>
  );
};

export default SurfaceView;
