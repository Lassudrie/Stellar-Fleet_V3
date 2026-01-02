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
  StarSystem,
  SurfacePos
} from '../../../shared/types';
import { useI18n } from '../../i18n';
import { fnv1a32 } from '../../../engine/planetSurface/hash32';
import type { GameCommand } from '../../../engine/commands';
import { computeEffectiveMP } from '../../../engine/ground/movement';
import { computeSupplyDistanceMapFromSurfaceMap, isSupplied, SUPPLY_RADIUS } from '../../../engine/ground/supply';
import { computeZocSnapshotFromArmies, isInEnemyZoc } from '../../../engine/ground/zoc';
import { computeReachable, findPathWithCost } from '../../../engine/ground/pathfinding';
import { deriveTerrainTypeFromSurfaceMap, MOVE_COST } from '../../../engine/ground/terrain';
import { GROUND_UNIT_STATS } from '../../../content/data/groundUnits';
import { previewEngagement } from '../../../engine/ground/combat';
import { neighborsAxial } from '../../../engine/planetSurface/hex';
import { isPassable } from '../../../engine/planetSurface/validation';
import { hexKey as engineHexKey } from '../../../engine/ground/utils';

interface SurfaceViewProps {
  map: PlanetSurfaceMap | null;
  mapStatus?: 'idle' | 'loading' | 'ready' | 'missing' | 'error';
  system: StarSystem | null;
  body: PlanetBody | null;
  armies: Army[];
  buildings: GroundBuilding[];
  factions: FactionState[];
  playerFactionId: FactionId;
  availableBodies: PlanetBody[];
  primaryReturn?: 'GAME' | 'SYSTEM_VIEW';
  onSelectBody: (bodyId: string) => void;
  onBackToGalaxy: () => void;
  onBackToSystem?: () => void;
  onIssueCommand?: (cmd: GameCommand) => void;
}

type CameraState = { zoom: number; offset: { x: number; y: number } };

const HEX_SIZE = 12;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.6;
const CLICK_DRAG_THRESHOLD_PX = 6;
const CLICK_DRAG_THRESHOLD_SQ = CLICK_DRAG_THRESHOLD_PX * CLICK_DRAG_THRESHOLD_PX;
const PAN_MARGIN_PX = 40;

const biomeColors: Record<Biome, string> = {
  ocean: '#0ea5e9',
  coast: '#38bdf8',
  lake: '#7dd3fc',
  ice: '#cbd5e1',
  tundra: '#94a3b8',
  taiga: '#059669',
  grassland: '#a3e635',
  forest: '#16a34a',
  rainforest: '#22c55e',
  desert: '#fbbf24',
  rocky: '#d4d4d8',
  mountain: '#a8a29e',
  volcanic: '#ef4444',
  cratered: '#78350f'
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const clampAffinity = (v: number | undefined): number => clamp(v ?? 1, 0.7, 1.3);

const approxRngRange = (r0: number, eps = 0.08): { min: number; max: number } => {
  const min = r0 * ((1 - eps) / (1 + eps));
  const max = r0 * ((1 + eps) / (1 - eps));
  return { min, max };
};

const sameHex = (a: HexCoord | null, b: HexCoord | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.q === b.q && a.r === b.r;
};

const wrapQ = (q: number, w: number, wrapX: boolean): number => {
  if (!wrapX) return q;
  const m = q % w;
  return m < 0 ? m + w : m;
};

const axialToPixel = (q: number, r: number, size: number): { x: number; y: number } => ({
  x: size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r),
  y: size * (1.5 * r)
});

const pixelToAxial = (x: number, y: number, size: number): { q: number; r: number } => ({
  q: (Math.sqrt(3) / 3 * x - 1 / 3 * y) / size,
  r: (2 / 3 * y) / size
});

const roundAxial = ({ q, r }: { q: number; r: number }): HexCoord => {
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

type MapBoundsPx = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
};

const computeMapBoundsPx = (config: PlanetSurfaceMap['descriptor']['config'], size: number): MapBoundsPx => {
  // For pointy-top axial coords:
  // - center x = size * (sqrt(3)*q + sqrt(3)/2*r)
  // - center y = size * (3/2*r)
  // Hex polygon bounds from center:
  // - half width = sqrt(3)/2 * size
  // - half height = size
  const halfW = (Math.sqrt(3) / 2) * size;
  const minX = -halfW;
  const minY = -size;

  const bottomRight = axialToPixel(config.w - 1, config.h - 1, size);
  const maxX = bottomRight.x + halfW;
  const maxY = bottomRight.y + size;

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
};

const normalizePos = (pos: SurfacePos | undefined, config: PlanetSurfaceMap['descriptor']['config']): HexCoord | null => {
  if (!pos) return null;
  const q = wrapQ(Math.round(pos.q), config.w, config.wrapX);
  const r = Math.round(pos.r);
  if (r < 0 || r >= config.h) return null;
  if (!config.wrapX && (q < 0 || q >= config.w)) return null;
  return { q, r };
};

const deriveFallbackPos = (entityId: string, config: PlanetSurfaceMap['descriptor']['config']): HexCoord => {
  const hash = fnv1a32(entityId) >>> 0;
  const q = wrapQ(hash % config.w, config.w, config.wrapX);
  const r = Math.floor((hash / config.w) % config.h);
  return { q, r };
};

const getTileAt = (map: PlanetSurfaceMap, coord: HexCoord) => {
  const { w, h } = map.descriptor.config;
  if (coord.r < 0 || coord.r >= h) return null;
  const q = wrapQ(coord.q, w, map.descriptor.config.wrapX);
  if (!map.descriptor.config.wrapX && (q < 0 || q >= w)) return null;
  const index = coord.r * w + q;
  return map.tiles[index] ?? null;
};

const SurfaceView: React.FC<SurfaceViewProps> = ({
  map,
  mapStatus = 'ready',
  system,
  body,
  armies,
  buildings,
  factions,
  playerFactionId,
  availableBodies,
  primaryReturn = 'GAME',
  onSelectBody,
  onBackToGalaxy,
  onBackToSystem,
  onIssueCommand
}) => {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    didPan: boolean;
    movedSq: number;
  } | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const [camera, setCamera] = useState<CameraState>({ zoom: 1, offset: { x: 0, y: 0 } });
  const [hovered, setHovered] = useState<HexCoord | null>(null);
  const [selected, setSelected] = useState<HexCoord | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [selectedArmyId, setSelectedArmyId] = useState<string | null>(null);
  const [orderMode, setOrderMode] = useState<'none' | 'move' | 'attack'>('none');
  const [showReachable, setShowReachable] = useState(true);
  const [showZoc, setShowZoc] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const factionIndex = useMemo(() => factions.reduce<Record<FactionId, FactionState>>((acc, faction) => {
    acc[faction.id] = faction;
    return acc;
  }, {}), [factions]);

  const activeMapConfig = map?.descriptor.config ?? null;

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

  useEffect(() => {
    if (!map || !activeMapConfig) return;
    const bounds = computeMapBoundsPx(activeMapConfig, HEX_SIZE);
    setCamera({
      zoom: 1,
      offset: {
        x: (viewport.width - bounds.width) / 2 - bounds.minX,
        y: (viewport.height - bounds.height) / 2 - bounds.minY
      }
    });
    setHovered(null);
    setSelected(null);
  }, [map?.bodyId, activeMapConfig, viewport.width, viewport.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.floor(viewport.width * dpr));
    const nextHeight = Math.max(1, Math.floor(viewport.height * dpr));

    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;

    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
  }, [viewport.width, viewport.height]);

  const clampOffset = useCallback(
    (offset: { x: number; y: number }, zoom: number): { x: number; y: number } => {
      if (!activeMapConfig) return offset;

      const bounds = computeMapBoundsPx(activeMapConfig, HEX_SIZE);
      const mapW = bounds.width * zoom;
      const mapH = bounds.height * zoom;

      let x = offset.x;
      let y = offset.y;

      if (mapW <= viewport.width) {
        x = (viewport.width - mapW) / 2 - bounds.minX * zoom;
      } else {
        const minX = viewport.width - PAN_MARGIN_PX - bounds.maxX * zoom;
        const maxX = PAN_MARGIN_PX - bounds.minX * zoom;
        x = clamp(x, minX, maxX);
      }

      if (mapH <= viewport.height) {
        y = (viewport.height - mapH) / 2 - bounds.minY * zoom;
      } else {
        const minY = viewport.height - PAN_MARGIN_PX - bounds.maxY * zoom;
        const maxY = PAN_MARGIN_PX - bounds.minY * zoom;
        y = clamp(y, minY, maxY);
      }

      return { x, y };
    },
    [activeMapConfig, viewport.height, viewport.width]
  );

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

  const occupancy = useMemo(() => {
    if (!map) return new Set<string>();
    const set = new Set<string>();
    normalizedArmies.forEach(m => set.add(engineHexKey(m.coord)));
    return set;
  }, [map, normalizedArmies]);

  const pickCoord = useCallback((clientX: number, clientY: number): HexCoord | null => {
    if (!map) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const worldX = (x - camera.offset.x) / camera.zoom;
    const worldY = (y - camera.offset.y) / camera.zoom;

    const bounds = computeMapBoundsPx(map.descriptor.config, HEX_SIZE);
    if (worldX < bounds.minX || worldX > bounds.maxX || worldY < bounds.minY || worldY > bounds.maxY) return null;

    const axial = pixelToAxial(worldX, worldY, HEX_SIZE);
    const rounded = roundAxial(axial);
    const normalized = normalizePos({ ...rounded, bodyId: map.bodyId }, map.descriptor.config);
    return normalized;
  }, [camera.offset.x, camera.offset.y, camera.zoom, map]);

  const drawHex = (
    ctx: CanvasRenderingContext2D,
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

  // draw() is defined later, after overlay computations.

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    if (!map) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const focusX = event.clientX - rect.left;
    const focusY = event.clientY - rect.top;
    const zoomFactor = event.deltaY < 0 ? 1.1 : 0.9;

    setCamera(prev => {
      const nextZoom = clamp(prev.zoom * zoomFactor, MIN_ZOOM, MAX_ZOOM);
      const scale = nextZoom / prev.zoom;
      const nextOffset = {
        x: focusX - (focusX - prev.offset.x) * scale,
        y: focusY - (focusY - prev.offset.y) * scale
      };
      return {
        zoom: nextZoom,
        offset: {
          ...clampOffset(nextOffset, nextZoom)
        }
      };
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: camera.offset.x,
      offsetY: camera.offset.y,
      didPan: false,
      movedSq: 0
    };
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current && panRef.current.pointerId === event.pointerId) {
      const dx = event.clientX - panRef.current.startX;
      const dy = event.clientY - panRef.current.startY;
      const movedSq = dx * dx + dy * dy;

      panRef.current.movedSq = movedSq;

      if (!panRef.current.didPan && movedSq >= CLICK_DRAG_THRESHOLD_SQ) {
        panRef.current.didPan = true;
        setIsPanning(true);
      }

      if (panRef.current.didPan) {
        const nextOffset = {
          x: panRef.current.offsetX + dx,
          y: panRef.current.offsetY + dy
        };

        setCamera(prev => ({
          ...prev,
          offset: clampOffset(nextOffset, prev.zoom)
        }));
      }
      return;
    }

    if (!map) return;

    const coord = pickCoord(event.clientX, event.clientY);
    setHovered(prev => (sameHex(prev, coord) ? prev : coord));
  };

  const clearPan = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!panRef.current) return;
    if (event.pointerId !== panRef.current.pointerId) return;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture can already be released/canceled; ignore.
    }
    panRef.current = null;
    setIsPanning(false);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      const isClick = !pan.didPan && pan.movedSq < CLICK_DRAG_THRESHOLD_SQ;

      clearPan(event);

      if (isClick && map) {
        const coord = pickCoord(event.clientX, event.clientY);
        setSelected(coord);

        // If the user is issuing an order, treat the click as a target selection.
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
      }
      return;
    }

    clearPan(event);
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
      mapByFaction.set(fid, computeSupplyDistanceMapFromSurfaceMap(map, buildings, fid));
    });
    return mapByFaction;
  }, [buildings, map, normalizedArmies]);

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

  const enemyZocMask = useMemo(() => {
    if (!map || !zocSnapshot) return null;
    const { w, h } = map.descriptor.config;
    const mask = new Uint8Array(w * h);
    for (const [factionId, arr] of zocSnapshot.zocByFactionId.entries()) {
      if (factionId === playerFactionId) continue;
      for (let i = 0; i < mask.length; i += 1) {
        if (arr[i]) mask[i] = 1;
      }
    }
    return mask;
  }, [map, playerFactionId, zocSnapshot]);

  const movementStepCostCenti = useCallback((from: HexCoord, to: HexCoord, army: Army): number => {
    if (!map || !zocSnapshot) return 0;
    const terrain = deriveTerrainTypeFromSurfaceMap(map, buildings, to);
    const baseCost = MOVE_COST[terrain];
    const affinity = clampAffinity(GROUND_UNIT_STATS[army.unitType].terrainMoveAffinity[terrain]);
    let cost = Math.round(baseCost * affinity * 100);

    const curEnemy = isInEnemyZoc(zocSnapshot, from, army.factionId);
    const nextEnemy = isInEnemyZoc(zocSnapshot, to, army.factionId);
    if (!curEnemy && nextEnemy) cost += 100;
    if (curEnemy && !nextEnemy) cost += 100;

    return cost;
  }, [buildings, map, zocSnapshot]);

  const movePreview = useMemo(() => {
    if (!map || !selectedArmy || !selectedArmyCoord || !hovered) return null;
    if (orderMode !== 'move') return null;
    if (!zocSnapshot) return null;

    const supplied = isArmySupplied(selectedArmy, selectedArmyCoord);
    const mpEff = computeEffectiveMP(selectedArmy, supplied);
    const mpCenti = mpEff * 100;

    const blocked = (c: HexCoord): boolean => {
      if (c.q === selectedArmyCoord.q && c.r === selectedArmyCoord.r) return false;
      return occupancy.has(engineHexKey(c));
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
    return { path: res.path, costCenti: res.costCenti, mpEff, mpCenti, supplied };
  }, [hovered, isArmySupplied, map, movementStepCostCenti, occupancy, orderMode, selectedArmy, selectedArmyCoord, zocSnapshot]);

  const reachableCosts = useMemo(() => {
    if (!map || !selectedArmy || !selectedArmyCoord || !showReachable) return null;
    if (!zocSnapshot) return null;
    const supplied = isArmySupplied(selectedArmy, selectedArmyCoord);
    const mpEff = computeEffectiveMP(selectedArmy, supplied);
    const mpCenti = mpEff * 100;
    const blocked = (c: HexCoord): boolean => {
      if (c.q === selectedArmyCoord.q && c.r === selectedArmyCoord.r) return false;
      return occupancy.has(engineHexKey(c));
    };
    return computeReachable({
      from: selectedArmyCoord,
      w: map.descriptor.config.w,
      h: map.descriptor.config.h,
      wrapX: map.descriptor.config.wrapX,
      isBlocked: blocked,
      stepCostCenti: (a, b) => movementStepCostCenti(a, b, selectedArmy),
      maxCostCenti: mpCenti
    });
  }, [isArmySupplied, map, movementStepCostCenti, occupancy, selectedArmy, selectedArmyCoord, showReachable, zocSnapshot]);

  const combatPreview = useMemo(() => {
    if (!map || !selectedArmy || !selectedArmyCoord || !hovered || !showPreview) return null;

    const enemy = normalizedArmies
      .filter(m => m.coord.q === hovered.q && m.coord.r === hovered.r)
      .map(m => m.army)
      .find(a => a.factionId !== playerFactionId);
    if (!enemy) return null;
    if (!enemy.surfacePos) return null;

    const adjacent = neighborsAxial(selectedArmyCoord, map.descriptor.config.w, map.descriptor.config.h, map.descriptor.config.wrapX)
      .some(n => n.q === hovered.q && n.r === hovered.r);
    if (!adjacent) return null;

    const terrainType = deriveTerrainTypeFromSurfaceMap(map, buildings, hovered);
    const suppliedAtt = isArmySupplied(selectedArmy, selectedArmyCoord);
    const suppliedDef = isArmySupplied(enemy, hovered);

    const preview = previewEngagement(selectedArmy, enemy, {
      turn: 0,
      terrainType,
      attackerStatus: { outOfSupply: !suppliedAtt },
      defenderStatus: { outOfSupply: !suppliedDef }
    });

    const rRange = approxRngRange(preview.r, 0.08);
    return { enemy, terrainType, preview, rRange };
  }, [buildings, hovered, isArmySupplied, map, normalizedArmies, playerFactionId, selectedArmy, selectedArmyCoord, showPreview]);

  const draw = useCallback(() => {
    if (!map || !activeMapConfig) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    const hexSize = HEX_SIZE * camera.zoom;
    const gridStroke = 'rgba(148, 163, 184, 0.22)';

    for (let r = 0; r < activeMapConfig.h; r += 1) {
      for (let q = 0; q < activeMapConfig.w; q += 1) {
        const tile = map.tiles[r * activeMapConfig.w + q];
        if (!tile) continue;
        const { x, y } = axialToPixel(q, r, HEX_SIZE);
        const center = {
          x: x * camera.zoom + camera.offset.x,
          y: y * camera.zoom + camera.offset.y
        };
        const color = biomeColors[tile.biome] ?? '#334155';
        drawHex(ctx, center, hexSize, { fill: color, stroke: gridStroke, lineWidth: 0.75 });
      }
    }

    // --- Overlays ---
    if (showZoc && enemyZocMask) {
      for (let r = 0; r < activeMapConfig.h; r += 1) {
        for (let q = 0; q < activeMapConfig.w; q += 1) {
          const idx = r * activeMapConfig.w + q;
          if (!enemyZocMask[idx]) continue;
          const { x, y } = axialToPixel(q, r, HEX_SIZE);
          const center = { x: x * camera.zoom + camera.offset.x, y: y * camera.zoom + camera.offset.y };
          drawHex(ctx, center, hexSize, { fill: 'rgba(244, 63, 94, 0.10)' });
        }
      }
    }

    if (reachableCosts) {
      reachableCosts.forEach((_cost, key) => {
        const [qStr, rStr] = key.split('|');
        const q = Number(qStr);
        const r = Number(rStr);
        if (!Number.isFinite(q) || !Number.isFinite(r)) return;
        const tile = map.tiles[r * activeMapConfig.w + q];
        if (!tile || !isPassable(tile.biome)) return;
        const { x, y } = axialToPixel(q, r, HEX_SIZE);
        const center = { x: x * camera.zoom + camera.offset.x, y: y * camera.zoom + camera.offset.y };
        drawHex(ctx, center, hexSize, { fill: 'rgba(56, 189, 248, 0.10)' });
      });
    }

    if (movePreview?.path && movePreview.path.length > 1) {
      ctx.beginPath();
      movePreview.path.forEach((c, i) => {
        const { x, y } = axialToPixel(c.q, c.r, HEX_SIZE);
        const px = x * camera.zoom + camera.offset.x;
        const py = y * camera.zoom + camera.offset.y;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
      ctx.lineWidth = Math.max(2, hexSize * 0.08);
      ctx.stroke();
    }

    settlements.forEach(settlement => {
      const { x, y } = axialToPixel(settlement.coord.q, settlement.coord.r, HEX_SIZE);
      const center = {
        x: x * camera.zoom + camera.offset.x,
        y: y * camera.zoom + camera.offset.y
      };
      ctx.beginPath();
      ctx.fillStyle = settlement.factionId ? (factionIndex[settlement.factionId]?.color ?? '#fcd34d') : '#fcd34d';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      ctx.arc(center.x, center.y, Math.max(3, hexSize * 0.18), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    normalizedBuildings.forEach(marker => {
      const { x, y } = axialToPixel(marker.coord.q, marker.coord.r, HEX_SIZE);
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

    normalizedArmies.forEach(marker => {
      const { x, y } = axialToPixel(marker.coord.q, marker.coord.r, HEX_SIZE);
      const center = {
        x: x * camera.zoom + camera.offset.x,
        y: y * camera.zoom + camera.offset.y
      };
      const radius = Math.max(3.5, hexSize * 0.22);
      ctx.beginPath();
      ctx.fillStyle = marker.faction?.color ?? '#93c5fd';
      ctx.strokeStyle = marker.army.factionId === playerFactionId ? '#bfdbfe' : '#0f172a';
      ctx.lineWidth = 1.2;
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    const drawHighlight = (coord: HexCoord, color: string) => {
      const { x, y } = axialToPixel(coord.q, coord.r, HEX_SIZE);
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
    enemyZocMask,
    factionIndex,
    hovered,
    map,
    movePreview,
    normalizedArmies,
    normalizedBuildings,
    playerFactionId,
    reachableCosts,
    selected,
    selectedArmyCoord,
    settlements,
    showZoc,
    viewport.height,
    viewport.width
  ]);

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      drawRafRef.current = null;
      draw();
    });

    drawRafRef.current = rafId;

    return () => {
      if (drawRafRef.current !== null) {
        window.cancelAnimationFrame(drawRafRef.current);
        drawRafRef.current = null;
      }
    };
  }, [draw]);

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

  const resolvedMapStatus = mapStatus === 'idle' ? 'loading' : mapStatus;

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

  if (resolvedMapStatus === 'loading') {
    return renderPlaceholder(t('surfaceView.loadingTitle'), t('surfaceView.loadingSubtitle'));
  }

  if (!map || resolvedMapStatus === 'missing' || resolvedMapStatus === 'error') {
    return (
      renderPlaceholder(t('surfaceView.noData'))
    );
  }

  const mapBoundsPx = computeMapBoundsPx(map.descriptor.config, HEX_SIZE);
  const primaryButtonClasses = (target: 'GAME' | 'SYSTEM_VIEW') =>
    `rounded border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
      primaryReturn === target
        ? 'bg-sky-700 text-white border-sky-400'
        : 'bg-slate-800 text-slate-100 border-slate-600 hover:border-slate-400'
    }`;

  return (
    <div className="relative w-full h-screen bg-slate-950 text-white overflow-hidden">
      <div ref={containerRef} className="absolute inset-0">
        <canvas
          ref={canvasRef}
          className={`w-full h-full touch-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={clearPan}
          onPointerLeave={(event) => {
            clearPan(event);
            setHovered(null);
          }}
        />
      </div>

      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
        <div className="pointer-events-auto m-4 p-4 bg-slate-900/80 border border-slate-700 rounded-xl backdrop-blur max-w-4xl">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">{t('surfaceView.header')}</p>
              <div className="text-2xl font-bold flex items-center gap-2">
                <span>{body.name}</span>
                <span className="text-slate-400 text-base">/ {system.name}</span>
              </div>
              <p className="text-xs text-slate-400">
                {t('surfaceView.mapSize', { width: map.descriptor.config.w, height: map.descriptor.config.h })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={body.id}
                onChange={(event) => onSelectBody(event.target.value)}
                className="rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100"
              >
                {availableBodies.map(entry => (
                  <option key={entry.id} value={entry.id}>{entry.name}</option>
                ))}
              </select>

              {onBackToSystem && (
                <button onClick={onBackToSystem} className={primaryButtonClasses('SYSTEM_VIEW')}>
                  {t('surfaceView.backToSystem')}
                </button>
              )}
              <button onClick={onBackToGalaxy} className={primaryButtonClasses('GAME')}>
                {t('surfaceView.backToGalaxy')}
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => {
                const focusX = viewport.width / 2;
                const focusY = viewport.height / 2;
                setCamera(prev => {
                  const nextZoom = clamp(prev.zoom * 1.15, MIN_ZOOM, MAX_ZOOM);
                  const scale = nextZoom / prev.zoom;
                  const nextOffset = {
                    x: focusX - (focusX - prev.offset.x) * scale,
                    y: focusY - (focusY - prev.offset.y) * scale
                  };
                  return { zoom: nextZoom, offset: clampOffset(nextOffset, nextZoom) };
                });
              }}
              className="rounded bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide hover:border-slate-400"
            >
              {t('surfaceView.zoomIn')}
            </button>
            <button
              onClick={() => {
                const focusX = viewport.width / 2;
                const focusY = viewport.height / 2;
                setCamera(prev => {
                  const nextZoom = clamp(prev.zoom / 1.15, MIN_ZOOM, MAX_ZOOM);
                  const scale = nextZoom / prev.zoom;
                  const nextOffset = {
                    x: focusX - (focusX - prev.offset.x) * scale,
                    y: focusY - (focusY - prev.offset.y) * scale
                  };
                  return { zoom: nextZoom, offset: clampOffset(nextOffset, nextZoom) };
                });
              }}
              className="rounded bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide hover:border-slate-400"
            >
              {t('surfaceView.zoomOut')}
            </button>
            <button
              onClick={() => {
                const { width, height, minX, minY } = mapBoundsPx;
                const nextOffset = {
                  x: (viewport.width - width) / 2 - minX,
                  y: (viewport.height - height) / 2 - minY
                };
                setCamera({ zoom: 1, offset: clampOffset(nextOffset, 1) });
              }}
              className="rounded bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide hover:border-slate-400"
            >
              {t('surfaceView.resetView')}
            </button>
            <button
              onClick={() => setShowReachable(v => !v)}
              className={`rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                showReachable ? 'bg-sky-800/60 border-sky-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-100 hover:border-slate-400'
              }`}
            >
              Reachable
            </button>
            <button
              onClick={() => setShowZoc(v => !v)}
              className={`rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                showZoc ? 'bg-rose-900/40 border-rose-400 text-white' : 'bg-slate-800 border-slate-700 text-slate-100 hover:border-slate-400'
              }`}
            >
              ZOC
            </button>
            <button
              onClick={() => setShowPreview(v => !v)}
              className={`rounded border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                showPreview ? 'bg-emerald-900/30 border-emerald-400 text-white' : 'bg-slate-800 border-slate-700 text-slate-100 hover:border-slate-400'
              }`}
            >
              Preview
            </button>
          </div>
        </div>

        <div className="pointer-events-auto m-4 self-end w-full max-w-md">
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 backdrop-blur">
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
                  <div className="text-[10px] text-slate-500">{combatPreview.terrainType}</div>
                </div>
                <div className="text-[11px] text-slate-200">
                  Target: <span className="font-mono">{combatPreview.enemy.id}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">R (mean)</div>
                    <div className="font-mono text-slate-100">{combatPreview.preview.r.toFixed(2)}</div>
                    <div className="text-slate-500 font-mono">
                      [{combatPreview.rRange.min.toFixed(2)}..{combatPreview.rRange.max.toFixed(2)}]
                    </div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">BreakChance</div>
                    <div className="font-mono text-slate-100">{(combatPreview.preview.breakChance * 100).toFixed(1)}%</div>
                    <div className="text-slate-500">defender</div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">Losses (est.)</div>
                    <div className="font-mono text-slate-100">A {combatPreview.preview.lossesAtt}</div>
                    <div className="font-mono text-slate-100">D {combatPreview.preview.lossesDef}</div>
                  </div>
                  <div className="bg-slate-950/40 border border-slate-800 rounded p-2">
                    <div className="text-slate-400">K</div>
                    <div className="font-mono text-slate-100">A {combatPreview.preview.kAtt.kFinal.toFixed(2)}</div>
                    <div className="font-mono text-slate-100">D {combatPreview.preview.kDef.kFinal.toFixed(2)}</div>
                  </div>
                </div>
                <details className="text-[11px] text-slate-300">
                  <summary className="cursor-pointer text-slate-400">K breakdown</summary>
                  <div className="mt-2 space-y-1">
                    <div className="font-semibold text-slate-200">Attacker</div>
                    <div className="font-mono text-slate-300">
                      terrainBase={combatPreview.preview.kAtt.kTerrainBase.toFixed(2)} affinity={combatPreview.preview.kAtt.kAffinity.toFixed(2)} situation={combatPreview.preview.kAtt.kSituationClamped.toFixed(2)} status={combatPreview.preview.kAtt.kStatusClamped.toFixed(2)} final={combatPreview.preview.kAtt.kFinal.toFixed(2)}
                    </div>
                    <div className="font-semibold text-slate-200 mt-2">Defender</div>
                    <div className="font-mono text-slate-300">
                      terrainBase={combatPreview.preview.kDef.kTerrainBase.toFixed(2)} affinity={combatPreview.preview.kDef.kAffinity.toFixed(2)} situation={combatPreview.preview.kDef.kSituationClamped.toFixed(2)} status={combatPreview.preview.kDef.kStatusClamped.toFixed(2)} final={combatPreview.preview.kDef.kFinal.toFixed(2)}
                    </div>
                  </div>
                </details>
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
