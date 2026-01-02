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
}

type CameraState = { zoom: number; offset: { x: number; y: number } };

const HEX_SIZE = 12;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.6;

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

const computeMapSizePx = (config: PlanetSurfaceMap['descriptor']['config'], size: number) => {
  const width = Math.sqrt(3) * size * (config.w + 0.5);
  const height = size * 1.5 * (config.h - 1) + size * 2;
  return { width, height };
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
  onBackToSystem
}) => {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 720 });
  const [camera, setCamera] = useState<CameraState>({ zoom: 1, offset: { x: 0, y: 0 } });
  const [hovered, setHovered] = useState<HexCoord | null>(null);
  const [selected, setSelected] = useState<HexCoord | null>(null);
  const [isPanning, setIsPanning] = useState(false);

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
    const { width, height } = computeMapSizePx(activeMapConfig, HEX_SIZE);
    setCamera({
      zoom: 1,
      offset: {
        x: (viewport.width - width) / 2,
        y: (viewport.height - height) / 2
      }
    });
    setHovered(null);
    setSelected(null);
  }, [map?.bodyId, activeMapConfig, viewport.width, viewport.height]);

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

  const pickCoord = useCallback((clientX: number, clientY: number): HexCoord | null => {
    if (!map) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const worldX = (x - camera.offset.x) / camera.zoom;
    const worldY = (y - camera.offset.y) / camera.zoom;
    const axial = pixelToAxial(worldX, worldY, HEX_SIZE);
    const rounded = roundAxial(axial);
    const normalized = normalizePos({ ...rounded, bodyId: map.bodyId }, map.descriptor.config);
    return normalized;
  }, [camera.offset.x, camera.offset.y, camera.zoom, map]);

  const drawHex = (ctx: CanvasRenderingContext2D, center: { x: number; y: number }, size: number, options: { fill?: string; stroke?: string }) => {
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
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
  };

  const draw = useCallback(() => {
    if (!map || !activeMapConfig) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, viewport.width, viewport.height);

    const hexSize = HEX_SIZE * camera.zoom;
    const gridStroke = 'rgba(148, 163, 184, 0.22)';

    for (let r = 0; r < activeMapConfig.h; r += 1) {
      for (let q = 0; q < activeMapConfig.w; q += 1) {
        const tile = map.tiles[r * activeMapConfig.w + q];
        const { x, y } = axialToPixel(q, r, HEX_SIZE);
        const center = {
          x: x * camera.zoom + camera.offset.x,
          y: y * camera.zoom + camera.offset.y
        };
        const color = biomeColors[tile.biome] ?? '#334155';
        drawHex(ctx, center, hexSize, { fill: color, stroke: gridStroke });
      }
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
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      drawHex(ctx, center, hexSize * 1.02, { stroke: color });
    };

    if (hovered) drawHighlight(hovered, 'rgba(94, 234, 212, 0.9)');
    if (selected) drawHighlight(selected, 'rgba(59, 130, 246, 0.9)');

    ctx.restore();
  }, [activeMapConfig, camera.offset.x, camera.offset.y, camera.zoom, hovered, map, normalizedArmies, normalizedBuildings, playerFactionId, selected, settlements, viewport.height, viewport.width]);

  useEffect(() => {
    draw();
  }, [draw]);

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
      return {
        zoom: nextZoom,
        offset: {
          x: focusX - (focusX - prev.offset.x) * scale,
          y: focusY - (focusY - prev.offset.y) * scale
        }
      };
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: camera.offset.x,
      offsetY: camera.offset.y
    };
    setIsPanning(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current && panRef.current.pointerId === event.pointerId) {
      setCamera(prev => ({
        ...prev,
        offset: {
          x: panRef.current!.offsetX + (event.clientX - panRef.current!.startX),
          y: panRef.current!.offsetY + (event.clientY - panRef.current!.startY)
        }
      }));
      return;
    }

    const coord = pickCoord(event.clientX, event.clientY);
    setHovered(coord);
  };

  const clearPan = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (panRef.current) {
      if (event.pointerId === panRef.current.pointerId) {
        event.currentTarget.releasePointerCapture(event.pointerId);
        panRef.current = null;
        setIsPanning(false);
      }
    }
  };

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!map) return;
    const coord = pickCoord(event.clientX, event.clientY);
    setSelected(coord);
  };

  const activeCoord = selected ?? hovered;
  const activeTile = map && activeCoord ? getTileAt(map, activeCoord) : null;
  const tileArmies = useMemo(() => {
    if (!map || !activeCoord) return [];
    return normalizedArmies.filter(entry => entry.coord.q === activeCoord.q && entry.coord.r === activeCoord.r);
  }, [activeCoord, map, normalizedArmies]);

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

  const mapSizePx = computeMapSizePx(map.descriptor.config, HEX_SIZE);
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
          className={`w-full h-full ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={clearPan}
          onPointerLeave={(event) => {
            clearPan(event);
            setHovered(null);
          }}
          onClick={handleClick}
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
              onClick={() => setCamera(prev => ({ ...prev, zoom: clamp(prev.zoom * 1.15, MIN_ZOOM, MAX_ZOOM) }))}
              className="rounded bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide hover:border-slate-400"
            >
              {t('surfaceView.zoomIn')}
            </button>
            <button
              onClick={() => setCamera(prev => ({ ...prev, zoom: clamp(prev.zoom / 1.15, MIN_ZOOM, MAX_ZOOM) }))}
              className="rounded bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide hover:border-slate-400"
            >
              {t('surfaceView.zoomOut')}
            </button>
            <button
              onClick={() => {
                const { width, height } = mapSizePx;
                setCamera({
                  zoom: 1,
                  offset: {
                    x: (viewport.width - width) / 2,
                    y: (viewport.height - height) / 2
                  }
                });
              }}
              className="rounded bg-slate-800 border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide hover:border-slate-400"
            >
              {t('surfaceView.resetView')}
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
                      <div className="text-xs text-slate-300 font-mono">{marker.army.strength.toFixed(0)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

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
