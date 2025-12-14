import React, { useMemo } from 'react';
import { Battle } from '../../types';
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

  // TURN REPORTS (SITREP)
  onOpenTurnReports?: () => void;
  turnReportsCount?: number;
  hasNewTurnReport?: boolean;
}

const TopBar: React.FC<TopBarProps> = ({ 
  startYear, day, battles = [], onToggleMenu, onNextTurn, onOpenBattle, onDebugBattle,
  onOpenTurnReports, turnReportsCount = 0, hasNewTurnReport = false,
}) => {
  const { t } = useI18n();
  const currentYear = startYear + day - 1;

  // Calculate relevant battles - only show those from current or recent turn
  const relevantBattles = useMemo(() => {
    return battles
      .filter(battle => battle.status === 'resolved' && battle.turnResolved && battle.turnResolved >= day - 1)
      .slice(-3); // Show max 3 battle notifications
  }, [battles, day]);

  return (
    <div className="absolute top-4 left-4 right-4 flex justify-between items-start z-20 pointer-events-none">
      {/* Left side */}
      <div className="flex items-center gap-3 pointer-events-auto">
          {/* Menu Button */}
          <button 
              onClick={onToggleMenu}
              className="bg-black/60 backdrop-blur w-12 h-12 rounded-lg border border-white/10 flex items-center justify-center hover:bg-black/80 transition-all shadow-lg"
          >
              <div className="w-6 h-5 flex flex-col justify-between">
                  <span className="w-full h-0.5 bg-white/80"></span>
                  <span className="w-full h-0.5 bg-white/80"></span>
                  <span className="w-full h-0.5 bg-white/80"></span>
              </div>
          </button>

          {/* Simulation Info */}
          <div className="bg-black/60 backdrop-blur px-4 py-2 rounded-lg border border-white/10 text-white h-[50px] flex flex-col justify-center shadow-lg">
              <div className="text-[10px] text-blue-200/60 uppercase tracking-widest leading-none mb-1 font-mono">{t('ui.year')} {currentYear}</div>
              <div className="flex items-end gap-2">
                  <div className="text-lg font-bold leading-none">{t('ui.turn')} {day}</div>
                  <div className="text-xs text-white/60 leading-none pb-0.5">{t('ui.galaxy')}</div>
              </div>
          </div>

          {/* Turn Report shortcut */}
          {onOpenTurnReports && (
            <button
              onClick={onOpenTurnReports}
              className="bg-slate-900/80 backdrop-blur px-4 py-2 rounded-lg border border-slate-700 text-white h-[50px] flex flex-col justify-center shadow-lg hover:bg-slate-800/80 transition-all"
              title={t('reports.turnReport', { defaultValue: 'Turn Report' })}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] text-slate-300/70 uppercase tracking-widest leading-none font-mono">
                  {t('ui.sitrep', { defaultValue: 'SITREP' })}
                </div>
                {hasNewTurnReport && <div className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse" />}
              </div>
              <div className="text-xs text-slate-200 font-bold leading-none mt-1">
                {turnReportsCount} {t('reports.available_other', { defaultValue: 'reports', count: turnReportsCount })}
              </div>
            </button>
          )}

          {/* Battle Notifications */}
          {relevantBattles.length > 0 && (
              <div className="flex gap-2">
                  {relevantBattles.map(battle => (
                      <button
                          key={battle.id}
                          onClick={() => onOpenBattle(battle.id)}
                          className="bg-rose-900/70 backdrop-blur px-3 py-2 rounded-lg border border-rose-500/30 text-white hover:bg-rose-800/70 transition-all shadow-lg h-[50px]"
                      >
                          <div className="text-[10px] text-rose-200/60 uppercase tracking-wider leading-none mb-1">{t('ui.battle')}</div>
                          <div className="text-sm font-bold leading-none">{battle.status === 'resolved' ? t('ui.report') : t('ui.combat')}</div>
                      </button>
                  ))}
              </div>
          )}
      </div>

      {/* Right side */}
      <div className="flex gap-3 pointer-events-auto">
          {/* Debug Battle Button (dev mode only) */}
          {onDebugBattle && (
              <button
                  onClick={onDebugBattle}
                  className="bg-purple-900/70 backdrop-blur px-4 py-2 rounded-lg border border-purple-500/30 text-white hover:bg-purple-800/70 transition-all shadow-lg h-[50px] flex flex-col justify-center"
              >
                  <div className="text-[10px] text-purple-200/60 uppercase tracking-wider leading-none mb-1">Debug</div>
                  <div className="text-sm font-bold leading-none">Battle</div>
              </button>
          )}

          {/* Next Turn Button */}
          <button 
              onClick={onNextTurn}
              className="bg-blue-900/70 backdrop-blur px-6 py-2 rounded-lg border border-blue-500/30 text-white hover:bg-blue-800/70 transition-all shadow-lg h-[50px] flex flex-col justify-center"
          >
              <div className="text-[10px] text-blue-200/60 uppercase tracking-wider leading-none mb-1">{t('ui.next')}</div>
              <div className="text-sm font-bold leading-none">{t('ui.turn')}</div>
          </button>
      </div>
    </div>
  );
};

export default TopBar;
