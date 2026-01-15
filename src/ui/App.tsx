
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameEngine } from '../engine/GameEngine';
import { GameMessage, GameState, StarSystem, EnemySighting, PlanetSurfaceMap, PlanetBody, ShipType, ArmyState } from '../shared/shared';
import GameScene from './components/GameScene';
import UI from './components/UI';
import { FleetNameProvider } from './context/FleetNames';
import {
  LoadGameScreen,
  MainMenu,
  ScenarioSelectScreen
} from './components/screens';
import { buildScenario } from '../content/scenarios';
import { useI18n } from './i18n';
import LoadingScreen from './components/ui/LoadingScreen';
import { applyFogOfWar } from '../engine/fogOfWar';
import { calculateFleetPower } from '../engine/world';
import { Vec3, clone, equals } from '../engine/math/vec3';
import { serializeGameState } from '../engine/serialization';
import { generateSurfaceMapForState, getSurfaceTileCoordFromId, getSurfaceTileCount, getSurfaceTileDir } from '../engine/planetSurface';
import { useButtonClickSound } from './audio/useButtonClickSound';
import { aiDebugger } from '../engine/aiDebugger';
import { findOrbitingSystem } from './components/ui/orbiting';
import { processCommandResult } from './commands/processCommandResult';
import { sorted } from '../shared/shared';
import { getDefaultSolidPlanet, getPlanetById } from '../engine/planets';
import type { GameCommand } from '../engine/commands';
import { BootstrapWorkerClient, buildSurfaceMapWorkerRequest, SurfaceMapWorkerClient } from './workers';
import type { BootstrapProgressUpdate } from './workers';

type UiMode =
  | 'NONE'
  | 'SYSTEM_MENU'
  | 'FLEET_PICKER'
  | 'BATTLE_SCREEN'
  | 'INVASION_MODAL'
  | 'INVASION_DECISION_MODAL'
  | 'ORBIT_FLEET_PICKER'
  | 'SHIP_DETAIL_MODAL'
  | 'GROUND_OPS_MODAL';
type ViewTier = 'galaxy' | 'system' | 'planet' | 'surface';
type ViewContext = {
  tier: ViewTier;
  focus: { systemId?: string | null; bodyId?: string | null };
  desiredZoom?: number | null;
};
type LoadingStage = 'prepare' | 'read' | 'worldgen' | 'deserialize' | 'engine' | 'assets' | 'render';
type LoadingStatus = 'loading' | 'error' | 'done';
type LoadingFlow = 'newGame' | 'loadGame';
type LoadingDetail = { current: number; total: number } | null;
type LoadingState = {
  active: boolean;
  status: LoadingStatus;
  stage: LoadingStage | null;
  progress: number | null;
  detail: LoadingDetail;
  error: { message: string } | null;
};

const ENEMY_SIGHTING_MAX_AGE_DAYS = 30;
const ENEMY_SIGHTING_LIMIT = 200;
const MAX_SAVE_BYTES = 25 * 1024 * 1024;
const DEFAULT_VIEW_CONTEXT: ViewContext = { tier: 'galaxy', focus: {}, desiredZoom: null };
const DEFAULT_VIEW_ZOOM = 0.12;
const ZOOM_THRESHOLDS = {
  system: 0.28,
  planet: 0.62,
  surface: 0.86
};
const ZOOM_PRESETS = {
  galaxy: 0.12,
  system: 0.38,
  planet: 0.7,
  surface: 0.93
};
const LOADING_FLOW_STAGES: Record<LoadingFlow, LoadingStage[]> = {
  newGame: ['prepare', 'worldgen', 'engine', 'render'],
  loadGame: ['read', 'deserialize', 'engine', 'render']
};
const LOADING_FLOW_WEIGHTS: Record<LoadingFlow, Record<LoadingStage, number>> = {
  newGame: {
    prepare: 0.05,
    read: 0,
    worldgen: 0.7,
    deserialize: 0,
    engine: 0.2,
    assets: 0,
    render: 0.05
  },
  loadGame: {
    prepare: 0,
    read: 0.1,
    worldgen: 0,
    deserialize: 0.6,
    engine: 0.25,
    assets: 0,
    render: 0.05
  }
};

const clampProgress = (value: number) => Math.max(0, Math.min(1, value));
const computeOverallProgress = (flow: LoadingFlow, stage: LoadingStage, stageProgress: number) => {
  const weights = LOADING_FLOW_WEIGHTS[flow];
  const stages = LOADING_FLOW_STAGES[flow];
  let total = 0;

  for (const key of stages) {
    const weight = weights[key] ?? 0;
    if (key === stage) {
      total += weight * clampProgress(stageProgress);
      return Math.min(1, total);
    }
    total += weight;
  }

  return Math.min(1, total);
};

// ------------------------------------------------------------
// Surface navigation helper (was: ui/navigation/surfaceNavigation.ts)
// ------------------------------------------------------------

interface SurfaceNavContext {
  system: StarSystem;
  body: PlanetBody;
}

const resolveSurfaceContext = ({
  systems,
  preferredSystemId,
  bodyId
}: {
  systems: StarSystem[];
  preferredSystemId?: string | null;
  bodyId?: string | null;
}): SurfaceNavContext | null => {
  if (bodyId) {
    const match = getPlanetById(systems, bodyId);
    if (match && match.planet.isSolid) {
      return { system: match.system, body: match.planet };
    }
  }

  if (preferredSystemId) {
    const system = systems.find(entry => entry.id === preferredSystemId);
    if (system) {
      const fallback = getDefaultSolidPlanet(system);
      if (fallback) return { system, body: fallback };
    }
  }

  for (const system of systems) {
    const fallback = getDefaultSolidPlanet(system);
    if (fallback) return { system, body: fallback };
  }

  return null;
};

const collectSurfaceWarmupBodyIds = (state: GameState): string[] => {
  const descriptors = state.planetSurfaceDescriptorsByBodyId;
  if (!descriptors) return [];

  const bodyIds = new Set<string>();

  state.armies.forEach(army => {
    if (army.state === ArmyState.DEPLOYED) {
      bodyIds.add(army.containerId);
    }
    const landingBodyId = army.landingOrder?.to.bodyId;
    if (landingBodyId) {
      bodyIds.add(landingBodyId);
    }
  });

  (state.groundBuildings ?? []).forEach(building => {
    bodyIds.add(building.surfacePos.bodyId);
  });

  const filtered = Array.from(bodyIds).filter(bodyId => Boolean(descriptors[bodyId]));
  return sorted(filtered, (a, b) => a.localeCompare(b));
};

const resolveSurfaceTileIdFromDir = (
  descriptor: PlanetSurfaceMap['descriptor'],
  dir: Vec3
): number | null => {
  const tileCount = getSurfaceTileCount(descriptor);
  if (tileCount <= 0) return null;
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < tileCount; i += 1) {
    const tileDir = getSurfaceTileDir(descriptor, i);
    if (!tileDir) continue;
    const dot = tileDir.x * dir.x + tileDir.y * dir.y + tileDir.z * dir.z;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  }
  return best;
};

const App: React.FC = () => {
  const { t } = useI18n();
  useButtonClickSound();
  const [screen, setScreen] = useState<'MENU' | 'NEW_GAME' | 'LOAD_GAME' | 'GAME' | 'SCENARIO'>('MENU');
  const [viewContext, setViewContext] = useState<ViewContext>(DEFAULT_VIEW_CONTEXT);
  const [viewZoom, setViewZoom] = useState<number>(DEFAULT_VIEW_ZOOM);
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [viewGameState, setViewGameState] = useState<GameState | null>(null);
  const [loadingState, setLoadingState] = useState<LoadingState>({
    active: false,
    status: 'loading',
    stage: null,
    progress: null,
    detail: null,
    error: null
  });
  const [renderReady, setRenderReady] = useState(false);
  const [gameSceneKey, setGameSceneKey] = useState(0);
  const loadingSessionRef = useRef(0);
  const loadingFlowRef = useRef<LoadingFlow | null>(null);
  const bootstrapWorkerRef = useRef<BootstrapWorkerClient | null>(null);

  // UI State
  const [uiMode, setUiMode] = useState<UiMode>('NONE');
  const [selectedFleetId, setSelectedFleetId] = useState<string | null>(null);
  const [inspectedFleetId, setInspectedFleetId] = useState<string | null>(null);
  const [targetSystem, setTargetSystem] = useState<StarSystem | null>(null);
  const [systemDetailSystem, setSystemDetailSystem] = useState<StarSystem | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number, y: number } | null>(null);
  const [focusTarget, setFocusTarget] = useState<Vec3 | null>(null);
  const [selectedBattleId, setSelectedBattleId] = useState<string | null>(null);
  const [fleetPickerMode, setFleetPickerMode] = useState<'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK' | null>(null);
  const [surfaceSelection, setSurfaceSelection] = useState<{ bodyId: string; tileId: number; dir: Vec3 } | null>(null);

  type InvasionDecisionContext = {
      messageId: string;
      fleetId: string;
      systemId: string;
      planetId: string | null;
  };
  const [invasionDecision, setInvasionDecision] = useState<InvasionDecisionContext | null>(null);

  const resolvedZoomTier = useMemo<ViewTier>(() => {
      if (!viewContext.focus.systemId) return 'galaxy';
      if (viewZoom >= ZOOM_THRESHOLDS.surface && viewContext.focus.bodyId) return 'surface';
      if (viewZoom >= ZOOM_THRESHOLDS.planet && viewContext.focus.bodyId) return 'planet';
      if (viewZoom >= ZOOM_THRESHOLDS.system) return 'system';
      return 'galaxy';
  }, [viewContext.focus.bodyId, viewContext.focus.systemId, viewZoom]);
  
  // Intel State (Persisted visual history of enemies)
  const [enemySightings, setEnemySightings] = useState<Record<string, EnemySighting>>({});
  const [uiMessages, setUiMessages] = useState<GameMessage[]>([]);
  const combinedMessages = useMemo(
    () => [...(viewGameState?.messages ?? []), ...uiMessages],
    [viewGameState?.messages, uiMessages]
  );

  // Settings
  const [devMode, setDevMode] = useState(false);
  const [godEyes, setGodEyes] = useState(false);
  const addUiMessage = useCallback((message: Pick<GameMessage, 'title' | 'subtitle' | 'lines' | 'priority' | 'type'> & Partial<GameMessage>) => {
      const baseDay = viewGameState?.day ?? engine?.state.day ?? 0;
      const id = message.id ?? `ui:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const normalized: GameMessage = {
          id,
          day: baseDay,
          type: message.type ?? 'ui',
          priority: message.priority ?? 1,
          title: message.title,
          subtitle: message.subtitle ?? '',
          lines: message.lines ?? [],
          payload: {},
          read: message.read ?? false,
          dismissed: message.dismissed ?? false,
          createdAtTurn: baseDay
      };
      setUiMessages(prev => [normalized, ...prev].slice(0, 50));
  }, [engine, viewGameState]);

  const notifyCommandError = useCallback((error: string) => {
      const detail = error || 'Unknown error';
      addUiMessage({
          title: t('msg.commandFailedTitle'),
          subtitle: t('msg.commandFailed', { error: detail }),
          lines: [],
          priority: 2,
          type: 'ui'
      });
  }, [addUiMessage, t]);

  const handleExportAiLogs = () => {
      const history = aiDebugger.getHistory();
      if (!history.length) return;

      const json = JSON.stringify(history, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const filename = `stellar-fleet_ai-logs_day-${history[history.length - 1].turn}.json`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();

      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addUiMessage({
          title: t('msg.exportSuccessTitle'),
          subtitle: t('msg.exportSuccess'),
          lines: [],
          priority: 1,
          type: 'ui'
      });
  };

  const handleClearAiLogs = () => {
      aiDebugger.clear();
      addUiMessage({
          title: t('msg.logsClearedTitle'),
          subtitle: t('msg.logsCleared'),
          lines: [],
          priority: 1,
          type: 'ui'
      });
  };

  const selectedFleetIdRef = useRef<string | null>(selectedFleetId);
  const uiModeRef = useRef<UiMode>(uiMode);
  const inspectedFleetIdRef = useRef<string | null>(inspectedFleetId);

  useEffect(() => {
      selectedFleetIdRef.current = selectedFleetId;
  }, [selectedFleetId]);

  useEffect(() => {
      uiModeRef.current = uiMode;
  }, [uiMode]);

  useEffect(() => {
      inspectedFleetIdRef.current = inspectedFleetId;
  }, [inspectedFleetId]);

  useEffect(() => {
      return () => {
          bootstrapWorkerRef.current?.dispose();
          bootstrapWorkerRef.current = null;
      };
  }, []);

  const startLoadingFlow = useCallback((flow: LoadingFlow, stage: LoadingStage) => {
      const nextSessionId = loadingSessionRef.current + 1;
      loadingSessionRef.current = nextSessionId;
      loadingFlowRef.current = flow;
      setRenderReady(false);
      setLoadingState({
        active: true,
        status: 'loading',
        stage,
        progress: computeOverallProgress(flow, stage, 0),
        detail: null,
        error: null
      });
      return nextSessionId;
  }, []);

  const updateLoadingStage = useCallback(
    (stage: LoadingStage, stageProgress: number | null, detail: LoadingDetail = null) => {
      setLoadingState(prev => {
        const flow = loadingFlowRef.current;
        const normalizedProgress = stageProgress === null ? null : clampProgress(stageProgress);
        const overallProgress =
          flow && normalizedProgress !== null
            ? computeOverallProgress(flow, stage, normalizedProgress)
            : normalizedProgress;
        const nextProgress = overallProgress === null ? null : Math.max(prev.progress ?? 0, overallProgress);

        return {
          ...prev,
          active: true,
          status: 'loading',
          stage,
          progress: nextProgress,
          detail,
          error: null
        };
      });
    },
    []
  );

  const getBootstrapWorker = useCallback(() => {
    if (!bootstrapWorkerRef.current) {
      bootstrapWorkerRef.current = new BootstrapWorkerClient();
    }
    return bootstrapWorkerRef.current;
  }, []);

  const failLoading = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    loadingSessionRef.current += 1;
    bootstrapWorkerRef.current?.dispose();
    bootstrapWorkerRef.current = null;
    setEngine(null);
    setViewGameState(null);
    setRenderReady(false);
    setLoadingState(prev => ({
      ...prev,
      active: true,
      status: 'error',
      error: { message },
      progress: prev.progress ?? 0
    }));
  }, []);

  const handleLoadingBack = useCallback(() => {
    loadingSessionRef.current += 1;
    loadingFlowRef.current = null;
    bootstrapWorkerRef.current?.dispose();
    bootstrapWorkerRef.current = null;
    setEngine(null);
    setViewGameState(null);
    setRenderReady(false);
    setEnemySightings({});
    setUiMessages([]);
    setSelectedFleetId(null);
    setInspectedFleetId(null);
    setFleetPickerMode(null);
    setUiMode('NONE');
    setSelectedBattleId(null);
    setLoadingState({
      active: false,
      status: 'loading',
      stage: null,
      progress: null,
      detail: null,
      error: null
    });
    setScreen('MENU');
  }, []);

  const handleBootstrapProgress = useCallback(
    (update: BootstrapProgressUpdate, sessionId: number) => {
      if (sessionId !== loadingSessionRef.current) return;
      updateLoadingStage(update.stage, update.progress, update.detail ?? null);
    },
    [updateLoadingStage]
  );

  const readFileWithProgress = useCallback(async (file: File, onProgress: (progress: number) => void) => {
    const total = Math.max(1, file.size);

    if (typeof file.stream !== 'function') {
      const text = await file.text();
      onProgress(1);
      return text;
    }

    const reader = file.stream().getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let loaded = 0;

    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      const value = result.value;
      if (done) break;
      if (value) {
        loaded += value.byteLength;
        chunks.push(decoder.decode(value, { stream: true }));
        onProgress(Math.min(1, loaded / total));
      }
    }

    chunks.push(decoder.decode());
    onProgress(1);
    return chunks.join('');
  }, []);

  const prewarmSurfaceMaps = useCallback(async (state: GameState, sessionId: number): Promise<GameState> => {
    if (sessionId !== loadingSessionRef.current) return state;
    const bodyIds = collectSurfaceWarmupBodyIds(state);
    if (bodyIds.length === 0) return state;

    const total = bodyIds.length;
    updateLoadingStage('engine', 0, { current: 0, total });

    let completed = 0;
    for (const bodyId of bodyIds) {
      if (sessionId !== loadingSessionRef.current) return state;
      generateSurfaceMapForState(state, bodyId);
      completed += 1;
      updateLoadingStage('engine', completed / total, { current: completed, total });
      if (completed < total && completed % 2 === 0) {
        // Yield so the loading UI can repaint during heavy surface generation.
        await new Promise<void>(resolve => {
          if (typeof window === 'undefined') {
            resolve();
            return;
          }
          window.setTimeout(resolve, 0);
        });
      }
    }

    return state;
  }, [updateLoadingStage]);

  // Function to compute the view state with optional Fog of War logic
  const updateViewState = useCallback((baseState: GameState) => {
      let nextView = { ...baseState };
      const playerFactionId = baseState.playerFactionId;
      
      // Apply Fog of War only if rule enabled AND God Eyes disabled
      if (nextView.rules.fogOfWar && !godEyes) {
          nextView = applyFogOfWar(nextView, playerFactionId);
      }
      
      setViewGameState(nextView);

      // --- INTEL UPDATE LOGIC ---
      // Update sightings for any enemy fleet that is currently visible in the view state
      // and clean up outdated entries.
      const visibleEnemies = nextView.fleets.filter(f => f.factionId !== playerFactionId);

      setEnemySightings(prev => {
          const next = { ...prev };
          let changed = false;

          if (visibleEnemies.length > 0) {
              visibleEnemies.forEach(f => {
                  const existing = next[f.id];
                  if (!existing || existing.daySeen < baseState.day || !equals(existing.position, f.position)) {
                       next[f.id] = {
                           fleetId: f.id,
                           factionId: f.factionId,
                           systemId: null,
                           position: clone(f.position),
                           daySeen: baseState.day,
                           estimatedPower: calculateFleetPower(f),
                           confidence: 1.0
                       };
                       changed = true;
                  }
              });
          }

          const cutoffDay = baseState.day - ENEMY_SIGHTING_MAX_AGE_DAYS;
          Object.keys(next).forEach(id => {
              if (next[id].daySeen < cutoffDay) {
                  delete next[id];
                  changed = true;
              }
          });

          const entries = Object.values(next);
          if (entries.length > ENEMY_SIGHTING_LIMIT) {
              const keepIds = new Set(
                  sorted(entries, (a, b) => {
                      const dayDiff = b.daySeen - a.daySeen;
                      if (dayDiff !== 0) return dayDiff;
                      return a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0;
                  })
                      .slice(0, ENEMY_SIGHTING_LIMIT)
                      .map(s => s.fleetId)
              );

              Object.keys(next).forEach(id => {
                  if (!keepIds.has(id)) {
                      delete next[id];
                      changed = true;
                  }
              });
          }

          return changed ? next : prev;
      });

      // Edge Case: If the currently selected fleet was hidden by Fog of War, deselect it
      const currentSelectedFleetId = selectedFleetIdRef.current;
      if (currentSelectedFleetId) {
          const fleetExists = nextView.fleets.find(f => f.id === currentSelectedFleetId);
          if (!fleetExists) {
              setSelectedFleetId(null);
              setInspectedFleetId(null);
              if (uiModeRef.current !== 'SYSTEM_MENU') {
                  setFleetPickerMode(null);
                  setUiMode('NONE');
              }
          }
      }
  }, [godEyes]);

    useEffect(() => {
      if (engine) {
        updateViewState(engine.state);

        const unsub = engine.subscribe(() => {
          updateViewState(engine.state);
        });
        return () => {
            unsub();
        };
      }
    }, [engine, updateViewState]);

    const stateReady = Boolean(engine && viewGameState);

    useEffect(() => {
      if (!loadingState.active || loadingState.status === 'error') return;
      if (!stateReady || !renderReady) return;
      loadingFlowRef.current = null;
      setLoadingState(prev => ({
        ...prev,
        active: false,
        status: 'done',
        stage: null,
        progress: 1,
        detail: null,
        error: null
      }));
    }, [loadingState.active, loadingState.status, renderReady, stateReady]);

  const handleLaunchGame = async (scenarioArg: any) => {
    const sessionId = startLoadingFlow('newGame', 'prepare');
    setEnemySightings({});
    setUiMessages([]);
    setSelectedFleetId(null);
    setInspectedFleetId(null);
    setFleetPickerMode(null);
    setUiMode('NONE');
    setSelectedBattleId(null);
    setViewContext(DEFAULT_VIEW_CONTEXT);
    setViewZoom(DEFAULT_VIEW_ZOOM);
    updateLoadingStage('prepare', 1);

    try {
        // Handle both simple seed (number) and full Scenario object
        let scenario;
        if (typeof scenarioArg === 'number') {
             scenario = buildScenario('conquest_sandbox', scenarioArg);
        } else {
             scenario = scenarioArg;
        }

        updateLoadingStage('worldgen', 0);
        const state = await getBootstrapWorker().startNewGame(
          scenario,
          (update) => handleBootstrapProgress(update, sessionId)
        );
        if (sessionId !== loadingSessionRef.current) return;

        updateLoadingStage('engine', 0);
        const warmedState = await prewarmSurfaceMaps(state, sessionId);
        if (sessionId !== loadingSessionRef.current) return;
        const newEngine = new GameEngine(warmedState);
        setEngine(newEngine);
        updateViewState(newEngine.state);
        setScreen('GAME');
        setGameSceneKey(prev => prev + 1);
        updateLoadingStage('engine', 1);
        updateLoadingStage('render', 0);
    } catch (error) {
        if (sessionId !== loadingSessionRef.current) return;
        failLoading(error);
    }
  };

  // --- SAVE / LOAD HANDLERS ---

  const handleSave = () => {
      if (!engine) {
          console.warn('[App] handleSave: Engine not initialized');
          return;
      }
      try {
          const json = serializeGameState(engine.state);
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          
          const scenarioId = engine.state.scenarioId || 'unknown';
          const filename = `stellar-fleet_${scenarioId}_day${engine.state.day}.json`;
          
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          addUiMessage({
              title: t('msg.saveSuccessTitle'),
              subtitle: t('msg.saveSuccess', { filename }),
              lines: [],
              priority: 1,
              type: 'ui'
          });
      } catch (e) {
          console.error("Save failed:", e);
          addUiMessage({
              title: t('msg.saveFailTitle'),
              subtitle: t('msg.saveFail'),
              lines: [(e as Error).message],
              priority: 2,
              type: 'ui'
          });
      }
  };

  const handleLoad = async (file: File) => {
      const sessionId = startLoadingFlow('loadGame', 'read');
      try {
          if (file.size > MAX_SAVE_BYTES) {
              throw new Error(`Save file exceeds ${Math.floor(MAX_SAVE_BYTES / (1024 * 1024))}MB limit.`);
          }

          updateLoadingStage('read', 0);
          const text = await readFileWithProgress(file, (progress) => {
              if (sessionId !== loadingSessionRef.current) return;
              updateLoadingStage('read', progress);
          });
          if (sessionId !== loadingSessionRef.current) return;

          updateLoadingStage('deserialize', 0);
          const state = await getBootstrapWorker().loadGame(
            text,
            (update) => handleBootstrapProgress(update, sessionId)
          );
          if (sessionId !== loadingSessionRef.current) return;
          
          updateLoadingStage('engine', 0);
          const warmedState = await prewarmSurfaceMaps(state, sessionId);
          if (sessionId !== loadingSessionRef.current) return;
          const newEngine = new GameEngine(warmedState);
          setEngine(newEngine);

          setEnemySightings({});
          setSelectedFleetId(null);
          setInspectedFleetId(null);
          setFleetPickerMode(null);
          setUiMode('NONE');
          setUiMessages([]);
          setSelectedBattleId(null);
          setViewContext(DEFAULT_VIEW_CONTEXT);
          setViewZoom(DEFAULT_VIEW_ZOOM);
          
          updateViewState(newEngine.state);
          
          setScreen('GAME');
          setGameSceneKey(prev => prev + 1);
          updateLoadingStage('engine', 1);
          updateLoadingStage('render', 0);

          addUiMessage({
              title: t('msg.loadSuccessTitle'),
              subtitle: t('msg.loadSuccess'),
              lines: [],
              priority: 1,
              type: 'ui'
          });
      } catch (error) {
          if (sessionId !== loadingSessionRef.current) return;
          failLoading(error);
      }
  };

  // --- INTERACTION HANDLERS ---

  const handleSceneReady = useCallback(() => {
      setRenderReady(true);
  }, []);

  const handleSystemClick = (sys: StarSystem, event: any) => {
      setTargetSystem(sys);
      setFocusTarget(sys.position);
      setMenuPosition({ x: event.clientX, y: event.clientY });
      setFleetPickerMode(null);
      setInspectedFleetId(null);
      setUiMode('SYSTEM_MENU');
  };

  const handleFleetSelect = (id: string | null) => {
      setSelectedFleetId(id);
      if (!id) {
          setInspectedFleetId(null);
      }
  };

  const handleFleetInspect = (id: string) => {
      setSelectedFleetId(id);
      setInspectedFleetId(id);
      setUiMode('SHIP_DETAIL_MODAL');
  };

  const handleNextTurn = () => {
      if (engine) {
          engine.advanceTurn();
      }
  };

  const handleMoveCommand = (fleetId: string) => {
      if (engine && targetSystem) {
          const result = engine.dispatchPlayerCommand({
              type: 'MOVE_FLEET',
              fleetId,
              targetSystemId: targetSystem.id
          });
          if (!processCommandResult(result, notifyCommandError)) {
              return;
          }
          setFleetPickerMode(null);
          setUiMode('NONE');
      }
  };

  const handleAttackCommand = (fleetId: string) => {
      if (engine && targetSystem) {
          const result = engine.dispatchPlayerCommand({
              type: 'MOVE_FLEET',
              fleetId,
              targetSystemId: targetSystem.id
          });
          if (!processCommandResult(result, notifyCommandError)) {
              return;
          }
          setFleetPickerMode(null);
          setUiMode('NONE');
      }
  };

  const handleLoadCommand = (fleetId: string) => {
      if (engine && targetSystem) {
          const result = engine.dispatchPlayerCommand({
              type: 'ORDER_LOAD',
              fleetId,
              targetSystemId: targetSystem.id
          });
          if (!processCommandResult(result, notifyCommandError)) return;
          setFleetPickerMode(null);
          setUiMode('NONE');
      }
  };

  const handleUnloadCommand = (fleetId: string) => {
      if (engine && targetSystem) {
          const result = engine.dispatchPlayerCommand({
              type: 'ORDER_UNLOAD',
              fleetId,
              targetSystemId: targetSystem.id
          });
          if (!processCommandResult(result, notifyCommandError)) return;
          setFleetPickerMode(null);
          setUiMode('NONE');
      }
  };

  const handleOpenFleetPicker = (mode: 'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK') => {
      setFleetPickerMode(mode);
      setUiMode('FLEET_PICKER');
  };

  const handleOpenOrbitingFleetPicker = () => {
      setUiMode('ORBIT_FLEET_PICKER');
  };

  const handleOpenGroundOps = () => {
      if (!targetSystem) {
          console.warn('[App] handleOpenGroundOps: No target system selected');
          return;
      }
      setFleetPickerMode(null);
      setUiMode('GROUND_OPS_MODAL');
  };

  const handleFocusSystem = useCallback((systemId: string) => {
      if (!viewGameState) {
          console.warn('[App] handleFocusSystem: viewGameState not ready');
          return;
      }
      const resolvedSystem = viewGameState.systems.find(system => system.id === systemId) ?? null;
      if (!resolvedSystem) {
          console.warn('[App] handleFocusSystem: System not found', { systemId });
          return;
      }
      setTargetSystem(resolvedSystem);
      setFocusTarget(resolvedSystem.position);
      setViewZoom(ZOOM_PRESETS.system);
      setViewContext({
          tier: 'system',
          focus: { systemId: resolvedSystem.id },
          desiredZoom: null
      });
      setUiMode('NONE');
      setMenuPosition(null);
  }, [viewGameState]);

  const handleFocusPlanet = useCallback((bodyId: string) => {
      if (!viewGameState) {
          console.warn('[App] handleFocusPlanet: viewGameState not ready');
          return;
      }
      const context = resolveSurfaceContext({
          systems: viewGameState.systems,
          bodyId,
          preferredSystemId: targetSystem?.id ?? null
      });
      if (!context) {
          console.warn('[App] handleFocusPlanet: No solid body available for surface view');
          return;
      }
      setViewContext({
          tier: 'planet',
          focus: { systemId: context.system.id, bodyId: context.body.id },
          desiredZoom: null
      });
      setTargetSystem(context.system);
      setFocusTarget(context.system.position);
      setViewZoom(ZOOM_PRESETS.planet);
      setUiMode('NONE');
      setMenuPosition(null);
  }, [targetSystem, viewGameState]);

  const handleFocusSurface = useCallback((bodyId: string) => {
      if (!viewGameState) {
          console.warn('[App] handleFocusSurface: viewGameState not ready');
          return;
      }
      const context = resolveSurfaceContext({
          systems: viewGameState.systems,
          bodyId,
          preferredSystemId: targetSystem?.id ?? null
      });
      if (!context) {
          console.warn('[App] handleFocusSurface: No solid body available for surface view');
          return;
      }
      setViewContext({
          tier: 'surface',
          focus: { systemId: context.system.id, bodyId: context.body.id },
          desiredZoom: null
      });
      setTargetSystem(context.system);
      setFocusTarget(context.system.position);
      setViewZoom(ZOOM_PRESETS.surface);
      setUiMode('NONE');
      setMenuPosition(null);
  }, [targetSystem, viewGameState]);

  const handleZoomOut = useCallback(() => {
      setViewContext((prev) => {
          if (resolvedZoomTier === 'surface' || resolvedZoomTier === 'planet') {
              const nextSystemId = prev.focus.systemId ?? targetSystem?.id ?? null;
              return {
                  tier: 'system',
                  focus: nextSystemId ? { systemId: nextSystemId } : {},
                  desiredZoom: null
              };
          }
          if (resolvedZoomTier === 'system') {
              return { tier: 'galaxy', focus: {}, desiredZoom: null };
          }
          return prev;
      });
      setViewZoom((prev) => {
          if (resolvedZoomTier === 'surface' || resolvedZoomTier === 'planet') return ZOOM_PRESETS.system;
          if (resolvedZoomTier === 'system') return ZOOM_PRESETS.galaxy;
          return prev;
      });
  }, [resolvedZoomTier, targetSystem?.id]);

  const handleZoomIn = useCallback(() => {
      if (resolvedZoomTier !== 'planet') return;
      const bodyId = viewContext.focus.bodyId ?? null;
      if (!bodyId) return;
      handleFocusSurface(bodyId);
  }, [handleFocusSurface, resolvedZoomTier, viewContext.focus.bodyId]);

  const handleViewZoomChange = useCallback((nextZoom: number) => {
      const clamped = Math.max(0, Math.min(1, nextZoom));
      setViewZoom(prev => (prev === clamped ? prev : clamped));
  }, []);

  const handleOpenSystemDetails = () => {
      if (!targetSystem || !viewGameState) {
          console.warn('[App] handleOpenSystemDetails: Missing targetSystem or viewGameState');
          return;
      }
      const latestSystem = viewGameState.systems.find(s => s.id === targetSystem.id) || targetSystem;
      setSystemDetailSystem(latestSystem);
      setUiMode('NONE');
  };

  const handleCloseSystemDetails = () => {
      setSystemDetailSystem(null);
  };

  const handleCloseMenu = () => {
      setFleetPickerMode(null);
      setUiMode('NONE');
      setInspectedFleetId(null);
  };

  const handleInvade = (systemId: string) => {
      const system = viewGameState?.systems.find(s => s.id === systemId);
      if (!system) {
          console.warn('[App] handleInvade: System not found', { systemId });
          return;
      }
      setTargetSystem(system);
      setFleetPickerMode(null);
      setUiMode('INVASION_MODAL');
  };

  const handleCommitInvasion = (fleetId: string, planetId: string | null) => {
      const fId = fleetId;
      if (!targetSystem || !engine) {
          console.warn('[App] handleCommitInvasion: Missing targetSystem or engine');
          return;
      }

      const result = engine.dispatchPlayerCommand({
          type: 'ORDER_INVASION',
          fleetId: fId,
          targetSystemId: targetSystem.id,
          targetPlanetId: planetId ?? undefined
      });

      if (processCommandResult(result, notifyCommandError)) {
          engine.dispatchCommand({
              type: 'ADD_LOG',
              text: t('msg.invasionLog', { system: targetSystem.name }),
              logType: 'move'
          });
      }

      handleCloseMenu();
  };

  const handleSurfaceIssueCommand = useCallback((cmd: GameCommand) => {
      if (!engine) return;
      const result = engine.dispatchCommand(cmd);
      processCommandResult(result, notifyCommandError);
  }, [engine]);

  const handleSplitFleet = (shipIds: string[]) => {
      if (engine && selectedFleetId) {
          const result = engine.dispatchPlayerCommand({
              type: 'SPLIT_FLEET',
              originalFleetId: selectedFleetId,
              shipIds
          });
          processCommandResult(result, notifyCommandError);
      }
  };

  const handleMergeFleet = (targetFleetId: string) => {
      if (engine && selectedFleetId) {
          const result = engine.dispatchPlayerCommand({
              type: 'MERGE_FLEETS',
              sourceFleetId: selectedFleetId,
              targetFleetId
          });
          processCommandResult(result, notifyCommandError);
      }
  };

  const handleDeploySingle = (shipId: string, planetId: string) => {
      if (!engine || !selectedFleetId) {
          console.warn('[App] handleDeploySingle: Missing engine or selectedFleetId');
          return;
      }

      const fleet = engine.state.fleets.find(f => f.id === selectedFleetId) || null;
      const system = findOrbitingSystem(fleet, engine.state.systems);
      if (!fleet || !system) {
          console.warn('[App] handleDeploySingle: Fleet or system not found', { selectedFleetId, fleet: !!fleet, system: !!system });
          return;
      }

      const ship = fleet.ships.find(s => s.id === shipId);
      if (!ship || !ship.carriedArmyId) {
          console.warn('[App] handleDeploySingle: Ship not found or no carried army', { shipId, ship: !!ship });
          return;
      }

      const targetPlanet = system.planets.find(planet => planet.id === planetId && planet.isSolid);
      if (!targetPlanet) {
          console.warn('[App] handleDeploySingle: Target planet not found', { planetId });
          return;
      }

      const result = engine.dispatchPlayerCommand({
          type: 'UNLOAD_ARMY',
          fleetId: fleet.id,
          shipId: ship.id,
          armyId: ship.carriedArmyId,
          systemId: system.id,
          planetId: targetPlanet.id
      });
      processCommandResult(result, notifyCommandError);
  };

  const handleEmbarkArmy = (shipId: string, armyId: string) => {
      if (!engine || !selectedFleetId) {
          console.warn('[App] handleEmbarkArmy: Missing engine or selectedFleetId');
          return;
      }

      const fleet = engine.state.fleets.find(f => f.id === selectedFleetId) || null;
      const system = findOrbitingSystem(fleet, engine.state.systems);
      if (!fleet || !system) {
          console.warn('[App] handleEmbarkArmy: Fleet or system not found', { selectedFleetId });
          return;
      }

      const result = engine.dispatchPlayerCommand({
          type: 'LOAD_ARMY',
          fleetId: fleet.id,
          shipId,
          armyId,
          systemId: system.id
      });
      processCommandResult(result, notifyCommandError);
  };

  const handleTransferArmy = (systemId: string, armyId: string, fromPlanetId: string, toPlanetId: string) => {
      if (!engine) {
          console.warn('[App] handleTransferArmy: Engine not initialized');
          return;
      }

      const result = engine.dispatchPlayerCommand({
          type: 'TRANSFER_ARMY_PLANET',
          armyId,
          fromPlanetId,
          toPlanetId,
          systemId
      });
      processCommandResult(result, notifyCommandError);
  };

  const handleMarkMessageRead = (messageId: string, read: boolean) => {
      if (messageId.startsWith('ui:')) {
          setUiMessages(prev => prev.map(msg => msg.id === messageId ? { ...msg, read } : msg));
          return;
      }
      if (!engine) {
          console.warn('[App] handleMarkMessageRead: Engine not initialized');
          return;
      }
      engine.markMessageRead(messageId, read);
  };

  const handleMarkAllMessagesRead = () => {
      setUiMessages(prev => prev.map(msg => ({ ...msg, read: true })));
      if (!engine) {
          console.warn('[App] handleMarkAllMessagesRead: Engine not initialized');
          return;
      }
      engine.markAllMessagesRead();
  };

  const handleOpenMessage = (message: GameMessage) => {
      if (message.id.startsWith('ui:')) {
          setUiMessages(prev => prev.map(msg => msg.id === message.id ? { ...msg, read: true } : msg));
          return;
      }
      if (!engine || !viewGameState) {
          console.warn('[App] handleOpenMessage: Engine or viewGameState not initialized');
          return;
      }
      engine.markMessageRead(message.id, true);

      const payload = message.payload || {};
      const battleId = typeof payload.battleId === 'string' ? payload.battleId : null;
      const systemId = typeof payload.systemId === 'string' ? payload.systemId : null;
      const planetId = typeof payload.planetId === 'string' ? payload.planetId : null;
      const fleetId = typeof payload.fleetId === 'string' ? payload.fleetId : null;

      if (message.type === 'INVASION_DECISION' && systemId && fleetId) {
          const systemFromPlanet = planetId
              ? viewGameState.systems.find(sys => sys.planets.some(planet => planet.id === planetId))
              : null;
          const sys = viewGameState.systems.find(s => s.id === systemId) || systemFromPlanet;
          if (!sys) {
              console.warn('[App] handleOpenMessage: Invasion decision system not found', { systemId, planetId });
              return;
          }

          setTargetSystem(sys);
          setFleetPickerMode(null);
          setInvasionDecision({
              messageId: message.id,
              fleetId,
              systemId: sys.id,
              planetId: planetId ?? null
          });
          setUiMode('INVASION_DECISION_MODAL');
          return;
      }

      if (battleId) {
          setSelectedBattleId(battleId);
          setFleetPickerMode(null);
          setUiMode('BATTLE_SCREEN');
          return;
      }

      const systemFromPlanet = planetId
          ? viewGameState.systems.find(sys => sys.planets.some(planet => planet.id === planetId))
          : null;

      if (systemId) {
          const sys = viewGameState.systems.find(s => s.id === systemId) || systemFromPlanet;
          if (sys) {
              setTargetSystem(sys);
              setSystemDetailSystem(sys);
              setMenuPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
              setUiMode('SYSTEM_MENU');
              return;
          }
      }

      if (systemFromPlanet) {
          setTargetSystem(systemFromPlanet);
          setSystemDetailSystem(systemFromPlanet);
          setUiMode('NONE');
      }
  };

  const handleCloseInvasionDecision = () => {
      setUiMode('NONE');
      setInvasionDecision(null);
  };

  const handleConfirmInvasionDecisionSiege = () => {
      if (!engine || !invasionDecision) {
          console.warn('[App] handleConfirmInvasionDecisionSiege: Missing engine or invasionDecision');
          return;
      }

      engine.dismissMessage(invasionDecision.messageId);
      setInvasionDecision(null);
      setUiMode('NONE');
  };

  const handleConfirmInvasionDecisionAttack = (planetId: string) => {
      if (!engine || !invasionDecision) {
          console.warn('[App] handleConfirmInvasionDecisionAttack: Missing engine or invasionDecision');
          return;
      }

      const { fleetId, systemId, messageId } = invasionDecision;
      const system = engine.state.systems.find(s => s.id === systemId);
      const fleet = engine.state.fleets.find(f => f.id === fleetId);

      if (!system || !fleet) {
          notifyCommandError('Invasion fleet or target system no longer exists.');
          engine.dismissMessage(messageId);
          setInvasionDecision(null);
          setUiMode('NONE');
          return;
      }

      const targetPlanet = system.planets.find(p => p.id === planetId && p.isSolid) ?? null;
      if (!targetPlanet) {
          notifyCommandError('Invalid invasion landing target.');
          return;
      }

      const loadedTransports = fleet.ships.filter(ship => ship.type === ShipType.TRANSPORTER && ship.carriedArmyId);
      if (loadedTransports.length === 0) {
          notifyCommandError('No embarked armies available to land.');
          return;
      }

      let anyLanded = false;
      loadedTransports.forEach(ship => {
          const armyId = ship.carriedArmyId;
          if (!armyId) return;
          const result = engine.dispatchPlayerCommand({
              type: 'UNLOAD_ARMY',
              fleetId: fleet.id,
              shipId: ship.id,
              armyId,
              systemId: system.id,
              planetId: targetPlanet.id
          });
          if (processCommandResult(result, notifyCommandError)) {
              anyLanded = true;
          }
      });

      engine.dismissMessage(messageId);
      setInvasionDecision(null);
      setUiMode('NONE');

      if (anyLanded) {
          handleFocusSurface(targetPlanet.id);
      }
  };

  useEffect(() => {
      if (!engine || !viewGameState) return;
      if (uiMode !== 'NONE') return;
      if (invasionDecision) return;

      const pending = viewGameState.messages.filter(msg => msg.type === 'INVASION_DECISION' && !msg.dismissed && !msg.read);
      if (pending.length === 0) return;

      const next = pending.reduce<GameMessage | null>((best, msg) => {
          if (!best) return msg;
          if (msg.createdAtTurn !== best.createdAtTurn) return msg.createdAtTurn > best.createdAtTurn ? msg : best;
          if (msg.priority !== best.priority) return msg.priority > best.priority ? msg : best;
          return msg.id > best.id ? msg : best;
      }, null);

      if (next) {
          handleOpenMessage(next);
      }
  }, [engine, viewGameState, uiMode, invasionDecision]);

  const activeSurfaceBodyId = useMemo(() => (
      resolvedZoomTier === 'surface' ? viewContext.focus.bodyId ?? null : null
  ), [resolvedZoomTier, viewContext.focus.bodyId]);

  const surfaceSystem = useMemo(() => {
      if (!viewGameState || !activeSurfaceBodyId) return null;
      return getPlanetById(viewGameState.systems, activeSurfaceBodyId)?.system ?? null;
  }, [activeSurfaceBodyId, viewGameState]);

const surfaceBody = useMemo(() => {
    if (!surfaceSystem || !activeSurfaceBodyId) return null;
    return surfaceSystem.planets.find(planet => planet.id === activeSurfaceBodyId) ?? null;
}, [activeSurfaceBodyId, surfaceSystem]);

const [surfaceMap, setSurfaceMap] = useState<PlanetSurfaceMap | null>(null);
const [surfaceMapStatus, setSurfaceMapStatus] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'error'>('idle');
const surfaceDescriptor = useMemo(() => {
    if (!viewGameState || !activeSurfaceBodyId) return null;
    return viewGameState.planetSurfaceDescriptorsByBodyId?.[activeSurfaceBodyId] ?? null;
}, [activeSurfaceBodyId, viewGameState?.planetSurfaceDescriptorsByBodyId]);
const surfaceMapRef = useRef<PlanetSurfaceMap | null>(null);
const surfaceMapCacheRef = useRef<Map<string, PlanetSurfaceMap>>(new Map());
const surfaceMapKeyRef = useRef<string | null>(null);
const viewGameStateRef = useRef<GameState | null>(null);
const surfaceMapWorkerRef = useRef<SurfaceMapWorkerClient | null>(null);

// Prewarm the worker at app mount for faster first surface view load
useEffect(() => {
    if (!surfaceMapWorkerRef.current) {
        surfaceMapWorkerRef.current = new SurfaceMapWorkerClient();
    }
    return () => {
        surfaceMapWorkerRef.current?.dispose();
        surfaceMapWorkerRef.current = null;
    };
}, []);

useEffect(() => {
    viewGameStateRef.current = viewGameState;
}, [viewGameState]);

const surfaceMapKey = useMemo(() => {
    if (!viewGameState || !surfaceDescriptor || !activeSurfaceBodyId) return null;
    const match = getPlanetById(viewGameState.systems, activeSurfaceBodyId);
    if (!match) return null;
    const { system, planet } = match;
    const config = surfaceDescriptor.config;
    const configKey =
        config.gridKind === 'geodesic'
          ? `geo:${config.frequency}`
          : `rect:${config.w}x${config.h}:${config.wrapX ? 'wrap' : 'nowrap'}`;
    const astro = system.astro;
    const astroKey = astro ? `${astro.seed}|${astro.starCount}|${astro.planets.length}` : 'no-astro';
    const ownerKey = planet.ownerFactionId ?? 'neutral';
    const { planetIndex, moonIndex } = surfaceDescriptor.astroRef;

    return [
        activeSurfaceBodyId,
        surfaceDescriptor.seed,
        configKey,
        config.generatorVersion,
        planetIndex,
        moonIndex ?? 'no-moon',
        astroKey,
        ownerKey
    ].join('|');
}, [activeSurfaceBodyId, surfaceDescriptor, viewGameState]);

useEffect(() => {
    const shouldLoad = resolvedZoomTier === 'surface';
    if (!shouldLoad) return;

    if (!surfaceMapKey || !surfaceDescriptor || !activeSurfaceBodyId) {
        surfaceMapKeyRef.current = null;
        surfaceMapRef.current = null;
        setSurfaceMap(null);
        setSurfaceMapStatus(surfaceDescriptor ? 'missing' : 'idle');
        return;
    }

    const cachedMap = surfaceMapKey === surfaceMapKeyRef.current
        ? surfaceMapRef.current ?? surfaceMapCacheRef.current.get(surfaceMapKey) ?? null
        : surfaceMapCacheRef.current.get(surfaceMapKey) ?? null;

    surfaceMapKeyRef.current = surfaceMapKey;

    if (cachedMap) {
        surfaceMapRef.current = cachedMap;
        setSurfaceMap(cachedMap);
        setSurfaceMapStatus('ready');
        return;
    }

    const state = viewGameStateRef.current;
    if (!state) {
        surfaceMapRef.current = null;
        setSurfaceMap(null);
        setSurfaceMapStatus('missing');
        return;
    }

    const workerRequest = buildSurfaceMapWorkerRequest(state, activeSurfaceBodyId);
    if (!workerRequest) {
        surfaceMapRef.current = null;
        setSurfaceMap(null);
        setSurfaceMapStatus('missing');
        return;
    }

    // Use prewarmed worker (created at mount)
    const worker = surfaceMapWorkerRef.current ?? new SurfaceMapWorkerClient();
    surfaceMapWorkerRef.current = worker;

    let cancelled = false;
    setSurfaceMapStatus('loading');

    worker.requestSurfaceMap(workerRequest)
        .then(map => {
            if (cancelled || surfaceMapKeyRef.current !== surfaceMapKey) return;
            if (!map) {
                surfaceMapRef.current = null;
                surfaceMapCacheRef.current.delete(surfaceMapKey);
                setSurfaceMap(null);
                setSurfaceMapStatus('missing');
                return;
            }
            surfaceMapCacheRef.current.set(surfaceMapKey, map);
            surfaceMapRef.current = map;
            setSurfaceMap(map);
            setSurfaceMapStatus('ready');
        })
        .catch(error => {
            console.error('[Surface] map generation failed', error);
            if (cancelled || surfaceMapKeyRef.current !== surfaceMapKey) return;
            surfaceMapRef.current = null;
            surfaceMapCacheRef.current.delete(surfaceMapKey);
            setSurfaceMap(null);
            setSurfaceMapStatus('error');
        });

    return () => {
        cancelled = true;
    };
}, [activeSurfaceBodyId, resolvedZoomTier, surfaceDescriptor, surfaceMapKey]);

useEffect(() => {
    if (resolvedZoomTier !== 'surface') {
        setSurfaceSelection(null);
    }
}, [resolvedZoomTier]);

useEffect(() => {
    if (!surfaceSelection) return;
    if (!activeSurfaceBodyId) {
        setSurfaceSelection(null);
        return;
    }
    if (surfaceSelection.bodyId !== activeSurfaceBodyId) {
        setSurfaceSelection(null);
    }
}, [activeSurfaceBodyId, surfaceSelection]);

  const surfaceArmies = useMemo(() => {
      if (!viewGameState) return [];
      return viewGameState.armies;
  }, [viewGameState]);

  const surfaceBuildings = useMemo(() => {
      if (!viewGameState || !activeSurfaceBodyId) return [];
      return (viewGameState.groundBuildings ?? []).filter(building => building.surfacePos.bodyId === activeSurfaceBodyId);
  }, [activeSurfaceBodyId, viewGameState]);

  const surfaceSelectionInfo = useMemo(() => {
      if (!surfaceSelection || !surfaceMap) return null;
      const tileId = surfaceSelection.tileId;
      const tile = surfaceMap.tiles[tileId] ?? null;
      const coord = getSurfaceTileCoordFromId(surfaceMap.descriptor, tileId);
      return { tileId, coord, tile };
  }, [surfaceMap, surfaceSelection]);

  const zoomOutLabel = useMemo(() => {
      if (resolvedZoomTier === 'surface' || resolvedZoomTier === 'planet') {
          return t('surfaceView.backToSystem');
      }
      if (resolvedZoomTier === 'system') {
          return t('surfaceView.backToGalaxy');
      }
      return null;
  }, [resolvedZoomTier, t]);

  const zoomInLabel = useMemo(() => {
      if (resolvedZoomTier === 'planet') {
          return t('surfaceView.zoomIn');
      }
      return null;
  }, [resolvedZoomTier, t]);

  const isGameInteractionLocked = loadingState.active || screen !== 'GAME';

  const loadingStageLabel = loadingState.stage ? t(`loading.stage.${loadingState.stage}`) : t('loading.init');
  const loadingDetailText = loadingState.detail
    ? t('loading.detail.count', { current: loadingState.detail.current, total: loadingState.detail.total })
    : null;

  let screenContent: React.ReactNode = null;

  if (screen === 'MENU') {
      screenContent = <MainMenu onNavigate={(s) => setScreen(s === 'LOAD_GAME' ? 'LOAD_GAME' : 'SCENARIO')} />;
  } else if (screen === 'SCENARIO') {
      screenContent = <ScenarioSelectScreen onBack={() => setScreen('MENU')} onLaunch={handleLaunchGame} />;
  } else if (screen === 'LOAD_GAME') {
      screenContent = <LoadGameScreen onBack={() => setScreen('MENU')} onLoad={handleLoad} />;
  } else if (screen === 'GAME' && viewGameState && engine) {
      const playerFactionId = viewGameState.playerFactionId;
      const blueFleets = viewGameState.fleets.filter(f => f.factionId === playerFactionId);
      const selectedFleet = viewGameState.fleets.find(f => f.id === selectedFleetId) || null;
      const inspectedFleet = viewGameState.fleets.find(f => f.id === inspectedFleetId) || null;

      screenContent = (
        <div className="relative w-full h-screen overflow-hidden bg-black text-white">
            <FleetNameProvider fleets={viewGameState.fleets}>
                <GameScene
                    key={gameSceneKey}
                    gameState={viewGameState}
                    enemySightings={enemySightings}
                    selectedFleetId={selectedFleetId}
                    focusTarget={focusTarget}
                    isInteractive={!isGameInteractionLocked}
                    viewContext={viewContext}
                    viewZoom={viewZoom}
                    onViewZoomChange={handleViewZoomChange}
                    onFocusSystem={handleFocusSystem}
                    onFocusPlanet={handleFocusPlanet}
                    onFocusSurface={handleFocusSurface}
                    onSurfaceTileSelect={(selection) => {
                        const descriptor = viewGameState.planetSurfaceDescriptorsByBodyId?.[selection.bodyId];
                        if (!descriptor) return;
                        const resolvedTileId = resolveSurfaceTileIdFromDir(descriptor, selection.dir);
                        if (resolvedTileId === null) return;
                        setSurfaceSelection({ ...selection, tileId: resolvedTileId });
                    }}
                    onFleetSelect={handleFleetSelect}
                    onFleetInspect={handleFleetInspect}
                    onSystemClick={handleSystemClick}
                    onBackgroundClick={() => {
                        handleCloseMenu();
                        setSelectedFleetId(null);
                    }}
                    onReady={handleSceneReady}
                />
                <UI
                    startYear={viewGameState.startYear}
                    day={viewGameState.day}
                    selectedFleet={selectedFleet}
                    inspectedFleet={inspectedFleet}
                    logs={viewGameState.logs}
                    messages={combinedMessages}
                    
                    uiMode={uiMode}
                    menuPosition={menuPosition}
                    targetSystem={targetSystem}
                    systems={viewGameState.systems}
                    blueFleets={blueFleets}
                    battles={viewGameState.battles}
                    selectedBattleId={selectedBattleId}
                    gameState={viewGameState}
                    
                    onSplit={handleSplitFleet}
                    onMerge={handleMergeFleet}
                    onDeploy={handleDeploySingle}
                    onEmbark={handleEmbarkArmy}
                    onTransferArmy={handleTransferArmy}
                    winner={viewGameState.winnerFactionId}
                    onRestart={() => setScreen('MENU')}
                    onNextTurn={handleNextTurn}
                    onMoveCommand={handleMoveCommand}
                    onAttackCommand={handleAttackCommand}
                    onLoadCommand={handleLoadCommand}
                    onUnloadCommand={handleUnloadCommand}
                    onOpenFleetPicker={handleOpenFleetPicker}
                    onOpenOrbitingFleetPicker={handleOpenOrbitingFleetPicker}
                    onOpenGroundOps={handleOpenGroundOps}
                    onCloseMenu={handleCloseMenu}
                    onFocusSystem={handleFocusSystem}
                    onFocusSurface={handleFocusSurface}
                    fleetPickerMode={fleetPickerMode}
                    onOpenSystemDetails={handleOpenSystemDetails}
                    systemDetailSystem={systemDetailSystem}
                    onCloseSystemDetails={handleCloseSystemDetails}
                    onSelectFleet={setSelectedFleetId}
                    onInspectFleet={handleFleetInspect}
                    onCloseShipDetail={() => handleCloseMenu()}

                    onOpenBattle={(id) => {
                        setSelectedBattleId(id);
                        setFleetPickerMode(null);
                        setUiMode('BATTLE_SCREEN');
                    }}
                    onInvade={handleInvade}
                    onCommitInvasion={handleCommitInvasion}

                    invasionDecision={invasionDecision}
                    onCloseInvasionDecision={handleCloseInvasionDecision}
                    onConfirmInvasionDecisionSiege={handleConfirmInvasionDecisionSiege}
                    onConfirmInvasionDecisionAttack={handleConfirmInvasionDecisionAttack}

                    onSave={handleSave}

                    devMode={devMode}
                    godEyes={godEyes}
                    onSetUiSettings={(s) => {
                        setDevMode(s.devMode);
                        setGodEyes(s.godEyes);
                        const enableAiDebug = s.aiDebug || false;
                        aiDebugger.setEnabled(enableAiDebug);
                    }}
                    onExportAiLogs={handleExportAiLogs}
                    onClearAiLogs={handleClearAiLogs}
                    onOpenMessage={handleOpenMessage}
                    onMarkMessageRead={handleMarkMessageRead}
                    onMarkAllMessagesRead={handleMarkAllMessagesRead}
                />
                {(zoomOutLabel || zoomInLabel) ? (
                    <div className="pointer-events-none absolute left-4 bottom-4 z-20">
                        <div className="flex flex-col gap-2">
                            {zoomInLabel ? (
                                <button
                                    type="button"
                                    onClick={handleZoomIn}
                                    className="pointer-events-auto rounded-lg border border-slate-700 bg-slate-900/80 px-4 py-2 text-xs uppercase tracking-widest text-slate-200 shadow-lg transition hover:bg-slate-800"
                                >
                                    {zoomInLabel}
                                </button>
                            ) : null}
                            {zoomOutLabel ? (
                                <button
                                    type="button"
                                    onClick={handleZoomOut}
                                    className="pointer-events-auto rounded-lg border border-slate-700 bg-slate-900/80 px-4 py-2 text-xs uppercase tracking-widest text-slate-200 shadow-lg transition hover:bg-slate-800"
                                >
                                    {zoomOutLabel}
                                </button>
                            ) : null}
                        </div>
                    </div>
                ) : null}
                {resolvedZoomTier === 'surface' && surfaceBody ? (
                    <div className="pointer-events-none absolute inset-0">
                        <div className="pointer-events-auto absolute right-4 bottom-4 w-full max-w-xs rounded-xl border border-slate-800 bg-slate-900/80 p-4 backdrop-blur">
                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                                {t('surfaceView.bodyHeader', { name: surfaceBody.name })}
                            </div>
                            {surfaceMapStatus === 'loading' && (
                                <div className="mt-2 text-xs text-slate-300">
                                    {t('surfaceView.loadingOverlay')}
                                </div>
                            )}
                            {surfaceSelectionInfo ? (
                                <>
                                    <div className="mt-2 text-sm font-semibold text-white">
                                        {surfaceSelectionInfo.coord
                                          ? t('surfaceView.tileCoordinate', { q: surfaceSelectionInfo.coord.q, r: surfaceSelectionInfo.coord.r })
                                          : t('surfaceView.tileId', { id: surfaceSelectionInfo.tileId })}
                                    </div>
                                    {surfaceSelectionInfo.tile && (
                                        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-200">
                                            <div>
                                                <div className="text-[10px] uppercase text-slate-400">
                                                    {t('surfaceView.tileBiome')}
                                                </div>
                                                <div className="font-semibold">{surfaceSelectionInfo.tile.biome}</div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] uppercase text-slate-400">
                                                    {t('surfaceView.tileElevation')}
                                                </div>
                                                <div className="font-semibold">{surfaceSelectionInfo.tile.elev.toFixed(0)}</div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] uppercase text-slate-400">
                                                    {t('surfaceView.tileTemperature')}
                                                </div>
                                                <div className="font-semibold">
                                                    {(surfaceSelectionInfo.tile.tempC2 / 2).toFixed(1)} C
                                                </div>
                                            </div>
                                            <div>
                                                <div className="text-[10px] uppercase text-slate-400">
                                                    {t('surfaceView.tileMoisture')}
                                                </div>
                                                <div className="font-semibold">{surfaceSelectionInfo.tile.moist}</div>
                                            </div>
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="mt-2 text-xs text-slate-500">{t('surfaceView.hoverHint')}</div>
                            )}
                        </div>
                    </div>
                ) : null}
            </FleetNameProvider>
        </div>
      );
  }

  return (
    <div className="relative w-full h-screen">
      {screenContent}
      {loadingState.active ? (
        <LoadingScreen
          progress={loadingState.progress}
          stageLabel={loadingStageLabel}
          detail={loadingDetailText}
          status={loadingState.status}
          errorMessage={loadingState.error?.message ?? null}
          onBack={loadingState.status === 'error' ? handleLoadingBack : undefined}
        />
      ) : null}
    </div>
  );
};

export default App;
