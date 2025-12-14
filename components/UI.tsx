import React, { useMemo, useState } from 'react';
import { Fleet, StarSystem, LogEntry, Battle, GameState, FleetState, ArmyState, FactionId } from '../types';
import VictoryScreen from './ui/VictoryScreen';
import TopBar from './ui/TopBar';
import SideMenu from './ui/SideMenu';
import TurnReportPillsBar from './ui/turnReport/TurnReportPillsBar';
import TurnReportScreen from './ui/turnReport/TurnReportScreen';
import { parseTurnReportsFromLogs, readTurnReportsEnabled, TurnReportTab, writeTurnReportsEnabled } from './ui/turnReport/turnReport';
import BattleScreen from './ui/BattleScreen';
import FleetDetailsPanel from './ui/FleetDetailsPanel';
import ShipDetailsPanel from './ui/ShipDetailsPanel';
import TroopTransferModal from './ui/TroopTransferModal';
import InvasionModal from './ui/InvasionModal';
import { useI18n } from '../i18n';
import CameraControls from './ui/CameraControls';
import { applyFogOfWar } from '../engine/fogOfWar';
import PlanetDetailsPanel from './ui/PlanetDetailsPanel';

export interface UIProps {
  // Required game state
  startYear: number;
  day: number;
  systems: StarSystem[];
  fleets: Fleet[];
  logs: LogEntry[];
  battles?: Battle[];
  factions: { id: FactionId; name: string; color: string; isPlayer: boolean }[];
  gameState: GameState;
  playerFactionId?: string;
  winnerFactionId?: string;

  // Callbacks
  onNextTurn: () => void;
  onSelectSystem: (systemId: string | null) => void;
  onSelectFleet: (fleetId: string | null) => void;
  onSelectShip: (shipId: string | null) => void;
  onSelectPlanet: (planetId: string | null) => void;
  onOpenBattle: (battleId: string) => void;
  onCloseBattle: () => void;
  onStartBattle: (attackerFleetId: string, defenderFleetId: string) => void;
  onSplitFleet: (fleetId: string, shipIds: string[]) => void;
  onMergeFleets: (fleetId1: string, fleetId2: string) => void;
  onMoveFleet: (fleetId: string, systemId: string) => void;
  onSetFleetStance: (fleetId: string, stance: FleetState['stance']) => void;
  onSetFleetPatrolRoute: (fleetId: string, route: string[] | null) => void;
  onTransferTroops: (fromFleetId: string, toFleetId: string, troopCount: number) => void;
  onStartInvasion: (fleetId: string, planetId: string) => void;
  onSetUiSettings: (settings: { devMode?: boolean; debugAi?: boolean }) => void;
  devMode?: boolean;
  debugAi?: boolean;

  // Fleet panel data
  selectedSystemId?: string | null;
  selectedFleetId?: string | null;
  selectedShipId?: string | null;
  selectedPlanetId?: string | null;

  // Army state for troop transfers
  armies?: Record<string, ArmyState>;
  onTransferArmy?: (fromSystemId: string, toSystemId: string, troopCount: number) => void;
  onCreateArmy?: (systemId: string, troopCount: number) => void;
  onDisbandArmy?: (armyId: string) => void;
  onAttackSystem?: (armyId: string, targetSystemId: string) => void;
  onExportAiLogs: () => void;
  onClearAiLogs: () => void;
}

const UI: React.FC<UIProps> = ({
  startYear,
  day,
  systems,
  fleets,
  logs,
  battles = [],
  factions,
  gameState,
  winnerFactionId,
  onNextTurn,
  onSelectSystem,
  onSelectFleet,
  onSelectShip,
  onSelectPlanet,
  onOpenBattle,
  onCloseBattle,
  onStartBattle,
  onSplitFleet,
  onMergeFleets,
  onMoveFleet,
  onSetFleetStance,
  onSetFleetPatrolRoute,
  onTransferTroops,
  onStartInvasion,
  onSetUiSettings,
  devMode = false,
  debugAi = false,
  selectedSystemId,
  selectedFleetId,
  selectedShipId,
  selectedPlanetId,
  armies,
  onTransferArmy,
  onCreateArmy,
  onDisbandArmy,
  onAttackSystem,
  onExportAiLogs,
  onClearAiLogs,
}) => {
  const { t } = useI18n();

  const [isSideMenuOpen, setIsSideMenuOpen] = useState(false);
  const [activeBattleId, setActiveBattleId] = useState<string | null>(null);
  const [showTroopTransferModal, setShowTroopTransferModal] = useState(false);
  const [troopTransferData, setTroopTransferData] = useState<{
    fromFleetId: string;
    toFleetId: string;
  } | null>(null);
  const [showInvasionModal, setShowInvasionModal] = useState(false);
  const [invasionData, setInvasionData] = useState<{
    fleetId: string;
    planetId: string;
  } | null>(null);

  // Debug battle screen state (future use)
  const [debugMode, setDebugMode] = useState(false);

  // --- TURN REPORTS (SITREP) ---
  const [turnReportsEnabled, setTurnReportsEnabled] = useState<boolean>(() => readTurnReportsEnabled(true));
  const turnReports = useMemo(() => parseTurnReportsFromLogs(logs), [logs]);
  const latestTurnReport = turnReports.length > 0 ? turnReports[turnReports.length - 1] : null;

  const [dismissedTurnReportTurn, setDismissedTurnReportTurn] = useState<number | null>(null);

  const [turnReportScreenOpen, setTurnReportScreenOpen] = useState(false);
  const [turnReportScreenTurn, setTurnReportScreenTurn] = useState<number | null>(null);
  const [turnReportScreenTab, setTurnReportScreenTab] = useState<TurnReportTab>('SUMMARY');

  const shouldShowTurnReportPills = useMemo(() => {
    if (!turnReportsEnabled) return false;
    if (!latestTurnReport) return false;

    const expectedTurn = Math.max(0, day - 1);
    if (latestTurnReport.turn !== expectedTurn) return false;
    if (dismissedTurnReportTurn === latestTurnReport.turn) return false;

    return true;
  }, [turnReportsEnabled, latestTurnReport, day, dismissedTurnReportTurn]);

  const availableBattleIds = useMemo(() => new Set((battles ?? []).map(b => b.id)), [battles]);

  const setTurnReportsEnabledAndPersist = (enabled: boolean) => {
    setTurnReportsEnabled(enabled);
    writeTurnReportsEnabled(enabled);

    // If disabling, hide active pills instantly.
    if (!enabled && latestTurnReport) setDismissedTurnReportTurn(latestTurnReport.turn);
  };

  const openTurnReport = (turn?: number, tab: TurnReportTab = 'SUMMARY') => {
    setIsSideMenuOpen(false);

    const effectiveTurn = typeof turn === 'number'
      ? turn
      : (latestTurnReport?.turn ?? Math.max(0, day - 1));

    setTurnReportScreenTurn(effectiveTurn);
    setTurnReportScreenTab(tab);
    setTurnReportScreenOpen(true);

    if (latestTurnReport) setDismissedTurnReportTurn(latestTurnReport.turn);
  };

  // Apply fog of war for view state
  const viewState = useMemo(() => {
    return applyFogOfWar(gameState);
  }, [gameState]);

  // Handle battle opening
  const handleOpenBattle = (battleId: string) => {
    setActiveBattleId(battleId);
    onOpenBattle(battleId);
  };

  // Handle battle closing
  const handleCloseBattle = () => {
    setActiveBattleId(null);
    onCloseBattle();
  };

  // Get current battle if active
  const activeBattle = useMemo(() => {
    if (!activeBattleId) return null;
    return battles.find(b => b.id === activeBattleId) || null;
  }, [activeBattleId, battles]);

  // Get selected fleet and system
  const selectedFleet = useMemo(() => {
    if (!selectedFleetId) return null;
    return fleets.find(f => f.id === selectedFleetId) || null;
  }, [selectedFleetId, fleets]);

  const selectedSystem = useMemo(() => {
    if (!selectedSystemId) return null;
    return systems.find(s => s.id === selectedSystemId) || null;
  }, [selectedSystemId, systems]);

  // Get selected ship
  const selectedShip = useMemo(() => {
    if (!selectedShipId || !selectedFleet) return null;
    return selectedFleet.ships.find(s => s.id === selectedShipId) || null;
  }, [selectedShipId, selectedFleet]);

  // Get selected planet
  const selectedPlanet = useMemo(() => {
    if (!selectedPlanetId || !selectedSystem) return null;
    return selectedSystem.planets.find(p => p.id === selectedPlanetId) || null;
  }, [selectedPlanetId, selectedSystem]);

  // Handle troop transfer modal
  const handleTransferTroops = (fromFleetId: string, toFleetId: string) => {
    setTroopTransferData({ fromFleetId, toFleetId });
    setShowTroopTransferModal(true);
  };

  const handleTroopTransferConfirm = (troopCount: number) => {
    if (troopTransferData) {
      onTransferTroops(troopTransferData.fromFleetId, troopTransferData.toFleetId, troopCount);
    }
    setShowTroopTransferModal(false);
    setTroopTransferData(null);
  };

  const handleTroopTransferCancel = () => {
    setShowTroopTransferModal(false);
    setTroopTransferData(null);
  };

  // Handle invasion modal
  const handleStartInvasion = (fleetId: string, planetId: string) => {
    setInvasionData({ fleetId, planetId });
    setShowInvasionModal(true);
  };

  const handleInvasionConfirm = () => {
    if (invasionData) {
      onStartInvasion(invasionData.fleetId, invasionData.planetId);
    }
    setShowInvasionModal(false);
    setInvasionData(null);
  };

  const handleInvasionCancel = () => {
    setShowInvasionModal(false);
    setInvasionData(null);
  };

  // Handle closing side menu
  const handleCloseMenu = () => {
    setIsSideMenuOpen(false);
  };

  return (
    <div className="absolute inset-0 pointer-events-none">
      {/* Top Bar */}
      <TopBar 
        startYear={startYear}
        day={day}
        battles={battles}
        onToggleMenu={() => setIsSideMenuOpen(true)}
        onNextTurn={onNextTurn}
        onOpenBattle={handleOpenBattle}
        onDebugBattle={devMode ? () => setDebugMode(true) : undefined}
        onOpenTurnReports={() => openTurnReport()}
        turnReportsCount={turnReports.length}
        hasNewTurnReport={shouldShowTurnReportPills}
      />

      {/* Turn report pills (CK3-style) */}
      {shouldShowTurnReportPills && latestTurnReport && (
        <div className="absolute top-[78px] left-0 right-0 flex justify-center pointer-events-none z-30">
          <TurnReportPillsBar
            report={latestTurnReport}
            onOpen={(turn, tab) => openTurnReport(turn, tab)}
            onDismiss={(turn) => setDismissedTurnReportTurn(turn)}
          />
        </div>
      )}

      {/* Side Menu */}
      <SideMenu
        isOpen={isSideMenuOpen}
        onClose={handleCloseMenu}
        systems={systems}
        fleets={fleets}
        logs={logs}
        battles={battles}
        factions={factions}
        selectedSystemId={selectedSystemId}
        selectedFleetId={selectedFleetId}
        onSelectSystem={onSelectSystem}
        onSelectFleet={onSelectFleet}
        onSelectShip={onSelectShip}
        onOpenBattle={handleOpenBattle}
        onNextTurn={onNextTurn}
        onStartBattle={onStartBattle}
        onMoveFleet={onMoveFleet}
        onSetFleetStance={onSetFleetStance}
        onSetFleetPatrolRoute={onSetFleetPatrolRoute}
        onSplitFleet={onSplitFleet}
        onMergeFleets={onMergeFleets}
        onTransferTroops={handleTransferTroops}
        onStartInvasion={handleStartInvasion}
        onSetUiSettings={onSetUiSettings}
        devMode={devMode}
        debugAi={debugAi}
        armies={armies}
        onTransferArmy={onTransferArmy}
        onCreateArmy={onCreateArmy}
        onDisbandArmy={onDisbandArmy}
        onAttackSystem={onAttackSystem}
        onExportAiLogs={onExportAiLogs}
        onClearAiLogs={onClearAiLogs}
        playerFactionId={gameState.playerFactionId}

        onOpenTurnReports={() => openTurnReport()}
        turnReportCount={turnReports.length}
        turnReportsEnabled={turnReportsEnabled}
        onSetTurnReportsEnabled={setTurnReportsEnabledAndPersist}
      />

      {/* Camera Controls */}
      <CameraControls />

      {/* Fleet Details Panel */}
      {selectedFleet && (
        <FleetDetailsPanel
          fleet={selectedFleet}
          system={selectedSystem}
          factions={factions}
          onClose={() => onSelectFleet(null)}
          onSelectShip={onSelectShip}
          onSplitFleet={onSplitFleet}
          onMergeFleets={onMergeFleets}
          onMoveFleet={onMoveFleet}
          onSetStance={onSetFleetStance}
          onSetPatrolRoute={onSetFleetPatrolRoute}
          onTransferTroops={handleTransferTroops}
          onStartInvasion={handleStartInvasion}
        />
      )}

      {/* Ship Details Panel */}
      {selectedShip && selectedFleet && (
        <ShipDetailsPanel
          ship={selectedShip}
          fleet={selectedFleet}
          onClose={() => onSelectShip(null)}
        />
      )}

      {/* Planet Details Panel */}
      {selectedPlanet && selectedSystem && (
        <PlanetDetailsPanel
          planet={selectedPlanet}
          system={selectedSystem}
          onClose={() => onSelectPlanet(null)}
        />
      )}

      {/* Battle Screen */}
      {activeBattle && (
        <BattleScreen
          battle={activeBattle}
          onClose={handleCloseBattle}
        />
      )}

      {/* Troop Transfer Modal */}
      {showTroopTransferModal && troopTransferData && (
        <TroopTransferModal
          fromFleetId={troopTransferData.fromFleetId}
          toFleetId={troopTransferData.toFleetId}
          fleets={fleets}
          onConfirm={handleTroopTransferConfirm}
          onCancel={handleTroopTransferCancel}
        />
      )}

      {/* Invasion Modal */}
      {showInvasionModal && invasionData && (
        <InvasionModal
          fleetId={invasionData.fleetId}
          planetId={invasionData.planetId}
          systems={systems}
          fleets={fleets}
          onConfirm={handleInvasionConfirm}
          onCancel={handleInvasionCancel}
        />
      )}

      {/* Turn report screen */}
      {turnReportScreenOpen && (
        <TurnReportScreen
          reports={turnReports}
          initialTurn={turnReportScreenTurn}
          initialTab={turnReportScreenTab}
          availableBattleIds={availableBattleIds}
          onOpenBattle={(battleId) => {
            setTurnReportScreenOpen(false);
            handleOpenBattle(battleId);
          }}
          onClose={() => setTurnReportScreenOpen(false)}
        />
      )}

      {/* Victory Screen */}
      {winnerFactionId && (
        <VictoryScreen winnerFactionId={winnerFactionId} factions={factions} />
      )}
    </div>
  );
};

export default UI;
