
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
import { TroopTransferModal } from './ui/modals/TroopTransferModal';
import { hasInvadingForce } from '../engine/army';
import { ORBIT_RADIUS } from '../data/static';
import { distSq, dist } from '../engine/math/vec3';

interface UIProps {
  startYear: number;
  day: number;
  selectedFleet: Fleet | null;
  logs: LogEntry[];
  
  uiMode: 'NONE' | 'SYSTEM_MENU' | 'FLEET_PICKER' | 'BATTLE_SCREEN' | 'INVASION_MODAL' | 'TROOP_TRANSFER_MODAL';
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
  onOpenFleetPicker: () => void;
  onCloseMenu: () => void;
  onSelectFleet: (fleetId: string) => void;
  
  onOpenBattle: (battleId: string) => void;
  onInvade: (systemId: string) => void;
  onCommitInvasion: (fleetId: string) => void;
  onOpenTroopTransfer: (fleetId: string, mode: 'embark' | 'disembark') => void;
  onTroopTransferConfirm: (updatedWorld: GameState) => void;

  troopTransferMode: 'embark' | 'disembark' | null;
  troopTransferFleetId: string | null;

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
    onMoveCommand, onOpenFleetPicker, onCloseMenu, onSelectFleet,
    onOpenBattle, onInvade, onCommitInvasion,
    onOpenTroopTransfer, onTroopTransferConfirm,
    troopTransferMode, troopTransferFleetId,
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
  // Rules: Not owned by player + Player Fleet in Orbit + Contains Loaded Troop Transport
  const showInvadeOption = useMemo(() => {
      if (!targetSystem) return false;
      
      if (targetSystem.ownerFactionId === playerFactionId) return false;

      const detectionDistSq = (ORBIT_RADIUS * 2.5) ** 2; 

      return blueFleets.some(f => 
          f.state === FleetState.ORBIT &&
          distSq(f.position, targetSystem.position) < detectionDistSq &&
          hasInvadingForce(f)
      );
  }, [targetSystem, blueFleets, playerFactionId]);

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
            onOpenFleetPicker={onOpenFleetPicker}
            onInvade={() => onInvade(targetSystem.id)}
            onClose={onCloseMenu}
        />
      )}

      {uiMode === 'FLEET_PICKER' && targetSystem && (
        <FleetPicker 
            targetSystem={targetSystem}
            blueFleets={blueFleets}
            onMoveCommand={onMoveCommand}
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

      {uiMode === 'TROOP_TRANSFER_MODAL' && troopTransferMode && troopTransferFleetId && (
        <TroopTransferModal
            isOpen={true}
            mode={troopTransferMode}
            fleetId={troopTransferFleetId}
            world={gameState}
            onConfirm={onTroopTransferConfirm}
            onClose={onCloseMenu}
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
            onOpenTroopTransfer={onOpenTroopTransfer}
            playerFactionId={playerFactionId}
            gameState={gameState}
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
