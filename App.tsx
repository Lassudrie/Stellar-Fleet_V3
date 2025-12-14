
import React, { useState, useEffect } from 'react';
import { GameEngine } from './engine/GameEngine';
import { GameState, StarSystem, Fleet, EnemySighting } from './types';
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

type UiMode = 'NONE' | 'SYSTEM_MENU' | 'FLEET_PICKER' | 'BATTLE_SCREEN' | 'INVASION_MODAL';

const App: React.FC = () => {
  const { t } = useI18n();
  const [screen, setScreen] = useState<'MENU' | 'NEW_GAME' | 'LOAD_GAME' | 'GAME' | 'OPTIONS' | 'SCENARIO'>('MENU');
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [viewGameState, setViewGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);

  // UI State
  const [uiMode, setUiMode] = useState<UiMode>('NONE');
  const [selectedFleetId, setSelectedFleetId] = useState<string | null>(null);
  const [targetSystem, setTargetSystem] = useState<StarSystem | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number, y: number } | null>(null);
  const [selectedBattleId, setSelectedBattleId] = useState<string | null>(null);
  const [fleetPickerMode, setFleetPickerMode] = useState<'MOVE' | 'LOAD' | 'UNLOAD' | null>(null);
  
  // Intel State (Persisted visual history of enemies)
  const [enemySightings, setEnemySightings] = useState<Record<string, EnemySighting>>({});

  // Settings
  const [devMode, setDevMode] = useState(false);
  const [godEyes, setGodEyes] = useState(false);
  const [aiDebug, setAiDebug] = useState(false);

  // Function to compute the view state with optional Fog of War logic
  const updateViewState = (baseState: GameState) => {
      let nextView = { ...baseState };
      const playerFactionId = baseState.playerFactionId;
      
      // Apply Fog of War only if rule enabled AND God Eyes disabled
      if (nextView.rules.fogOfWar && !godEyes) {
          nextView = applyFogOfWar(nextView, playerFactionId);
      }
      
      setViewGameState(nextView);

      // --- INTEL UPDATE LOGIC ---
      // Update sightings for any enemy fleet that is currently visible in the view state.
      const visibleEnemies = nextView.fleets.filter(f => f.factionId !== playerFactionId);
      
      if (visibleEnemies.length > 0) {
          setEnemySightings(prev => {
              const next = { ...prev };
              let changed = false;
              
              visibleEnemies.forEach(f => {
                  const existing = next[f.id];
                  if (!existing || existing.daySeen < baseState.day || !equals(existing.position, f.position)) {
                       next[f.id] = {
                           fleetId: f.id,
                           systemId: null, 
                           position: clone(f.position), 
                           daySeen: baseState.day,
                           estimatedPower: calculateFleetPower(f),
                           confidence: 1.0
                       };
                       changed = true;
                  }
              });

              return changed ? next : prev;
          });
      }

      // Edge Case: If the currently selected fleet was hidden by Fog of War, deselect it
      if (selectedFleetId) {
          const fleetExists = nextView.fleets.find(f => f.id === selectedFleetId);
          if (!fleetExists) {
              setSelectedFleetId(null);
              if (uiMode !== 'SYSTEM_MENU') {
                  setFleetPickerMode(null);
                  setUiMode('NONE');
              }
          }
      }
  };

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
    }, [engine, godEyes]);

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
      setUiMode('SYSTEM_MENU');
  };

  const handleFleetSelect = (id: string | null) => {
      setSelectedFleetId(id);
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

  const handleOpenFleetPicker = (mode: 'MOVE' | 'LOAD' | 'UNLOAD') => {
      setFleetPickerMode(mode);
      setUiMode('FLEET_PICKER');
  };

  const handleCloseMenu = () => {
      setFleetPickerMode(null);
      setUiMode('NONE');
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
          engine.dispatchCommand({
              type: 'ADD_LOG',
              text: t('msg.invasionLog', { system: targetSystem.name, count: 1 }),
              logType: 'move'
          });
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

  // Placeholders
  const handleDeploySingle = () => {};
  const handleEmbarkArmy = () => {};

  if (loading) return <LoadingScreen />;

  if (screen === 'MENU') return <MainMenu onNavigate={(s) => setScreen(s === 'OPTIONS' ? 'OPTIONS' : s === 'LOAD_GAME' ? 'LOAD_GAME' : s === 'NEW_GAME' ? 'SCENARIO' : 'MENU')} />;
  if (screen === 'SCENARIO') return <ScenarioSelectScreen onBack={() => setScreen('MENU')} onLaunch={handleLaunchGame} />;
  if (screen === 'LOAD_GAME') return <LoadGameScreen onBack={() => setScreen('MENU')} onLoad={handleLoad} />;
  
  if (screen === 'GAME' && viewGameState && engine) {
      const playerFactionId = viewGameState.playerFactionId;
      const blueFleets = viewGameState.fleets.filter(f => f.factionId === playerFactionId);
      const selectedFleet = viewGameState.fleets.find(f => f.id === selectedFleetId) || null;

      return (
        <div className="relative w-full h-screen overflow-hidden bg-black text-white">
            <GameScene 
                gameState={viewGameState}
                enemySightings={enemySightings}
                onFleetSelect={handleFleetSelect}
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
                logs={viewGameState.logs}
                
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
                winner={viewGameState.winnerFactionId}
                onRestart={() => setScreen('MENU')}
                onNextTurn={handleNextTurn}
                onMoveCommand={handleMoveCommand}
                onLoadCommand={handleLoadCommand}
                onUnloadCommand={handleUnloadCommand}
                onOpenFleetPicker={handleOpenFleetPicker}
                onCloseMenu={handleCloseMenu}
                fleetPickerMode={fleetPickerMode}
                onSelectFleet={setSelectedFleetId}

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
                    setAiDebug(s.aiDebug || false);
                }}
            />
        </div>
      );
  }

  return null;
};

export default App;
