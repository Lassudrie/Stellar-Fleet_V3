
import React, { useState, useMemo } from 'react';
import { Fleet, StarSystem, LogEntry, Battle, GameState, FleetState, ArmyState, FactionId, FactionState, GameMessage } from '../types';
import VictoryScreen from './ui/VictoryScreen';
import TopBar from './ui/TopBar';
import SideMenu from './ui/SideMenu';
import SystemContextMenu, { GroundForceSummaryEntry } from './ui/SystemContextMenu';
import FleetPicker from './ui/FleetPicker';
import FleetPanel, { AvailableArmy } from './ui/FleetPanel';
import BattleScreen from './ui/BattleScreen';
import InvasionModal from './ui/InvasionModal';
import OrbitingFleetPicker from './ui/OrbitingFleetPicker';
import ShipDetailModal from './ui/ShipDetailModal';
import SystemDetailModal from './ui/SystemDetailModal';
import GroundOpsModal from './ui/GroundOpsModal';
import { hasInvadingForce } from '../engine/army';
import { distSq, dist } from '../engine/math/vec3';
import { findOrbitingSystem } from './ui/orbiting';
import { ORBIT_PROXIMITY_RANGE_SQ } from '../data/static';
import MessageToasts from './ui/MessageToasts';

const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

interface UIProps {
  startYear: number;
  day: number;
  selectedFleet: Fleet | null;
  inspectedFleet: Fleet | null;
  logs: LogEntry[];
  messages: GameMessage[];

  uiMode: 'NONE' | 'SYSTEM_MENU' | 'FLEET_PICKER' | 'BATTLE_SCREEN' | 'INVASION_MODAL' | 'ORBIT_FLEET_PICKER' | 'SHIP_DETAIL_MODAL' | 'GROUND_OPS_MODAL';
  menuPosition: { x: number, y: number } | null;
  targetSystem: StarSystem | null;
  systems: StarSystem[];
  blueFleets: Fleet[]; // "My Fleets"
  battles?: Battle[]; 
  selectedBattleId?: string | null;
  gameState: GameState;
  
  onSplit: (shipIds: string[]) => void;
  onMerge: (targetFleetId: string) => void;
  onDeploy: (shipId: string, planetId: string) => void;
  onEmbark: (shipId: string, armyId: string) => void;
  onTransferArmy: (systemId: string, armyId: string, fromPlanetId: string, toPlanetId: string) => void;
  winner: FactionId | 'draw' | null; // Changed type
  onRestart: () => void;
  onNextTurn: () => void;
  onMoveCommand: (fleetId: string) => void;
  onAttackCommand: (fleetId: string) => void;
  onLoadCommand: (fleetId: string) => void;
  onUnloadCommand: (fleetId: string) => void;
  onOpenFleetPicker: (mode: 'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK') => void;
  onOpenOrbitingFleetPicker: () => void;
  onOpenGroundOps: () => void;
  onCloseMenu: () => void;
  onSelectFleet: (fleetId: string) => void;
  onInspectFleet: (fleetId: string) => void;
  onOpenSystemDetails: () => void;
  systemDetailSystem: StarSystem | null;
  onCloseSystemDetails: () => void;
  fleetPickerMode: 'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK' | null;
  onCloseShipDetail: () => void;

  onOpenBattle: (battleId: string) => void;
  onInvade: (systemId: string) => void;
  onCommitInvasion: (fleetId: string) => void;

  onSave: () => void;
  onExportAiLogs?: () => void;
  onClearAiLogs?: () => void;

  devMode: boolean;
  godEyes: boolean;
  onSetUiSettings: (settings: { devMode: boolean, godEyes: boolean, aiDebug?: boolean }) => void;

  onDismissMessage: (messageId: string) => void;
  onOpenMessage: (message: GameMessage) => void;
  onMarkMessageRead: (messageId: string, read: boolean) => void;
  onMarkAllMessagesRead: () => void;
  onDismissReadMessages: () => void;
}

const UI: React.FC<UIProps> = ({
    startYear, day, selectedFleet, inspectedFleet, onSplit, onMerge, onDeploy, onEmbark, onTransferArmy, winner, logs, messages,
    onRestart, onNextTurn,
    uiMode, menuPosition, targetSystem, systems, blueFleets, battles,
    selectedBattleId, gameState,
    onMoveCommand, onAttackCommand, onLoadCommand, onUnloadCommand, onOpenFleetPicker, onOpenOrbitingFleetPicker, onOpenGroundOps, onCloseMenu, onSelectFleet,
    onInspectFleet,
    onOpenSystemDetails, systemDetailSystem, onCloseSystemDetails, fleetPickerMode,
    onOpenBattle, onInvade, onCommitInvasion,
    onSave, onExportAiLogs, onClearAiLogs, onCloseShipDetail,
    devMode, godEyes, onSetUiSettings,
    onDismissMessage, onOpenMessage, onMarkMessageRead, onMarkAllMessagesRead, onDismissReadMessages
}) => {
  
  const [isSideMenuOpen, setIsSideMenuOpen] = useState(false);
  const [debugMode, setDebugMode] = useState(false);

  // Helper to check ownership against current player
  const playerFactionId = gameState.playerFactionId;

  const factionLookup = useMemo(() => {
      return gameState.factions.reduce<Record<FactionId, FactionState>>((acc, faction) => {
          acc[faction.id] = faction;
          return acc;
      }, {});
  }, [gameState.factions]);

  // Compute nearby fleets suitable for merging
  const mergeCandidates = useMemo(() => {
    if (!selectedFleet) return [];
    if (selectedFleet.state !== FleetState.ORBIT) return [];

    // Only merge own fleets
    if (selectedFleet.factionId !== playerFactionId) return [];

    const selectedOrbitingSystem = findOrbitingSystem(selectedFleet, systems);
    if (!selectedOrbitingSystem) return [];

    return blueFleets.filter(f =>
        f.id !== selectedFleet.id &&
        f.state === FleetState.ORBIT &&
        dist(f.position, selectedFleet.position) < 8.0 &&
        findOrbitingSystem(f, systems)?.id === selectedOrbitingSystem.id
    );
  }, [selectedFleet, blueFleets, playerFactionId, systems]);

  // Compute Ground Context for FleetPanel
  const { orbitingSystem, availableArmies } = useMemo(() => {
      if (!selectedFleet || selectedFleet.state !== FleetState.ORBIT) {
          return { orbitingSystem: null, availableArmies: [] as AvailableArmy[] };
      }

      const sys = findOrbitingSystem(selectedFleet, systems);

      if (!sys) return { orbitingSystem: null, availableArmies: [] as AvailableArmy[] };

      const planetIndex = new Map(sys.planets.filter(planet => planet.isSolid).map(planet => [planet.id, planet]));

      // Get armies at this system belonging to Player
      const armies = gameState.armies
          .filter(a => a.state === ArmyState.DEPLOYED && a.factionId === playerFactionId && planetIndex.has(a.containerId))
          .sort((a, b) => compareIds(a.id, b.id))
          .map(army => ({
              army,
              planetId: army.containerId,
              planetName: planetIndex.get(army.containerId)?.name ?? sys.name
          }));

      return { orbitingSystem: sys, availableArmies: armies };
  }, [selectedFleet, systems, gameState.armies, playerFactionId]);

  // Compute INVASION Visibility
  // Rules: Enemy system + At least one player fleet carrying armies
  const showInvadeOption = useMemo(() => {
      if (!targetSystem) return false;

      if (targetSystem.ownerFactionId === playerFactionId) return false;

      const hasLandingZone = targetSystem.planets.some(planet => planet.isSolid);
      if (!hasLandingZone) return false;

      return blueFleets.some(hasInvadingForce);
  }, [targetSystem, blueFleets, playerFactionId]);

  const showAttackOption = useMemo(() => {
      if (!targetSystem) return false;
      if (!targetSystem.ownerFactionId) return false;
      return targetSystem.ownerFactionId !== playerFactionId;
  }, [targetSystem, playerFactionId]);

  const showLoadOption = useMemo(() => {
      if (!targetSystem) return false;

      const systemPlanetIds = new Set(targetSystem.planets.filter(planet => planet.isSolid).map(planet => planet.id));

      return gameState.armies.some(army =>
          systemPlanetIds.has(army.containerId) &&
          army.factionId === playerFactionId &&
          army.state === ArmyState.DEPLOYED
      );
  }, [targetSystem, gameState.armies, playerFactionId]);

  const showUnloadOption = useMemo(() => {
      if (!targetSystem) return false;
      if (targetSystem.ownerFactionId !== playerFactionId) return false;

      const hasLandingZone = targetSystem.planets.some(planet => planet.isSolid);
      if (!hasLandingZone) return false;

      const playerFleetIds = new Set(blueFleets.map(fleet => fleet.id));

      return gameState.armies.some(army =>
          army.factionId === playerFactionId &&
          army.state === ArmyState.EMBARKED &&
          playerFleetIds.has(army.containerId)
      );
  }, [targetSystem, blueFleets, gameState.armies, playerFactionId]);

  const orbitingPlayerFleets = useMemo(() => {
      if (!targetSystem) return [];

      const orbitThresholdSq = ORBIT_PROXIMITY_RANGE_SQ;

      return blueFleets
          .filter(fleet => (
              fleet.state === FleetState.ORBIT &&
              distSq(fleet.position, targetSystem.position) <= orbitThresholdSq
          ))
          .sort((a, b) => {
              const sizeDiff = b.ships.length - a.ships.length;
              if (sizeDiff !== 0) return sizeDiff;
              return compareIds(a.id, b.id);
          });
  }, [blueFleets, targetSystem]);

  // Compute Ground Forces Summary for Context Menu
  const groundForcesSummary = useMemo<Record<FactionId, GroundForceSummaryEntry> | null>(() => {
      if (!targetSystem || !gameState.armies) return null;

      const systemPlanetIds = new Set(targetSystem.planets.filter(planet => planet.isSolid).map(planet => planet.id));

      const aggregates: Record<FactionId, { count: number, currentStrength: number, maxStrength: number, moraleSum: number }> = {};

      gameState.armies.forEach(army => {
          if (systemPlanetIds.has(army.containerId) && army.state === ArmyState.DEPLOYED) {
              if (!aggregates[army.factionId]) {
                  aggregates[army.factionId] = { count: 0, currentStrength: 0, maxStrength: 0, moraleSum: 0 };
              }
              const bucket = aggregates[army.factionId];
              bucket.count += 1;
              bucket.currentStrength += army.strength;
              bucket.maxStrength += army.maxStrength;
              bucket.moraleSum += army.morale;
          }
      });

      const summaries = Object.entries(aggregates).reduce<Record<FactionId, GroundForceSummaryEntry>>((acc, [factionId, bucket]) => {
          if (bucket.count === 0) return acc;

          const losses = bucket.maxStrength - bucket.currentStrength;
          const lossPercent = bucket.maxStrength > 0 ? (losses / bucket.maxStrength) * 100 : 0;
          const averageMoralePercent = (bucket.moraleSum / bucket.count) * 100;

          const faction = factionLookup[factionId];
          const fallbackColor = factionId === playerFactionId ? '#93c5fd' : '#f87171';

          acc[factionId] = {
              factionId,
              factionName: faction?.name ?? factionId,
              color: faction?.color ?? fallbackColor,
              isPlayer: factionId === playerFactionId,
              count: bucket.count,
              currentStrength: bucket.currentStrength,
              maxStrength: bucket.maxStrength,
              losses,
              lossPercent,
              averageMoralePercent,
          };

          return acc;
      }, {});

      if (Object.keys(summaries).length === 0) return null;

      return summaries;
  }, [targetSystem, gameState.armies, playerFactionId, factionLookup]);

  const showGroundOpsOption = useMemo(() => {
      if (!targetSystem) return false;
      return targetSystem.planets.some(planet => planet.isSolid);
  }, [targetSystem]);

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
        messages={messages}
        blueFleets={blueFleets}
        systems={systems}
        onRestart={onRestart}
        onSelectFleet={onSelectFleet}
        onInspectFleet={onInspectFleet}
        onSave={onSave}
        onOpenMessage={onOpenMessage}
        onDismissMessage={onDismissMessage}
        onMarkMessageRead={onMarkMessageRead}
        onMarkAllMessagesRead={onMarkAllMessagesRead}
        onDismissReadMessages={onDismissReadMessages}
        
        devMode={devMode}
        godEyes={godEyes}
        onSetUiSettings={onSetUiSettings}
        onExportAiLogs={onExportAiLogs}
        onClearAiLogs={onClearAiLogs}
        
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
            showGroundOpsOption={showGroundOpsOption}
            canSelectFleet={orbitingPlayerFleets.length > 0}
            onOpenSystemDetails={onOpenSystemDetails}
            onSelectFleetAtSystem={handleSelectFleetAtSystem}
            onOpenFleetPicker={() => onOpenFleetPicker('MOVE')}
            onOpenLoadPicker={() => onOpenFleetPicker('LOAD')}
            onOpenUnloadPicker={() => onOpenFleetPicker('UNLOAD')}
            onOpenGroundOps={onOpenGroundOps}
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

      {uiMode === 'GROUND_OPS_MODAL' && targetSystem && (
        <GroundOpsModal
            system={targetSystem}
            armies={gameState.armies}
            fleets={gameState.fleets}
            factions={gameState.factions}
            playerFactionId={playerFactionId}
            day={day}
            onTransfer={(armyId, fromPlanetId, toPlanetId) =>
                onTransferArmy(targetSystem.id, armyId, fromPlanetId, toPlanetId)
            }
            onClose={onCloseMenu}
        />
      )}

      {uiMode === 'SHIP_DETAIL_MODAL' && inspectedFleet && (
        <ShipDetailModal
            fleet={inspectedFleet}
            faction={factionLookup[inspectedFleet.factionId]}
            armies={gameState.armies}
            onClose={onCloseShipDetail}
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

      {systemDetailSystem && (
          <SystemDetailModal
              system={systemDetailSystem}
              onClose={onCloseSystemDetails}
          />
      )}

      <MessageToasts
        messages={messages}
        onDismissMessage={onDismissMessage}
        onOpenMessage={onOpenMessage}
        onMarkRead={onMarkMessageRead}
      />
    </div>
  );
};

export default UI;
