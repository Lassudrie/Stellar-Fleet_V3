
import React, { useState, useMemo } from 'react';
import { Fleet, StarSystem, LogEntry, Battle, GameState, FleetState, ArmyState, FactionId } from '../types';
import VictoryScreen from './ui/VictoryScreen';
import TopBar from './ui/TopBar';
import SideMenu from './ui/SideMenu';
import SystemContextMenu from './ui/SystemContextMenu';
import FleetPicker from './ui/FleetPicker';
import FleetPanel from './ui/FleetPanel';
import BattleScreen from './ui/BattleScreen';
import InvasionModal from './ui/InvasionModal';
import OrbitingFleetPicker from './ui/OrbitingFleetPicker';
import { hasInvadingForce } from '../engine/army';
import { ORBIT_RADIUS } from '../data/static';
import { distSq, dist } from '../engine/math/vec3';

interface UIProps {
  startYear: number;
  day: number;
  selectedFleet: Fleet | null;
  logs: LogEntry[];
  
  uiMode: 'NONE' | 'SYSTEM_MENU' | 'FLEET_PICKER' | 'BATTLE_SCREEN' | 'INVASION_MODAL' | 'ORBIT_FLEET_PICKER';
  menuPosition: { x: number, y: number } | null;
  targetSystem: StarSystem | null;
  systems: StarSystem[];
  blueFleets: Fleet[]; // "My Fleets"
  battles?: Battle[]; 
  selectedBattleId?: string | null;
  gameState: GameState;
  
  onSplit: (shipIds: string[]) => void;
  onMerge: (targetFleetId: string) => void;
  onDeploy: (shipId: string) => void;
  onEmbark: (shipId: string, armyId: string) => void;
  winner: FactionId | null; // Changed type
  onRestart: () => void;
  onNextTurn: () => void;
  onMoveCommand: (fleetId: string) => void;
  onAttackCommand: (fleetId: string) => void;
  onLoadCommand: (fleetId: string) => void;
  onUnloadCommand: (fleetId: string) => void;
  onOpenFleetPicker: (mode: 'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK') => void;
  onOpenOrbitingFleetPicker: () => void;
  onCloseMenu: () => void;
  onSelectFleet: (fleetId: string) => void;
  fleetPickerMode: 'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK' | null;

  onOpenBattle: (battleId: string) => void;
  onInvade: (systemId: string) => void;
  onCommitInvasion: (fleetId: string) => void;

  onSave: () => void;

  devMode: boolean;
  godEyes: boolean;
  onSetUiSettings: (settings: { devMode: boolean, godEyes: boolean, aiDebug?: boolean }) => void;
}

const UI: React.FC<UIProps> = ({ 
    startYear, day, selectedFleet, onSplit, onMerge, onDeploy, onEmbark, winner, logs,
    onRestart, onNextTurn, 
    uiMode, menuPosition, targetSystem, systems, blueFleets, battles,
    selectedBattleId, gameState,
    onMoveCommand, onAttackCommand, onLoadCommand, onUnloadCommand, onOpenFleetPicker, onOpenOrbitingFleetPicker, onCloseMenu, onSelectFleet,
    fleetPickerMode,
    onOpenBattle, onInvade, onCommitInvasion,
    onSave,
    devMode, godEyes, onSetUiSettings
}) => {
  
  const [isSideMenuOpen, setIsSideMenuOpen] = useState(false);
  const [debugMode, setDebugMode] = useState(false);

  // Helper to check ownership against current player
  const playerFactionId = gameState.playerFactionId;

  // Compute nearby fleets suitable for merging
  const mergeCandidates = useMemo(() => {
    if (!selectedFleet) return [];
    if (selectedFleet.state !== FleetState.ORBIT) return [];
    
    // Only merge own fleets
    if (selectedFleet.factionId !== playerFactionId) return [];

    return blueFleets.filter(f => 
        f.id !== selectedFleet.id &&
        f.state === FleetState.ORBIT &&
        dist(f.position, selectedFleet.position) < 8.0 
    );
  }, [selectedFleet, blueFleets, playerFactionId]);

  // Compute Ground Context for FleetPanel
  const { orbitingSystem, availableArmies } = useMemo(() => {
      if (!selectedFleet || selectedFleet.state !== FleetState.ORBIT) {
          return { orbitingSystem: null, availableArmies: [] };
      }

      const orbitThresholdSq = (ORBIT_RADIUS * 3) ** 2;
      const sys = systems.find(s => distSq(selectedFleet.position, s.position) <= orbitThresholdSq);
      
      if (!sys) return { orbitingSystem: null, availableArmies: [] };

      // Get armies at this system belonging to Player
      const armies = gameState.armies
          .filter(a => a.containerId === sys.id && a.factionId === playerFactionId && a.state === ArmyState.DEPLOYED)
          .sort((a, b) => a.id.localeCompare(b.id));

      return { orbitingSystem: sys, availableArmies: armies };
  }, [selectedFleet, systems, gameState.armies, playerFactionId]);

  // Compute INVASION Visibility
  // Rules: Enemy system + At least one player fleet carrying armies
  const showInvadeOption = useMemo(() => {
      if (!targetSystem) return false;

      if (targetSystem.ownerFactionId === playerFactionId) return false;

      return blueFleets.some(hasInvadingForce);
  }, [targetSystem, blueFleets, playerFactionId]);

  const showAttackOption = useMemo(() => {
      if (!targetSystem) return false;
      return targetSystem.ownerFactionId !== playerFactionId;
  }, [targetSystem, playerFactionId]);

  const showLoadOption = useMemo(() => {
      if (!targetSystem) return false;

      return gameState.armies.some(army =>
          army.containerId === targetSystem.id &&
          army.factionId === playerFactionId &&
          army.state === ArmyState.DEPLOYED
      );
  }, [targetSystem, gameState.armies, playerFactionId]);

  const showUnloadOption = useMemo(() => {
      if (!targetSystem) return false;
      if (targetSystem.ownerFactionId !== playerFactionId) return false;

      const playerFleetIds = new Set(blueFleets.map(fleet => fleet.id));

      return gameState.armies.some(army =>
          army.factionId === playerFactionId &&
          army.state === ArmyState.EMBARKED &&
          playerFleetIds.has(army.containerId)
      );
  }, [targetSystem, blueFleets, gameState.armies, playerFactionId]);

  const orbitingPlayerFleets = useMemo(() => {
      if (!targetSystem) return [];

      const orbitThresholdSq = (ORBIT_RADIUS * 3) ** 2;

      return blueFleets
          .filter(fleet => (
              fleet.state === FleetState.ORBIT &&
              distSq(fleet.position, targetSystem.position) <= orbitThresholdSq
          ))
          .sort((a, b) => {
              const sizeDiff = b.ships.length - a.ships.length;
              if (sizeDiff !== 0) return sizeDiff;
              return a.id.localeCompare(b.id);
          });
  }, [blueFleets, targetSystem]);

  // Compute Ground Forces Summary for Context Menu
  const groundForcesSummary = useMemo(() => {
      if (!targetSystem || !gameState.armies) return null;
      
      let playerForces = 0;
      let playerPower = 0;
      let enemyForces = 0;
      let enemyPower = 0;

      gameState.armies.forEach(army => {
          if (army.containerId === targetSystem.id && army.state === ArmyState.DEPLOYED) {
              if (army.factionId === playerFactionId) {
                  playerForces++;
                  playerPower += army.strength;
              } else {
                  enemyForces++;
                  enemyPower += army.strength;
              }
          }
      });

      if (playerForces === 0 && enemyForces === 0) return null;

      return { blueCount: playerForces, bluePower: playerPower, redCount: enemyForces, redPower: enemyPower };
  }, [targetSystem, gameState.armies, playerFactionId]);

  const handleSelectFleetAtSystem = () => {
      if (orbitingPlayerFleets.length === 0) return;

      if (orbitingPlayerFleets.length === 1) {
          onSelectFleet(orbitingPlayerFleets[0].id);
          onCloseMenu();
          return;
      }

      onOpenOrbitingFleetPicker();
  };

  return (
    <div className="absolute inset-0 pointer-events-none safe-area">
      
      <TopBar 
        startYear={startYear}
        day={day}
        battles={battles}
        onToggleMenu={() => setIsSideMenuOpen(true)}
        onNextTurn={onNextTurn}
        onOpenBattle={onOpenBattle}
        onDebugBattle={devMode ? () => setDebugMode(true) : undefined}
      />

      <SideMenu 
        isOpen={isSideMenuOpen}
        onClose={() => setIsSideMenuOpen(false)}
        logs={logs}
        blueFleets={blueFleets}
        systems={systems}
        onRestart={onRestart}
        onSelectFleet={onSelectFleet}
        onSave={onSave}
        
        devMode={devMode}
        godEyes={godEyes}
        onSetUiSettings={onSetUiSettings}
        
        onExportAiLogs={(window as any)._exportAiLogs}
        onClearAiLogs={(window as any)._clearAiLogs}
        
        // Pass PlayerID for ownership checks
        playerFactionId={playerFactionId}
      />

      {uiMode === 'SYSTEM_MENU' && menuPosition && targetSystem && (
        <SystemContextMenu
            position={menuPosition}
            system={targetSystem}
            groundForces={groundForcesSummary}
            showInvadeOption={showInvadeOption}
            showAttackOption={showAttackOption}
            showLoadOption={showLoadOption}
            showUnloadOption={showUnloadOption}
            canSelectFleet={orbitingPlayerFleets.length > 0}
            onSelectFleetAtSystem={handleSelectFleetAtSystem}
            onOpenFleetPicker={() => onOpenFleetPicker('MOVE')}
            onOpenLoadPicker={() => onOpenFleetPicker('LOAD')}
            onOpenUnloadPicker={() => onOpenFleetPicker('UNLOAD')}
            onInvade={() => onInvade(targetSystem.id)}
            onAttack={() => onOpenFleetPicker('ATTACK')}
            onClose={onCloseMenu}
        />
      )}

      {uiMode === 'FLEET_PICKER' && targetSystem && (
        <FleetPicker
            mode={fleetPickerMode || 'MOVE'}
            targetSystem={targetSystem}
            blueFleets={blueFleets}
            onSelectFleet={(fleetId) => {
                if (fleetPickerMode === 'LOAD') return onLoadCommand(fleetId);
                if (fleetPickerMode === 'UNLOAD') return onUnloadCommand(fleetId);
                if (fleetPickerMode === 'ATTACK') return onAttackCommand(fleetId);
                return onMoveCommand(fleetId);
            }}
            onClose={onCloseMenu}
        />
      )}

      {uiMode === 'ORBIT_FLEET_PICKER' && targetSystem && (
        <OrbitingFleetPicker
            system={targetSystem}
            fleets={orbitingPlayerFleets}
            onSelect={(fleetId) => { onSelectFleet(fleetId); onCloseMenu(); }}
            onClose={onCloseMenu}
        />
      )}

      {uiMode === 'INVASION_MODAL' && targetSystem && (
        <InvasionModal
            targetSystem={targetSystem}
            fleets={blueFleets}
            onConfirm={onCommitInvasion}
            onClose={onCloseMenu}
            playerFactionId={playerFactionId}
        />
      )}

      {selectedFleet && uiMode === 'NONE' && (
        <FleetPanel 
            fleet={selectedFleet}
            otherFleetsInSystem={mergeCandidates}
            onSplit={onSplit}
            onMerge={onMerge}
            currentSystem={orbitingSystem}
            availableArmies={availableArmies}
            onDeploy={onDeploy}
            onEmbark={onEmbark}
            playerFactionId={playerFactionId}
        />
      )}

      {uiMode === 'BATTLE_SCREEN' && (
          <BattleScreen 
              battleId={selectedBattleId || undefined}
              gameState={gameState}
              onClose={onCloseMenu}
          />
      )}
      
      {winner && (
        <VictoryScreen 
            winner={winner} 
            playerFactionId={playerFactionId}
            day={day} 
            onRestart={onRestart} 
        />
      )}
    </div>
  );
};

export default UI;
