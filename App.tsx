
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GameEngine } from './engine/GameEngine';
import { GameMessage, GameState, StarSystem, Fleet, EnemySighting, FleetState } from './types';
import GameScene from './components/GameScene';
import UI from './components/UI';
import MainMenu from './components/screens/MainMenu';
import NewGameScreen from './components/screens/NewGameScreen';
import LoadGameScreen from './components/screens/LoadGameScreen';
import ScenarioSelectScreen from './components/screens/ScenarioSelectScreen';
import { buildScenario } from './scenarios';
import { generateWorld } from './services/world/worldGenerator';
import { useI18n } from './i18n';
import LoadingScreen from './components/ui/LoadingScreen';
import { applyFogOfWar } from './engine/fogOfWar';
import { calculateFleetPower } from './engine/world';
import { clone, equals } from './engine/math/vec3';
import { serializeGameState, deserializeGameState } from './engine/serialization';
import { useButtonClickSound } from './services/audio/useButtonClickSound';
import { aiDebugger } from './engine/aiDebugger';
import { findOrbitingSystem } from './components/ui/orbiting';

type UiMode = 'NONE' | 'SYSTEM_MENU' | 'FLEET_PICKER' | 'BATTLE_SCREEN' | 'INVASION_MODAL' | 'ORBIT_FLEET_PICKER' | 'SHIP_DETAIL_MODAL' | 'GROUND_OPS_MODAL';

const ENEMY_SIGHTING_MAX_AGE_DAYS = 30;
const ENEMY_SIGHTING_LIMIT = 200;

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

  // Settings
  const [devMode, setDevMode] = useState(false);
  const [godEyes, setGodEyes] = useState(false);
  const [aiDebug, setAiDebug] = useState(false);

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
  };

  const handleClearAiLogs = () => {
      aiDebugger.clear();
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
              const keepIds = new Set(entries
                  .sort((a, b) => b.daySeen - a.daySeen)
                  .slice(0, ENEMY_SIGHTING_LIMIT)
                  .map(s => s.fleetId));

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
      if (!engine) return;
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
      } catch (e) {
          console.error("Save failed:", e);
          alert(t('msg.saveFail'));
      }
  };

  const handleLoad = async (file: File) => {
      setLoading(true);
      try {
          const text = await file.text();
          const state = deserializeGameState(text);
          
          const newEngine = new GameEngine(state);
          setEngine(newEngine);

          setEnemySightings({});
          setSelectedFleetId(null);
          setFleetPickerMode(null);
          setUiMode('NONE');
          
          updateViewState(newEngine.state);
          
          setScreen('GAME');
      } catch (e) {
          console.error("Load failed:", e);
          alert(t('msg.invalidSave') + "\n" + (e as Error).message);
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
          engine.dispatchPlayerCommand({
              type: 'MOVE_FLEET',
              fleetId,
              targetSystemId: targetSystem.id
          });
          setFleetPickerMode(null);
          setUiMode('NONE');
      }
  };

  const handleAttackCommand = (fleetId: string) => {
      if (engine && targetSystem) {
          engine.dispatchPlayerCommand({
              type: 'MOVE_FLEET',
              fleetId,
              targetSystemId: targetSystem.id
          });
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
          if (!result.ok) {
              alert(t('msg.commandFailed', { error: result.error }));
              return;
          }
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
          if (!result.ok) {
              alert(t('msg.commandFailed', { error: result.error }));
              return;
          }
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
      if (!targetSystem) return;
      setFleetPickerMode(null);
      setUiMode('GROUND_OPS_MODAL');
  };

  const handleOpenSystemDetails = () => {
      if (!targetSystem || !viewGameState) return;
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
      if (!system) return;
      setTargetSystem(system);
      setFleetPickerMode(null);
      setUiMode('INVASION_MODAL');
  };

  const handleCommitInvasion = (fleetId: string) => {
      const fId = fleetId;
      if (!targetSystem || !engine) return;

      const result = engine.dispatchPlayerCommand({
          type: 'ORDER_INVASION',
          fleetId: fId,
          targetSystemId: targetSystem.id
      });

      if (result.ok) {
          if (typeof result.deployedArmies === 'number') {
              engine.dispatchCommand({
                  type: 'ADD_LOG',
                  text: t('msg.invasionLog', { system: targetSystem.name, count: result.deployedArmies }),
                  logType: 'move'
              });
          }
      } else {
          alert(t('msg.commandFailed', { error: result.error }));
      }

      handleCloseMenu();
  };

  const handleSplitFleet = (shipIds: string[]) => {
      if (engine && selectedFleetId) {
          engine.dispatchPlayerCommand({
              type: 'SPLIT_FLEET',
              originalFleetId: selectedFleetId,
              shipIds
          });
      }
  };

  const handleMergeFleet = (targetFleetId: string) => {
      if (engine && selectedFleetId) {
          engine.dispatchPlayerCommand({
              type: 'MERGE_FLEETS',
              sourceFleetId: selectedFleetId,
              targetFleetId
          });
      }
  };

  const handleDeploySingle = (shipId: string, planetId: string) => {
      if (!engine || !selectedFleetId) return;

      const fleet = engine.state.fleets.find(f => f.id === selectedFleetId) || null;
      const system = findOrbitingSystem(fleet, engine.state.systems);
      if (!fleet || !system) return;

      const ship = fleet.ships.find(s => s.id === shipId);
      if (!ship || !ship.carriedArmyId) return;

      const targetPlanet = system.planets.find(planet => planet.id === planetId && planet.isSolid);
      if (!targetPlanet) return;

      engine.dispatchCommand({
          type: 'UNLOAD_ARMY',
          fleetId: fleet.id,
          shipId: ship.id,
          armyId: ship.carriedArmyId,
          systemId: system.id,
          planetId: targetPlanet.id
      });
  };

  const handleEmbarkArmy = (shipId: string, armyId: string) => {
      if (!engine || !selectedFleetId) return;

      const fleet = engine.state.fleets.find(f => f.id === selectedFleetId) || null;
      const system = findOrbitingSystem(fleet, engine.state.systems);
      if (!fleet || !system) return;

      engine.dispatchCommand({
          type: 'LOAD_ARMY',
          fleetId: fleet.id,
          shipId,
          armyId,
          systemId: system.id
      });
  };

  const handleTransferArmy = (systemId: string, armyId: string, fromPlanetId: string, toPlanetId: string) => {
      if (!engine) return;

      engine.dispatchCommand({
          type: 'TRANSFER_ARMY_PLANET',
          armyId,
          fromPlanetId,
          toPlanetId,
          systemId
      });
  };

  const handleDismissMessage = (messageId: string) => {
      if (!engine) return;
      engine.dismissMessage(messageId);
  };

  const handleMarkMessageRead = (messageId: string, read: boolean) => {
      if (!engine) return;
      engine.markMessageRead(messageId, read);
  };

  const handleMarkAllMessagesRead = () => {
      if (!engine) return;
      engine.markAllMessagesRead();
  };

  const handleDismissReadMessages = () => {
      if (!engine) return;
      engine.dismissReadMessages();
  };

  const handleOpenMessage = (message: GameMessage) => {
      if (!engine || !viewGameState) return;
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
                messages={viewGameState.messages}
                
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
                    setAiDebug(enableAiDebug);
                    aiDebugger.setEnabled(enableAiDebug);
                }}
                onExportAiLogs={handleExportAiLogs}
                onClearAiLogs={handleClearAiLogs}
                onDismissMessage={handleDismissMessage}
                onOpenMessage={handleOpenMessage}
                onMarkMessageRead={handleMarkMessageRead}
                onMarkAllMessagesRead={handleMarkAllMessagesRead}
                onDismissReadMessages={handleDismissReadMessages}
            />
        </div>
      );
  }

  return null;
};

export default App;
