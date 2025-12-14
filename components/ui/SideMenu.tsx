import React, { useState } from 'react';
import { StarSystem, Fleet, LogEntry, Battle, FleetState, ArmyState } from '../../types';
import { useI18n } from '../../i18n';
import { fleetLabel } from '../../engine/idUtils';

type MenuView = 'MAIN' | 'SYSTEMS' | 'FLEETS' | 'LOGS' | 'BATTLES' | 'SETTINGS';

interface SideMenuProps {
  isOpen: boolean;
  onClose: () => void;
  systems: StarSystem[];
  fleets: Fleet[];
  logs: LogEntry[];
  battles: Battle[];
  factions: { id: string; name: string; color: string; isPlayer: boolean }[];
  selectedSystemId?: string | null;
  selectedFleetId?: string | null;
  onSelectSystem: (systemId: string | null) => void;
  onSelectFleet: (fleetId: string | null) => void;
  onSelectShip: (shipId: string | null) => void;
  onOpenBattle: (battleId: string) => void;
  onNextTurn: () => void;
  onStartBattle: (attackerFleetId: string, defenderFleetId: string) => void;
  onMoveFleet: (fleetId: string, systemId: string) => void;
  onSetFleetStance: (fleetId: string, stance: FleetState['stance']) => void;
  onSetFleetPatrolRoute: (fleetId: string, route: string[] | null) => void;
  onSplitFleet: (fleetId: string, shipIds: string[]) => void;
  onMergeFleets: (fleetId1: string, fleetId2: string) => void;
  onTransferTroops: (fromFleetId: string, toFleetId: string) => void;
  onStartInvasion: (fleetId: string, planetId: string) => void;
  onSetUiSettings: (settings: { devMode?: boolean; debugAi?: boolean }) => void;
  devMode?: boolean;
  debugAi?: boolean;

  // Army management
  armies?: Record<string, ArmyState>;
  onTransferArmy?: (fromSystemId: string, toSystemId: string, troopCount: number) => void;
  onCreateArmy?: (systemId: string, troopCount: number) => void;
  onDisbandArmy?: (armyId: string) => void;
  onAttackSystem?: (armyId: string, targetSystemId: string) => void;
  onExportAiLogs: () => void;
  onClearAiLogs: () => void;
  playerFactionId: string;

  // TURN REPORTS (SITREP)
  onOpenTurnReports?: () => void;
  turnReportCount?: number;
  turnReportsEnabled?: boolean;
  onSetTurnReportsEnabled?: (enabled: boolean) => void;
}

const SideMenu: React.FC<SideMenuProps> = ({ 
    isOpen, onClose, systems, fleets, logs, battles, factions,
    selectedSystemId, selectedFleetId, onSelectSystem, onSelectFleet,
    onSelectShip, onOpenBattle, onNextTurn, onStartBattle,
    onMoveFleet, onSetFleetStance, onSetFleetPatrolRoute,
    onSplitFleet, onMergeFleets, onTransferTroops, onStartInvasion,
    onSetUiSettings, devMode = false, debugAi = false,
    armies, onTransferArmy, onCreateArmy, onDisbandArmy, onAttackSystem,
    onExportAiLogs, onClearAiLogs,
    playerFactionId,

    // TURN REPORTS (SITREP)
    onOpenTurnReports,
    turnReportCount = 0,
    turnReportsEnabled,
    onSetTurnReportsEnabled,
}) => {
  const { t, language, setLanguage } = useI18n();
  const [view, setView] = useState<MenuView>('MAIN');

  if (!isOpen) return null;

  const renderMainView = () => (
    <div className="p-4 space-y-3">
        <button onClick={() => setView('LOGS')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                <div className="text-white font-bold text-lg">{t('sidemenu.com_logs')}</div>
                <div className="text-slate-400 text-sm">{logs.length} {t('sidemenu.entries')}</div>
             </div>
             <div className="text-slate-400 group-hover:text-white">→</div>
        </button>

        {onOpenTurnReports && (
          <button
            onClick={() => {
              onClose();
              onOpenTurnReports();
            }}
            className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all"
          >
            <div className="flex flex-col">
              <div className="text-white font-bold text-lg">{t('reports.turnReports', { defaultValue: 'Turn Reports' })}</div>
              <div className="text-slate-400 text-sm">
                {t('reports.available_other', { defaultValue: '{{count}} reports available', count: turnReportCount })}
              </div>
            </div>
            <div className="text-slate-400 group-hover:text-white">→</div>
          </button>
        )}

        <button onClick={() => setView('FLEETS')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                <div className="text-white font-bold text-lg">{t('sidemenu.fleets')}</div>
                <div className="text-slate-400 text-sm">{fleets.length} {t('sidemenu.active')}</div>
             </div>
             <div className="text-slate-400 group-hover:text-white">→</div>
        </button>

        <button onClick={() => setView('SYSTEMS')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                <div className="text-white font-bold text-lg">{t('sidemenu.systems')}</div>
                <div className="text-slate-400 text-sm">{systems.length} {t('sidemenu.discovered')}</div>
             </div>
             <div className="text-slate-400 group-hover:text-white">→</div>
        </button>

        <button onClick={() => setView('SETTINGS')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                <div className="text-white font-bold text-lg">{t('sidemenu.settings')}</div>
                <div className="text-slate-400 text-sm">{t('sidemenu.preferences')}</div>
             </div>
             <div className="text-slate-400 group-hover:text-white">→</div>
        </button>
    </div>
  );

  const renderSystemsView = () => (
    <div className="p-4">
        <div className="mb-4">
            <h2 className="text-white font-bold text-lg mb-2">{t('sidemenu.systems')}</h2>
            <p className="text-slate-400 text-sm">{t('sidemenu.select_system')}</p>
        </div>
        
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {systems.map(system => (
                <button
                    key={system.id}
                    onClick={() => {
                        onSelectSystem(system.id);
                        onClose();
                    }}
                    className={`w-full text-left p-3 rounded-lg border transition-all ${
                        selectedSystemId === system.id
                            ? 'bg-blue-900/50 border-blue-500/50 text-white'
                            : 'bg-slate-800/30 border-slate-700 text-slate-200 hover:bg-slate-700/30'
                    }`}
                >
                    <div className="font-bold">{system.name}</div>
                    <div className="text-sm text-slate-400">
                        {system.ownerFactionId ? factions.find(f => f.id === system.ownerFactionId)?.name : t('sidemenu.unclaimed')}
                    </div>
                </button>
            ))}
        </div>
    </div>
  );

  const renderFleetsView = () => (
    <div className="p-4">
        <div className="mb-4">
            <h2 className="text-white font-bold text-lg mb-2">{t('sidemenu.fleets')}</h2>
            <p className="text-slate-400 text-sm">{t('sidemenu.select_fleet')}</p>
        </div>
        
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {fleets
              .filter(f => f.factionId === playerFactionId)
              .map(fleet => {
                const system = systems.find(s => s.id === fleet.location.systemId);
                return (
                  <button
                      key={fleet.id}
                      onClick={() => {
                          onSelectFleet(fleet.id);
                          onClose();
                      }}
                      className={`w-full text-left p-3 rounded-lg border transition-all ${
                          selectedFleetId === fleet.id
                              ? 'bg-blue-900/50 border-blue-500/50 text-white'
                              : 'bg-slate-800/30 border-slate-700 text-slate-200 hover:bg-slate-700/30'
                      }`}
                  >
                      <div className="font-bold">{fleetLabel(fleet.id)}</div>
                      <div className="text-sm text-slate-400">{system?.name || fleet.location.systemId}</div>
                      <div className="text-xs text-slate-500">{fleet.ships.length} {t('sidemenu.ships')} • {fleet.stance}</div>
                  </button>
                );
              })}
        </div>
    </div>
  );

  const renderLogsView = () => (
    <div className="p-4">
        <div className="mb-4">
            <h2 className="text-white font-bold text-lg mb-2">{t('sidemenu.com_logs')}</h2>
            <p className="text-slate-400 text-sm">{t('sidemenu.recent_events')}</p>
        </div>
        
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {logs
          .slice()
          .reverse()
          .filter((log) => typeof log?.text !== 'string' || !log.text.startsWith('[TURN_REPORT_JSON]'))
          .map(log => (
            <div key={log.id} className="text-xs border-b border-slate-800/50 pb-2 last:border-0 last:pb-0">
              <div className="text-slate-500">{t('ui.turn')} {log.day} • {log.type}</div>
              <div className="text-slate-200">{log.text}</div>
            </div>
        ))}
        </div>
    </div>
  );

  const renderSettings = () => (
    <div className="p-4">
        <div className="mb-4">
            <h2 className="text-white font-bold text-lg mb-2">{t('sidemenu.settings')}</h2>
            <p className="text-slate-400 text-sm">{t('sidemenu.settings_desc')}</p>
        </div>
        
        <div className="space-y-6">
            {/* Language Selection */}
            <div>
                <h3 className="text-white font-bold mb-2">{t('sidemenu.language')}</h3>
                <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as 'en' | 'fr')}
                    className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2"
                >
                    <option value="en">English</option>
                    <option value="fr">Français</option>
                </select>
            </div>

              {/* Turn Reports (SITREP) Toggle */}
              <div className="flex items-center justify-between mb-4">
                  <div>
                      <div className="text-white font-bold text-sm">{t('reports.turnReports', { defaultValue: 'Turn Reports' })}</div>
                      <div className="text-xs text-slate-500">{t('reports.enableHint', { defaultValue: 'Generate end-of-turn reports (SITREP).' })}</div>
                  </div>
                  <button
                      onClick={() => {
                          const effectiveEnabled = typeof turnReportsEnabled === 'boolean' ? turnReportsEnabled : true;
                          onSetTurnReportsEnabled?.(!effectiveEnabled);
                      }}
                      className={`px-3 py-1 rounded text-sm font-bold ${
                          (typeof turnReportsEnabled === 'boolean' ? turnReportsEnabled : true)
                              ? 'bg-green-600 text-white'
                              : 'bg-slate-700 text-slate-300'
                      }`}
                      disabled={!onSetTurnReportsEnabled}
                      title={!onSetTurnReportsEnabled ? t('reports.enableHint', { defaultValue: 'Generate end-of-turn reports (SITREP).' }) : undefined}
                  >
                      {(typeof turnReportsEnabled === 'boolean' ? turnReportsEnabled : true) ? t('sidemenu.enabled') : t('sidemenu.disabled')}
                  </button>
              </div>

            {/* Developer Mode Toggle */}
            <div className="flex items-center justify-between">
                <div>
                    <div className="text-white font-bold">{t('sidemenu.developer_mode')}</div>
                    <div className="text-slate-400 text-sm">{t('sidemenu.developer_mode_desc')}</div>
                </div>
                <button
                    onClick={() => onSetUiSettings({ devMode: !devMode })}
                    className={`px-3 py-1 rounded text-sm font-bold ${
                        devMode ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-300'
                    }`}
                >
                    {devMode ? t('sidemenu.enabled') : t('sidemenu.disabled')}
                </button>
            </div>

            {/* AI Debug Toggle */}
            {devMode && (
                <div className="flex items-center justify-between">
                    <div>
                        <div className="text-white font-bold">{t('sidemenu.ai_debug')}</div>
                        <div className="text-slate-400 text-sm">{t('sidemenu.ai_debug_desc')}</div>
                    </div>
                    <button
                        onClick={() => onSetUiSettings({ debugAi: !debugAi })}
                        className={`px-3 py-1 rounded text-sm font-bold ${
                            debugAi ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-300'
                        }`}
                    >
                        {debugAi ? t('sidemenu.enabled') : t('sidemenu.disabled')}
                    </button>
                </div>
            )}

            {/* AI Logs Export/Clear */}
            {devMode && debugAi && (
                <div className="space-y-3 border-t border-slate-800 pt-4">
                    <div className="text-white font-bold text-sm">AI Debug Tools</div>
                    <div className="flex gap-2">
                        <button
                            onClick={onExportAiLogs}
                            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded-lg text-sm font-bold transition"
                        >
                            Export AI Logs
                        </button>
                        <button
                            onClick={onClearAiLogs}
                            className="flex-1 bg-red-600 hover:bg-red-700 text-white px-3 py-2 rounded-lg text-sm font-bold transition"
                        >
                            Clear AI Logs
                        </button>
                    </div>
                </div>
            )}
        </div>
    </div>
  );

  const renderContent = () => {
    switch (view) {
        case 'SYSTEMS':
            return renderSystemsView();
        case 'FLEETS':
            return renderFleetsView();
        case 'LOGS':
            return renderLogsView();
        case 'SETTINGS':
            return renderSettings();
        default:
            return renderMainView();
    }
  };

  return (
    <div className="absolute inset-0 z-40 pointer-events-auto">
        {/* Backdrop */}
        <div 
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={onClose}
        />
        
        {/* Menu Panel */}
        <div className="absolute top-0 left-0 bottom-0 w-96 bg-slate-900/95 border-r border-slate-700 shadow-2xl">
            {/* Header */}
            <div className="p-4 border-b border-slate-700 flex justify-between items-center">
                <div>
                    <h1 className="text-white font-bold text-xl">{t('ui.comlink')}</h1>
                    <div className="text-slate-400 text-sm">{t('sidemenu.command_center')}</div>
                </div>
                <button
                    onClick={onClose}
                    className="text-slate-400 hover:text-white text-xl"
                >
                    ×
                </button>
            </div>
            
            {/* Navigation */}
            {view !== 'MAIN' && (
                <div className="px-4 py-2 border-b border-slate-800">
                    <button
                        onClick={() => setView('MAIN')}
                        className="text-slate-400 hover:text-white flex items-center gap-2"
                    >
                        ← {t('sidemenu.back')}
                    </button>
                </div>
            )}
            
            {/* Content */}
            <div className="overflow-y-auto h-[calc(100vh-120px)]">
                {renderContent()}
            </div>
            
            {/* Footer */}
            {view === 'MAIN' && (
                <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-slate-700 bg-slate-900/95">
                    <button
                        onClick={() => {
                            onNextTurn();
                            onClose();
                        }}
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-lg font-bold transition-all"
                    >
                        {t('ui.next')} {t('ui.turn')}
                    </button>
                </div>
            )}
        </div>
    </div>
  );
};

export default SideMenu;
