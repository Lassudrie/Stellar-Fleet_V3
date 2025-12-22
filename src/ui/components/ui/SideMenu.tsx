
import React, { useState, useMemo } from 'react';
import { FleetState, LogEntry, Fleet, StarSystem, FactionId, GameMessage, ShipType } from '../../../shared/types';
import { fleetLabel } from '../../../engine/idUtils';
import { getFleetSpeed } from '../../../engine/movement/fleetSpeed';
import { dist } from '../../../engine/math/vec3';
import { findOrbitingSystem } from './orbiting';
import { useI18n } from '../../i18n';

interface SideMenuProps {
  isOpen: boolean;
  onClose: () => void;
  logs: LogEntry[];
  messages: GameMessage[];
  blueFleets: Fleet[];
  systems: StarSystem[];
  day: number;
  onRestart: () => void;
  onSelectFleet: (fleetId: string) => void;
  onSave: () => void;
  onOpenMessage: (message: GameMessage) => void;
  onMarkMessageRead: (messageId: string, read: boolean) => void;
  onMarkAllMessagesRead: () => void;

  devMode: boolean;
  godEyes: boolean;
  onSetUiSettings: (settings: { devMode: boolean, godEyes: boolean, aiDebug?: boolean }) => void;
  
  // New props for AI Debugging
  onExportAiLogs?: () => void;
  onClearAiLogs?: () => void;

  playerFactionId: string;
}

type MenuView = 'MAIN' | 'LOGS' | 'FLEETS' | 'SYSTEMS' | 'SETTINGS' | 'MESSAGES';

const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const SHIP_TRIGRAM: Record<ShipType, string> = {
  [ShipType.CARRIER]: 'CAR',
  [ShipType.CRUISER]: 'CRU',
  [ShipType.DESTROYER]: 'DST',
  [ShipType.FRIGATE]: 'FRI',
  [ShipType.FIGHTER]: 'FTR',
  [ShipType.BOMBER]: 'BMB',
  [ShipType.TROOP_TRANSPORT]: 'TRN',
  [ShipType.TANKER]: 'TNK',
  [ShipType.EXTRACTOR]: 'EXT',
};

const getFleetComposition = (fleet: Fleet): Record<ShipType, number> => {
  return fleet.ships.reduce<Record<ShipType, number>>((acc, ship) => {
      if (ship?.type) {
          acc[ship.type as ShipType] = (acc[ship.type as ShipType] ?? 0) + 1;
      }
      return acc;
  }, {
      [ShipType.CARRIER]: 0,
      [ShipType.CRUISER]: 0,
      [ShipType.DESTROYER]: 0,
      [ShipType.FRIGATE]: 0,
      [ShipType.FIGHTER]: 0,
      [ShipType.BOMBER]: 0,
      [ShipType.TROOP_TRANSPORT]: 0,
      [ShipType.TANKER]: 0,
      [ShipType.EXTRACTOR]: 0,
  });
};

const SideMenu: React.FC<SideMenuProps> = ({ 
    isOpen, onClose, logs, messages, blueFleets, systems, day,
    onRestart, onSelectFleet, onSave, onOpenMessage, onMarkMessageRead, onMarkAllMessagesRead,
    devMode, godEyes, onSetUiSettings,
    onExportAiLogs, onClearAiLogs,
    playerFactionId
}) => {
  const { t, locale, setLocale } = useI18n();
  const [view, setView] = useState<MenuView>('MAIN');
  
  const [aiDebug, setAiDebug] = useState(false);
  const [messageTypeFilter, setMessageTypeFilter] = useState<string>('ALL');
  const [expandedFleets, setExpandedFleets] = useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (!isOpen) {
        const timer = setTimeout(() => setView('MAIN'), 200);
        return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const mySystems = useMemo(() => systems.filter(s => s.ownerFactionId === playerFactionId), [systems, playerFactionId]);
  const unreadMessages = useMemo(() => messages.filter(msg => !msg.read && !msg.dismissed).length, [messages]);
  const messageTypes = useMemo(() => {
      const types = new Set(messages.map(m => m.type.toLowerCase()));
      return Array.from(types).sort();
  }, [messages]);

  if (!isOpen) return null;

  const renderHeader = () => (
    <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-950/50">
        <div className="flex items-center gap-2 text-white">
            {view !== 'MAIN' && (
                <button onClick={() => setView('MAIN')} className="mr-2 text-slate-400 hover:text-white">
                     <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                    </svg>
                </button>
            )}
            <div className={`w-2 h-6 ${view === 'MAIN' ? 'bg-blue-500' : view === 'SETTINGS' ? 'bg-purple-500' : 'bg-slate-600'} rounded-sm`}></div>
            <h2 className="text-lg font-bold tracking-wider uppercase">
                {view === 'MAIN' && t('sidemenu.command')}
                {view === 'LOGS' && t('sidemenu.com_logs')}
                {view === 'FLEETS' && t('sidemenu.registry')}
                {view === 'SYSTEMS' && t('sidemenu.territory')}
                {view === 'SETTINGS' && t('sidemenu.settings')}
                {view === 'MESSAGES' && t('sidemenu.messaging')}
            </h2>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </button>
    </div>
  );

  const renderMainView = () => (
    <div className="p-4 space-y-3">
        <button onClick={() => setView('LOGS')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                 <span className="text-white font-bold tracking-wider uppercase">{t('sidemenu.com_logs')}</span>
                 <span className="text-xs text-slate-500">{t('sidemenu.recentEvents', { count: logs.length })}</span>
             </div>
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500 group-hover:translate-x-1 transition-transform">
             <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
           </svg>
        </button>

        <button onClick={() => setView('MESSAGES')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                 <span className="text-amber-200 font-bold tracking-wider uppercase">{t('sidemenu.messaging')}</span>
                 <span className="text-xs text-slate-500">{t('sidemenu.unread')}: {unreadMessages}</span>
             </div>
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500 group-hover:translate-x-1 transition-transform">
               <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
             </svg>
        </button>

        <button onClick={() => setView('FLEETS')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                 <span className="text-blue-200 font-bold tracking-wider uppercase">{t('sidemenu.registry')}</span>
                 <span className="text-xs text-slate-500">{t('sidemenu.activeUnits', { count: blueFleets.length })}</span>
             </div>
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500 group-hover:translate-x-1 transition-transform">
               <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
             </svg>
        </button>

        <button onClick={() => setView('SYSTEMS')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                 <span className="text-blue-200 font-bold tracking-wider uppercase">{t('sidemenu.territory')}</span>
                 <span className="text-xs text-slate-500">{t('sidemenu.controlledSectors', { count: mySystems.length })}</span>
             </div>
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500 group-hover:translate-x-1 transition-transform">
               <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
             </svg>
        </button>

        <button onClick={() => setView('SETTINGS')} className="w-full text-left bg-slate-800/50 hover:bg-slate-700/50 p-4 rounded-lg border border-slate-700 flex justify-between items-center group transition-all">
             <div className="flex flex-col">
                 <span className="text-purple-300 font-bold tracking-wider uppercase">{t('sidemenu.settings')}</span>
                 <span className="text-xs text-slate-500">{t('sidemenu.systemPreferences')}</span>
             </div>
             <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-slate-500 group-hover:translate-x-1 transition-transform">
               <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
             </svg>
        </button>

        <div className="h-px bg-slate-800 my-4"></div>

        <button 
            onClick={onSave}
            className="w-full bg-slate-800 hover:bg-slate-700 text-blue-300 hover:text-white py-3 rounded-lg border border-slate-700 font-bold text-xs flex items-center justify-center gap-2 transition-colors uppercase mb-3"
        >
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            {t('sidemenu.export')}
        </button>

        <button 
            onClick={() => {
                onClose();
                onRestart();
            }} 
            className="w-full text-left px-4 py-3 rounded-lg bg-red-900/10 text-red-400 hover:bg-red-900/30 border border-red-900/20 text-sm font-bold transition-all flex items-center justify-between group uppercase"
        >
            <span>{t('sidemenu.restart')}</span>
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4 group-hover:rotate-180 transition-transform">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
        </button>
    </div>
  );

  const renderLogs = () => (
      <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
        {logs.length === 0 && <div className="text-center text-xs text-slate-500 italic py-4">{t('sidemenu.noEvents')}</div>}
        {logs.slice().reverse().map(log => (
            <div key={log.id} className="text-xs border-b border-slate-800/50 pb-2 last:border-0 last:pb-0">
                <div className="text-slate-600 font-mono text-[10px] mb-0.5 uppercase">{t('ui.turn')} {log.day}</div>
                <div className={`${
                    log.type === 'combat' ? 'text-red-400' : 
                    log.type === 'move' ? 'text-blue-300' : 'text-slate-300'
                }`}>
                    {log.text}
                </div>
            </div>
        ))}
     </div>
  );

  const renderFleets = () => (
      <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
          {blueFleets.map(fleet => {
              const composition = getFleetComposition(fleet);
              const compositionEntries = Object.entries(composition)
                .filter(([, count]) => count > 0)
                .map(([type, count]) => ({ label: SHIP_TRIGRAM[type as ShipType], count }));
              const isExpanded = expandedFleets.has(fleet.id);
              const maxVisibleChips = 4;
              const visibleChips = isExpanded ? compositionEntries : compositionEntries.slice(0, maxVisibleChips);
              const hasOverflow = compositionEntries.length > maxVisibleChips;

              const inTransit = fleet.state === FleetState.MOVING && Boolean(fleet.targetPosition);
              const targetSystem = fleet.targetSystemId ? systems.find(s => s.id === fleet.targetSystemId) : null;
              const orbitingSystem = findOrbitingSystem(fleet, systems);
              const routeLabel = inTransit
                ? `Transit → ${targetSystem?.name ?? t('ctx.systemDetails')}`
                : orbitingSystem
                  ? t('fleet.orbiting', { system: orbitingSystem.name })
                  : 'Deep space patrol';

              const speed = getFleetSpeed(fleet);
              const remainingDistance = inTransit && fleet.targetPosition ? dist(fleet.position, fleet.targetPosition) : 0;
              const elapsedTurns = inTransit ? Math.max(0, day - fleet.stateStartTurn) : 0;
              const distanceTraveled = inTransit ? Math.max(0, elapsedTurns * speed) : 0;
              const totalDistance = inTransit ? remainingDistance + distanceTraveled : 0;
              const progress = inTransit ? clamp01(totalDistance > 0 ? distanceTraveled / totalDistance : 0) : 1;
              const etaTurns = inTransit && speed > 0 ? Math.max(1, Math.ceil(remainingDistance / speed)) : 0;
              const safeEta = etaTurns > 0 ? etaTurns : 1;

              const etaLabel = inTransit
                ? etaTurns === 1
                  ? t('picker.eta_one')
                  : t('picker.eta_other', { count: safeEta })
                : t(`fleet.status.${fleet.state.toLowerCase()}`, { defaultValue: fleet.state });

              const remainingLabel = inTransit
                ? `${Math.round(Math.max(0, remainingDistance))} / ${Math.round(Math.max(remainingDistance, totalDistance))} ${t('picker.ly')}`
                : t('orbitPicker.shipCount', { count: fleet.ships.length });

              const statusTone = fleet.state === FleetState.COMBAT
                ? 'bg-red-900/40 text-red-200 border border-red-700/40'
                : fleet.state === FleetState.MOVING
                  ? 'bg-amber-900/30 text-amber-100 border border-amber-700/30'
                  : 'bg-emerald-900/30 text-emerald-100 border border-emerald-700/30';

              return (
                <button
                  key={fleet.id}
                  onClick={() => {
                      onSelectFleet(fleet.id);
                      onClose();
                  }}
                  className="relative w-full text-left bg-gradient-to-br from-slate-900/80 via-slate-900/40 to-slate-800/60 border border-slate-700/60 p-4 rounded-2xl shadow-lg hover:border-blue-500/50 hover:shadow-blue-900/30 transition-all group overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-white/5 via-transparent to-white/0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

                  <div className="flex items-start justify-between gap-3">
                      <div>
                          <div className="text-xl font-extrabold tracking-tight text-slate-100 flex items-center gap-2">
                              {fleetLabel(fleet.id)}
                              <span className={`text-[10px] px-2 py-1 rounded-full uppercase font-bold ${statusTone}`}>
                                  {t(`fleet.status.${fleet.state.toLowerCase()}`, { defaultValue: fleet.state })}
                              </span>
                          </div>
                          <div className="text-sm text-slate-400 mt-1">
                              {routeLabel}
                          </div>
                      </div>
                      <div className="h-12 w-12 rounded-xl border border-slate-700 flex items-center justify-center bg-slate-800/60 text-slate-300">
                          <div className="flex flex-col gap-1 items-center" aria-hidden="true">
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400/90" />
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400/90" />
                              <span className="w-1.5 h-1.5 rounded-full bg-slate-400/90" />
                          </div>
                          <span className="sr-only">Fleet options</span>
                      </div>
                  </div>

                  <div className="flex items-center justify-between mt-4 text-slate-400 text-sm">
                      <span className="font-semibold text-slate-200">{etaLabel}</span>
                      <span>{remainingLabel}</span>
                  </div>

                  <div className="mt-2 h-3 w-full bg-slate-800/80 rounded-full overflow-hidden shadow-inner border border-slate-800">
                      <div
                        className="h-full bg-gradient-to-r from-slate-100 via-blue-200 to-blue-400 rounded-full transition-all"
                        style={{ width: `${Math.max(8, Math.round(progress * 100))}%` }}
                        aria-label={t('ctx.moveTo')}
                      />
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3 text-slate-200">
                      <span className="px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700 text-sm font-semibold">
                          {t('orbitPicker.shipCount', { count: fleet.ships.length })}
                      </span>
                      <span className="text-sm text-slate-400">Speed {Math.round(speed)} {t('picker.ly')}/T</span>
                      <div className={`flex gap-2 text-sm text-slate-100 ${isExpanded ? 'overflow-x-auto pr-2' : 'flex-wrap'}`}>
                          {visibleChips.map(item => (
                              <span
                                key={item.label}
                                className="px-3 py-1 rounded-full bg-slate-100 text-slate-900 border border-slate-200 text-xs font-semibold whitespace-nowrap"
                              >
                                  {item.label} {item.count}
                              </span>
                          ))}
                          {hasOverflow && !isExpanded && (
                              <button
                                type="button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    const next = new Set(expandedFleets);
                                    next.add(fleet.id);
                                    setExpandedFleets(next);
                                }}
                                className="px-3 py-1 rounded-full bg-slate-100 text-slate-900 border border-slate-200 text-xs font-semibold"
                              >
                                  ...
                              </button>
                          )}
                          {hasOverflow && isExpanded && (
                              <button
                                type="button"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    const next = new Set(expandedFleets);
                                    next.delete(fleet.id);
                                    setExpandedFleets(next);
                                }}
                                className="px-3 py-1 rounded-full bg-slate-800/70 text-slate-200 border border-slate-600 text-xs font-semibold whitespace-nowrap"
                              >
                                  ×
                              </button>
                          )}
                      </div>
                  </div>
                </button>
              );
          })}
      </div>
  );

  const renderSystems = () => (
      <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
          {mySystems.length === 0 && (
              <div className="text-center text-slate-500 py-4 text-xs">{t('sidemenu.noSystems')}</div>
          )}
          {mySystems.map(sys => (
              <div key={sys.id} className="bg-slate-800/30 border border-slate-700/50 p-3 rounded flex justify-between items-center hover:bg-slate-800 transition-colors">
                  <div>
                      <div className="text-blue-300 font-bold text-sm">{sys.name}</div>
                      <div className="text-[10px] text-slate-500 font-mono">
                          X:{Math.round(sys.position.x)} Y:{Math.round(sys.position.y)} Z:{Math.round(sys.position.z)}
                      </div>
                  </div>
                  <div className="w-2 h-2 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.5)]"></div>
              </div>
          ))}
      </div>
  );

  const renderSettings = () => (
      <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
          <div>
              <div className="text-purple-300 font-bold text-sm mb-4 border-b border-slate-700 pb-2 uppercase">{t('sidemenu.debugTools')}</div>
              
              {/* Language Switcher */}
              <div className="flex items-center justify-between mb-4">
                  <div>
                      <div className="text-white font-bold text-sm">{t('sidemenu.language')}</div>
                      <div className="text-xs text-slate-500 uppercase">{locale === 'en' ? 'English' : 'Français'}</div>
                  </div>
                  <div className="flex gap-1 bg-slate-800 p-1 rounded-lg">
                      <button 
                          onClick={() => setLocale('en')}
                          className={`px-3 py-1 rounded text-xs font-bold transition-all ${locale === 'en' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                      >
                          EN
                      </button>
                      <button 
                          onClick={() => setLocale('fr')}
                          className={`px-3 py-1 rounded text-xs font-bold transition-all ${locale === 'fr' ? 'bg-purple-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
                      >
                          FR
                      </button>
                  </div>
              </div>

              {/* Developer Mode Toggle */}
              <div className="flex items-center justify-between mb-4">
                  <div>
                      <div className="text-white font-bold text-sm">{t('sidemenu.devMode')}</div>
                      <div className="text-xs text-slate-500">Enable advanced features</div>
                  </div>
                  <button 
                      onClick={() => onSetUiSettings({ devMode: !devMode, godEyes: devMode ? false : godEyes, aiDebug: devMode ? false : aiDebug })}
                      className={`w-12 h-6 rounded-full p-1 transition-colors ${devMode ? 'bg-purple-600' : 'bg-slate-700'}`}
                  >
                      <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${devMode ? 'translate-x-6' : 'translate-x-0'}`} />
                  </button>
              </div>

              {/* God Eyes Toggle */}
              <div className={`flex items-center justify-between transition-opacity ${devMode ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                  <div>
                      <div className="text-white font-bold text-sm">{t('sidemenu.godEyes')}</div>
                      <div className="text-xs text-slate-500">Disable Fog of War (Visual Only)</div>
                  </div>
                  <button 
                      onClick={() => onSetUiSettings({ devMode, godEyes: !godEyes, aiDebug })}
                      className={`w-12 h-6 rounded-full p-1 transition-colors ${godEyes ? 'bg-blue-600' : 'bg-slate-700'}`}
                      disabled={!devMode}
                  >
                      <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${godEyes ? 'translate-x-6' : 'translate-x-0'}`} />
                  </button>
              </div>

              {/* AI Debugger Toggle */}
              <div className={`flex items-center justify-between mt-4 transition-opacity ${devMode ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>
                  <div>
                      <div className="text-white font-bold text-sm">{t('sidemenu.aiDebugger')}</div>
                      <div className="text-xs text-slate-500">Log AI decision metrics</div>
                  </div>
                  <button 
                      onClick={() => {
                          const newState = !aiDebug;
                          setAiDebug(newState);
                          onSetUiSettings({ devMode, godEyes, aiDebug: newState });
                      }}
                      className={`w-12 h-6 rounded-full p-1 transition-colors ${aiDebug ? 'bg-emerald-600' : 'bg-slate-700'}`}
                      disabled={!devMode}
                  >
                      <div className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${aiDebug ? 'translate-x-6' : 'translate-x-0'}`} />
                  </button>
              </div>

              {/* AI Debug Actions */}
              {devMode && aiDebug && (
                  <div className="grid grid-cols-2 gap-2 mt-4">
                      <button
                        onClick={onExportAiLogs}
                        disabled={!onExportAiLogs}
                        className={`bg-slate-800 text-xs py-2 rounded border flex flex-col items-center justify-center gap-1 ${
                            onExportAiLogs ? 'hover:bg-emerald-900/40 text-emerald-400 border-emerald-900/50' : 'opacity-40 cursor-not-allowed text-slate-500 border-slate-800'
                        }`}
                      >
                         <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                           <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                         </svg>
                         Export Logs
                      </button>
                      <button
                        onClick={onClearAiLogs}
                        disabled={!onClearAiLogs}
                        className={`bg-slate-800 text-xs py-2 rounded border flex flex-col items-center justify-center gap-1 ${
                            onClearAiLogs ? 'hover:bg-red-900/40 text-red-400 border-red-900/50' : 'opacity-40 cursor-not-allowed text-slate-500 border-slate-800'
                        }`}
                      >
                         <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                           <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                         </svg>
                         Clear Logs
                      </button>
                  </div>
              )}
          </div>
          
          <div className="p-3 bg-yellow-900/20 border border-yellow-700/30 rounded text-xs text-yellow-500/80">
              <span className="font-bold block mb-1 uppercase">{t('sidemenu.warning')}</span>
              {t('sidemenu.warningText')}
          </div>
      </div>
  );

  const renderMessages = () => {
      const sortedMessages = [...messages]
        .filter(msg => !msg.dismissed)
        .sort((a, b) => {
            const turnDiff = b.createdAtTurn - a.createdAtTurn;
            if (turnDiff !== 0) return turnDiff;
            const priorityDiff = b.priority - a.priority;
            if (priorityDiff !== 0) return priorityDiff;
            return compareIds(b.id, a.id);
        });

      const filteredMessages = sortedMessages.filter(msg => {
          if (messageTypeFilter === 'ALL') return true;
          if (messageTypeFilter === 'BATTLE') return msg.type.toLowerCase().includes('battle');
          if (messageTypeFilter === 'GROUND') return msg.type.toLowerCase().includes('ground') || msg.type.toLowerCase().includes('planet');
          return msg.type.toUpperCase() === messageTypeFilter;
      });

      return (
        <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
            <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 text-xs text-slate-400 uppercase">
                    <span>{t('sidemenu.filterByType')}:</span>
                    <select
                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white text-xs"
                        value={messageTypeFilter}
                        onChange={(e) => setMessageTypeFilter(e.target.value)}
                    >
                        <option value="ALL">{t('sidemenu.typeAll')}</option>
                        <option value="BATTLE">{t('sidemenu.typeBattle')}</option>
                        <option value="GROUND">{t('sidemenu.typeGround')}</option>
                        {messageTypes
                            .filter(tVal => !tVal.includes('battle') && !tVal.includes('ground') && !tVal.includes('planet'))
                            .map(type => (
                                <option key={type} value={type.toUpperCase()}>{type}</option>
                            ))}
                    </select>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={onMarkAllMessagesRead}
                        className="text-[10px] px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:border-blue-500/60"
                    >
                        {t('sidemenu.markAllRead')}
                    </button>
                </div>
            </div>
            {filteredMessages.length === 0 && (
                <div className="text-center text-xs text-slate-500 py-6">{t('sidemenu.noMessages')}</div>
            )}
            {filteredMessages.map(message => (
                <div key={message.id} className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3 hover:border-blue-500/60 transition-colors">
                    <div className="flex justify-between items-start gap-2">
                        <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${message.read ? 'bg-slate-600' : 'bg-amber-400'}`} />
                            <div className="text-[10px] uppercase text-slate-500 font-mono">
                                {t('ui.turn')} {message.day}
                            </div>
                            <span className={`text-[10px] uppercase px-2 py-0.5 rounded-full border ${message.priority >= 2 ? 'border-amber-500 text-amber-400' : 'border-slate-700 text-slate-400'}`}>
                                {message.priority >= 2 ? t('messages.priority.high') : t('messages.priority.normal')}
                            </span>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={() => onMarkMessageRead(message.id, !message.read)}
                                className="text-[10px] px-2 py-1 rounded bg-slate-900 border border-slate-700 text-slate-300 hover:text-white"
                            >
                                {message.read ? t('sidemenu.markUnread') : t('sidemenu.markRead')}
                            </button>
                        </div>
                    </div>
                    <button
                        onClick={() => onOpenMessage(message)}
                        className="mt-2 text-left block"
                    >
                        <div className="text-white font-bold">{message.title}</div>
                        <div className="text-xs text-slate-400">{message.subtitle}</div>
                        <ul className="mt-2 space-y-1">
                            {message.lines.map((line, idx) => (
                                <li key={idx} className="text-xs text-slate-300 leading-tight">• {line}</li>
                            ))}
                        </ul>
                    </button>
                </div>
            ))}
        </div>
      );
  };

  return (
    <>
        <div 
            className="absolute inset-0 bg-black/60 backdrop-blur-sm z-40 pointer-events-auto transition-opacity"
            onClick={onClose}
        />
        <div className="absolute top-0 left-0 bottom-0 w-80 bg-slate-900/95 border-r border-slate-700/50 shadow-2xl z-50 pointer-events-auto flex flex-col animate-in slide-in-from-left duration-200">
            {renderHeader()}
            <div className="flex-1 flex flex-col overflow-hidden">
                {view === 'MAIN' && renderMainView()}
                {view === 'LOGS' && renderLogs()}
                {view === 'FLEETS' && renderFleets()}
                {view === 'SYSTEMS' && renderSystems()}
                {view === 'SETTINGS' && renderSettings()}
                {view === 'MESSAGES' && renderMessages()}
            </div>
            <div className="p-4 border-t border-slate-800 text-center bg-slate-950/30">
                <p className="text-[10px] text-slate-600 uppercase tracking-widest">Galactic Conflict v1.1</p>
            </div>
        </div>
    </>
  );
};

export default SideMenu;
