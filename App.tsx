
import React, { useState, useEffect } from 'react';
import { ThreeEvent } from '@react-three/fiber';
import { GameEngine } from './engine/GameEngine';
import { GameState, StarSystem, Fleet, EnemySighting } from './types';
import GameScene from './components/GameScene';
import UI from './components/UI';
import MainMenu from './components/screens/MainMenu';
import NewGameScreen from './components/screens/NewGameScreen';
import LoadGameScreen from './components/screens/LoadGameScreen';
import ScenarioSelectScreen from './components/screens/ScenarioSelectScreen';
import OptionsScreen from './components/screens/OptionsScreen';
import { buildScenario } from './scenarios';
import { GameScenario } from './scenarios/types';
import { generateWorld } from './engine/systems/world/worldGenerator';
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
  const [targetSystem, setTargetSystem] = useState<StarSystem | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number, y: number } | null>(null);
  const [selectedBattleId, setSelectedBattleId] = useState<string | null>(null);
  
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
      if (nextView.selectedFleetId) {
          const fleetExists = nextView.fleets.find(f => f.id === nextView.selectedFleetId);
          if (!fleetExists) {
              if (engine) engine.setSelectedFleetId(null);
              if (uiMode !== 'SYSTEM_MENU') {
                  setUiMode('NONE');
              }
          }
      }
  };

  // Helper to force reference changes for React.memo until engine is fully immutable
  const getViewSnapshot = (state: GameState): GameState => ({
      ...state,
      fleets: [...state.fleets],
      systems: [...state.systems],
      armies: [...state.armies],
      lasers: [...state.lasers],
      battles: [...state.battles],
      logs: [...state.logs],
  });

  useEffect(() => {
    if (engine) {
      updateViewState(getViewSnapshot(engine.state));
      
      const unsub = engine.subscribe(() => {
        updateViewState(getViewSnapshot(engine.state));
      });
      return unsub;
    }
  }, [engine, godEyes]); 

  const handleLaunchGame = (scenarioArg: number | GameScenario) => {
    setLoading(true);
    setEnemySightings({}); 
    setTimeout(() => {
        // Handle both simple seed (number) and full Scenario object
        let scenario: GameScenario;
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
          newEngine.setSelectedFleetId(null);
          setEngine(newEngine);
          
          setEnemySightings({}); 
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

  const handleSystemClick = (sys: StarSystem, event: ThreeEvent<MouseEvent>) => {
      setTargetSystem(sys);
      setMenuPosition({ x: event.clientX, y: event.clientY });
      setUiMode('SYSTEM_MENU');
  };

  const handleFleetSelect = (id: string | null) => {
      if (engine) engine.setSelectedFleetId(id);
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
          setUiMode('NONE');
      }
  };

  const handleOpenFleetPicker = () => {
      setUiMode('FLEET_PICKER');
  };

  const handleInvade = (systemId: string) => {
      const system = viewGameState?.systems.find(s => s.id === systemId);
      if (!system) return;
      setTargetSystem(system);
      setUiMode('INVASION_MODAL');
  };

  const handleCommitInvasion = (fleetId: string) => { 
      if (!targetSystem || !engine) return;

      const result = engine.dispatchPlayerCommand({
          type: 'ORDER_INVASION',
          fleetId: fleetId,
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

      setUiMode('NONE');
  };

  const handleSplitFleet = (shipIds: string[]) => {
      if (engine && engine.state.selectedFleetId) {
          engine.dispatchPlayerCommand({
              type: 'SPLIT_FLEET',
              originalFleetId: engine.state.selectedFleetId,
              shipIds
          });
      }
  };

  const handleMergeFleet = (targetFleetId: string) => {
      if (engine && engine.state.selectedFleetId) {
          engine.dispatchPlayerCommand({
              type: 'MERGE_FLEETS',
              sourceFleetId: engine.state.selectedFleetId,
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
  if (screen === 'OPTIONS') return <OptionsScreen onBack={() => setScreen('MENU')} />;
  
  if (screen === 'GAME' && viewGameState && engine) {
      const playerFactionId = viewGameState.playerFactionId;
      const blueFleets = viewGameState.fleets.filter(f => f.factionId === playerFactionId);
      const selectedFleet = viewGameState.fleets.find(f => f.id === viewGameState.selectedFleetId) || null;

      return (
        <div className="relative w-full h-screen overflow-hidden bg-black text-white">
            <GameScene 
                gameState={viewGameState}
                enemySightings={enemySightings}
                onFleetSelect={handleFleetSelect}
                onSystemClick={handleSystemClick}
                onBackgroundClick={() => {
                    setUiMode('NONE');
                    if (engine) engine.setSelectedFleetId(null);
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
                onOpenFleetPicker={handleOpenFleetPicker}
                onCloseMenu={() => setUiMode('NONE')}
                onSelectFleet={handleFleetSelect}
                
                onOpenBattle={(id) => {
                    setSelectedBattleId(id);
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
