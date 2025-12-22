
import React, { useMemo } from 'react';
import { Battle } from '../../../shared/types';
import { useI18n } from '../../i18n';

interface TopBarProps {
  startYear: number;
  day: number;
  battles?: Battle[];
  onToggleMenu: () => void;
  onNextTurn: () => void;
  onOpenBattle: (battleId: string) => void;
  // NEW: Debug callback
  onDebugBattle?: () => void;
}

const TopBar: React.FC<TopBarProps> = ({ 
  startYear, day, battles = [], onToggleMenu, onNextTurn, onOpenBattle, onDebugBattle 
}) => {
  const { t } = useI18n();
  // Calculate current year based on turn count (day 1 = startYear)
  const currentYear = startYear + (day - 1);

  // Filter relevant battles to display:
  // 1. Scheduled/Resolving (Status !== resolved)
  // 2. Resolved THIS TURN (turnResolved === day)
  const relevantBattles = useMemo(() => {
      return battles.filter(b => 
          b.status !== 'resolved' || b.turnResolved === day
      );
  }, [battles, day]);

  return (
    <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-auto z-20">
      
      {/* LEFT: Burger Menu & Info */}
      <div className="flex gap-3 items-center">
          {/* Burger Button - Fixed size 50x50 for symmetry */}
          <button 
              onClick={onToggleMenu}
              className="bg-slate-900/80 hover:bg-slate-800 text-white h-[50px] w-[50px] flex items-center justify-center rounded-lg border border-slate-700 shadow-lg active:scale-95 transition-all group"
              title="Open Menu"
          >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-400 group-hover:text-white transition-colors">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
          </button>

          {/* Simulation Info */}
          <div className="bg-black/60 backdrop-blur px-4 py-2 rounded-lg border border-white/10 text-white h-[50px] flex flex-col justify-center shadow-lg">
              <div className="text-[10px] text-blue-200/60 uppercase tracking-widest leading-none mb-1 font-mono">{t('ui.year')} {currentYear}</div>
              <div className="text-xl font-mono font-bold leading-none tracking-wide text-blue-100 uppercase">{t('ui.turn')} {day}</div>
          </div>

          {/* BATTLE BADGES */}
          {relevantBattles.length > 0 && (
             <div className="flex gap-2 ml-4">
                {/* If <= 3 battles, show individual buttons */}
                {relevantBattles.length <= 3 && relevantBattles.map(battle => (
                   <button 
                      key={battle.id}
                      onClick={() => onOpenBattle(battle.id)}
                      className="bg-red-900/80 hover:bg-red-800 border border-red-500/50 text-red-100 h-[50px] px-3 rounded-lg shadow-lg flex flex-col items-center justify-center animate-in fade-in slide-in-from-left duration-300"
                   >
                      <span className="text-[10px] uppercase font-bold text-red-400">
                          {battle.status === 'resolved' ? t('ui.report') : t('ui.combat')}
                      </span>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                         <path fillRule="evenodd" d="M12.97 3.97a.75.75 0 011.06 0l7.5 7.5a.75.75 0 010 1.06l-7.5 7.5a.75.75 0 11-1.06-1.06l6.22-6.22H3a.75.75 0 010-1.5h16.19l-6.22-6.22a.75.75 0 010-1.06z" clipRule="evenodd" transform="rotate(135 12 12)" />
                      </svg>
                   </button>
                ))}
                
                {/* If > 3 battles, show summary badge */}
                {relevantBattles.length > 3 && (
                    <div className="bg-red-900/80 border border-red-500/50 text-red-100 h-[50px] px-3 rounded-lg shadow-lg flex flex-col items-center justify-center animate-in fade-in">
                        <span className="text-[10px] uppercase font-bold text-red-400">{t('ui.alerts')}</span>
                        <div className="flex items-center gap-1">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                                <path fillRule="evenodd" d="M12.97 3.97a.75.75 0 011.06 0l7.5 7.5a.75.75 0 010 1.06l-7.5 7.5a.75.75 0 11-1.06-1.06l6.22-6.22H3a.75.75 0 010-1.5h16.19l-6.22-6.22a.75.75 0 010-1.06z" clipRule="evenodd" transform="rotate(135 12 12)" />
                            </svg>
                            <span className="font-bold text-lg">{relevantBattles.length}</span>
                        </div>
                    </div>
                )}
             </div>
          )}

          {/* DEBUG BATTLE TRIGGER */}
          {battles.length === 0 && onDebugBattle && (
             <button 
                onClick={onDebugBattle}
                className="ml-4 bg-slate-800/80 hover:bg-blue-900/80 border border-blue-500/30 text-blue-200 h-[50px] px-3 rounded-lg shadow-lg flex flex-col items-center justify-center transition-colors"
                title="Debug: Force Battle UI"
             >
                <span className="text-[9px] uppercase font-bold">{t('ui.comlink')}</span>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                   <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 12V5.25" />
                </svg>
             </button>
          )}
      </div>

      {/* RIGHT: Next Turn - Compact Icon Only (50x50) */}
      <button 
        onClick={onNextTurn}
        title="Execute Next Turn"
        className="
            group flex items-center justify-center w-[50px] h-[50px]
            bg-slate-900/90 backdrop-blur-md 
            border border-emerald-500/30 hover:border-emerald-400/60
            rounded-lg shadow-[0_0_15px_rgba(16,185,129,0.1)] 
            hover:shadow-[0_0_25px_rgba(16,185,129,0.25)] hover:bg-slate-800/90
            active:scale-95 transition-all duration-200
        "
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 text-emerald-400 group-hover:text-emerald-100 transition-colors">
            <path fillRule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
        </svg>
      </button>
    </div>
  );
};

export default TopBar;
