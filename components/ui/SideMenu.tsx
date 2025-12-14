
import React, { useState, useMemo } from 'react';
import { LogEntry, Fleet, StarSystem, FactionId } from '../../types';
import { fleetLabel } from '../../engine/idUtils';
import { useI18n } from '../../i18n';

interface SideMenuProps {
  isOpen: boolean;
  onClose: () => void;
  logs: LogEntry[];
  blueFleets: Fleet[];
  systems: StarSystem[];
  onRestart: () => void;
  onSelectFleet: (fleetId: string) => void;
  onSave: () => void;

  devMode: boolean;
  godEyes: boolean;
  onSetUiSettings: (settings: { devMode: boolean, godEyes: boolean, aiDebug?: boolean }) => void;
  
  // New props for AI Debugging
  onExportAiLogs?: () => void;
  onClearAiLogs?: () => void;
  
  playerFactionId: string;
}

type MenuView = 'MAIN' | 'LOGS' | 'FLEETS' | 'SYSTEMS' | 'SETTINGS';

const SideMenu: React.FC<SideMenuProps> = ({ 
    isOpen, onClose, logs, blueFleets, systems, 
    onRestart, onSelectFleet, onSave,
    devMode, godEyes, onSetUiSettings,
    onExportAiLogs, onClearAiLogs,
    playerFactionId
}) => {
  const { t, locale, setLocale } = useI18n();
  const [view, setView] = useState<MenuView>('MAIN');
  
  const [aiDebug, setAiDebug] = useState(false);

  React.useEffect(() => {
    if (!isOpen) {
        const timer = setTimeout(() => setView('MAIN'), 200);
        return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const mySystems = useMemo(() => systems.filter(s => s.ownerFactionId === playerFactionId), [systems, playerFactionId]);

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
      <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
          {blueFleets.map(fleet => (
              <button 
                  key={fleet.id} 
                  onClick={() => {
                      onSelectFleet(fleet.id);
                      onClose();
                  }}
                  className="w-full text-left bg-slate-800/30 border border-slate-700/50 p-3 rounded hover:bg-slate-700 hover:border-blue-500/50 transition-all group"
              >
                  <div className="flex justify-between items-start mb-1">
                      <span className="text-blue-300 font-bold text-sm group-hover:text-blue-100 transition-colors">{fleetLabel(fleet.id)}</span>
                      <span className="text-[10px] bg-slate-700 px-1 rounded text-slate-300 uppercase">
                        {t(`fleet.status.${fleet.state.toLowerCase()}`, { defaultValue: fleet.state })}
                      </span>
                  </div>
                  <div className="text-xs text-slate-500 group-hover:text-slate-400">Ships: {fleet.ships.length}</div>
                  <div className="flex gap-1 mt-2 flex-wrap">
                     {fleet.ships.slice(0, 10).map((_, i) => (
                         <div key={i} className="w-1 h-1 bg-blue-500 rounded-full"></div>
                     ))}
                     {fleet.ships.length > 10 && <span className="text-[10px] text-slate-600">+</span>}
                  </div>
              </button>
          ))}
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
                        className="bg-slate-800 hover:bg-emerald-900/40 text-emerald-400 text-xs py-2 rounded border border-emerald-900/50 flex flex-col items-center justify-center gap-1"
                      >
                         <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                           <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                         </svg>
                         Export Logs
                      </button>
                      <button 
                        onClick={onClearAiLogs}
                        className="bg-slate-800 hover:bg-red-900/40 text-red-400 text-xs py-2 rounded border border-red-900/50 flex flex-col items-center justify-center gap-1"
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
            </div>
            <div className="p-4 border-t border-slate-800 text-center bg-slate-950/30">
                <p className="text-[10px] text-slate-600 uppercase tracking-widest">Galactic Conflict v1.1</p>
            </div>
        </div>
    </>
  );
};

export default SideMenu;
