
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GameEngine } from '../engine/GameEngine';
import { GameMessage, GameState, StarSystem, EnemySighting } from '../shared/types';
import GameScene from './components/GameScene';
import UI from './components/UI';
import { FleetNameProvider } from './context/FleetNames';
import MainMenu from './components/screens/MainMenu';
import LoadGameScreen from './components/screens/LoadGameScreen';
import ScenarioSelectScreen from './components/screens/ScenarioSelectScreen';
import { buildScenario } from '../content/scenarios';
import { generateWorld } from '../engine/worldgen/worldGenerator';
import { useI18n } from './i18n';
import LoadingScreen from './components/ui/LoadingScreen';
import { applyFogOfWar } from '../engine/fogOfWar';
import { calculateFleetPower } from '../engine/world';
import { clone, equals } from '../engine/math/vec3';
import { serializeGameState, deserializeGameState } from '../engine/serialization';
import { useButtonClickSound } from './audio/useButtonClickSound';
import { aiDebugger } from '../engine/aiDebugger';
import { findOrbitingSystem } from './components/ui/orbiting';
import { processCommandResult } from './commands/processCommandResult';
import { sorted } from '../shared/sorting';

type UiMode = 'NONE' | 'SYSTEM_MENU' | 'FLEET_PICKER' | 'BATTLE_SCREEN' | 'INVASION_MODAL' | 'ORBIT_FLEET_PICKER' | 'SHIP_DETAIL_MODAL' | 'GROUND_OPS_MODAL';

const ENEMY_SIGHTING_MAX_AGE_DAYS = 30;
const ENEMY_SIGHTING_LIMIT = 200;
const MAX_SAVE_BYTES = 25 * 1024 * 1024;

const App: React.FC = () => {
  const { t } = useI18n();
  useButtonClickSound();
  const [screen, setScreen] = useState<'MENU' | 'NEW_GAME' | 'LOAD_GAME' | 'GAME' | 'SCENARIO'>('MENU');
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [viewGameState, setViewGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);

  // UI State
  const [uiMode, setUiMode] = useState<UiMode>('NONE');
  const [selectedFleetId, setSelectedFleetId] = useState<string | null>(null);
  const [inspectedFleetId, setInspectedFleetId] = useState<string | null>(null);
  const [targetSystem, setTargetSystem] = useState<StarSystem | null>(null);
  const [systemDetailSystem, setSystemDetailSystem] = useState<StarSystem | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number, y: number } | null>(null);
  const [selectedBattleId, setSelectedBattleId] = useState<string | null>(null);
  const [fleetPickerMode, setFleetPickerMode] = useState<'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK' | null>(null);
  
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
                  sorted(entries, (a, b) => b.daySeen - a.daySeen)
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

  const handleLaunchGame = (scenarioArg: any) => {
    setLoading(true);
    setEnemySightings({}); 
    setUiMessages([]);
    setTimeout(() => {
        // Handle both simple seed (number) and full Scenario object
        let scenario;
        if (typeof scenarioArg === 'number') {
             scenario = buildScenario('conquest_sandbox', scenarioArg);
        } else {
             scenario = scenarioArg;
        }

        const { state } = generateWorld(scenario);
        const newEngine = new GameEngine(state);
        setEngine(newEngine);
        setScreen('GAME');
        setLoading(false);
    }, 500);
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
      setLoading(true);
      try {
          if (file.size > MAX_SAVE_BYTES) {
              throw new Error(`Save file exceeds ${Math.floor(MAX_SAVE_BYTES / (1024 * 1024))}MB limit.`);
          }
          const text = await file.text();
          const state = deserializeGameState(text);
          
          const newEngine = new GameEngine(state);
          setEngine(newEngine);

          setEnemySightings({});
          setSelectedFleetId(null);
          setFleetPickerMode(null);
          setUiMode('NONE');
          setUiMessages([]);
          
          updateViewState(newEngine.state);
          
          setScreen('GAME');
          addUiMessage({
              title: t('msg.loadSuccessTitle'),
              subtitle: t('msg.loadSuccess'),
              lines: [],
              priority: 1,
              type: 'ui'
          });
      } catch (e) {
          console.error("Load failed:", e);
          addUiMessage({
              title: t('msg.loadFailTitle'),
              subtitle: t('msg.invalidSave'),
              lines: [(e as Error).message],
              priority: 2,
              type: 'ui'
          });
      } finally {
          setLoading(false);
      }
  };

  // --- INTERACTION HANDLERS ---

  const handleSystemClick = (sys: StarSystem, event: any) => {
      setTargetSystem(sys);
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

  const handleCommitInvasion = (fleetId: string) => {
      const fId = fleetId;
      if (!targetSystem || !engine) {
          console.warn('[App] handleCommitInvasion: Missing targetSystem or engine');
          return;
      }

      const result = engine.dispatchPlayerCommand({
          type: 'ORDER_INVASION',
          fleetId: fId,
          targetSystemId: targetSystem.id
      });

      if (processCommandResult(result, notifyCommandError) && typeof result.deployedArmies === 'number') {
          engine.dispatchCommand({
              type: 'ADD_LOG',
              text: t('msg.invasionLog', { system: targetSystem.name, count: result.deployedArmies }),
              logType: 'move'
          });
      }

      handleCloseMenu();
  };

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

  if (loading) return <LoadingScreen />;

  if (screen === 'MENU') return <MainMenu onNavigate={(s) => setScreen(s === 'LOAD_GAME' ? 'LOAD_GAME' : 'SCENARIO')} />;
  if (screen === 'SCENARIO') return <ScenarioSelectScreen onBack={() => setScreen('MENU')} onLaunch={handleLaunchGame} />;
  if (screen === 'LOAD_GAME') return <LoadGameScreen onBack={() => setScreen('MENU')} onLoad={handleLoad} />;
  
  if (screen === 'GAME' && viewGameState && engine) {
      const playerFactionId = viewGameState.playerFactionId;
      const blueFleets = viewGameState.fleets.filter(f => f.factionId === playerFactionId);
      const selectedFleet = viewGameState.fleets.find(f => f.id === selectedFleetId) || null;
      const inspectedFleet = viewGameState.fleets.find(f => f.id === inspectedFleetId) || null;

      return (
        <div className="relative w-full h-screen overflow-hidden bg-black text-white">
            <FleetNameProvider fleets={viewGameState.fleets}>
                <GameScene
                    gameState={viewGameState}
                    enemySightings={enemySightings}
                    selectedFleetId={selectedFleetId}
                    onFleetSelect={handleFleetSelect}
                    onFleetInspect={handleFleetInspect}
                    onSystemClick={handleSystemClick}
                    onBackgroundClick={() => {
                        handleCloseMenu();
                        setSelectedFleetId(null);
                    }}
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
            </FleetNameProvider>
        </div>
      );
}

  return null;
};

export default App;
