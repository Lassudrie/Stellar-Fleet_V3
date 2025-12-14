import React from 'react';
import { Battle } from '../../types';

interface TopBarProps {
  startYear: number;
  day: number;
  battles: Battle[];
  onToggleMenu: () => void;
  onNextTurn: () => void;
  onOpenBattle: (battleId: string) => void;
  onDebugBattle?: () => void;
  /**
   * Optional, persisted meta-progression information (Engagement Rewards feature).
   * We type this as `any` on purpose so this UI patch can land independently
   * from the engine feature, without creating type-level coupling.
   */
  engagement?: any;
}

const TopBar: React.FC<TopBarProps> = ({
  startYear,
  day,
  battles,
  engagement,
  onToggleMenu,
  onNextTurn,
  onOpenBattle,
  onDebugBattle,
}) => {
  const year = startYear + (day - 1);
  
  const unresolvedBattles = battles.filter(b => b.status !== 'resolved');
  const activeBattles = battles.filter(b => b.status === 'in_progress');
  const scheduledBattles = battles.filter(b => b.status === 'scheduled');

  const engagementEnabled = engagement?.enabled !== false;
  const prestige =
    typeof engagement?.prestige === 'number' && Number.isFinite(engagement.prestige) ? engagement.prestige : 0;

  const objectives = Array.isArray(engagement?.objectives) ? engagement.objectives : [];
  const totalObjectives = objectives.length;
  const completedObjectives = objectives.filter((o: any) => o && o.completed === true).length;
  const era = typeof engagement?.era === 'string' ? engagement.era : undefined;

  return (
    <div className="absolute top-0 left-0 right-0 p-4 pointer-events-none">
      <div className="bg-slate-900/95 rounded-lg border border-slate-700 shadow-lg p-4 pointer-events-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button 
              onClick={onToggleMenu}
              className="text-slate-400 hover:text-slate-200 text-2xl"
            >
              ☰
            </button>
            <div>
              <h1 className="text-xl font-bold">Stellar Fleet Command</h1>
              <div className="text-slate-400">Year {year} - Turn {day}</div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {unresolvedBattles.length > 0 && (
              <div className="flex items-center gap-2">
                {activeBattles.map(battle => (
                  <button
                    key={battle.id}
                    onClick={() => onOpenBattle(battle.id)}
                    className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded text-sm flex items-center gap-1"
                  >
                    ⚔️ Active Battle
                  </button>
                ))}
                {scheduledBattles.map(battle => (
                  <button
                    key={battle.id}
                    onClick={() => onOpenBattle(battle.id)}
                    className="bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-1 rounded text-sm flex items-center gap-1"
                  >
                    ⚡ Scheduled Battle
                  </button>
                ))}
              </div>
            )}

            {engagement && engagementEnabled && (
              <div className="hidden sm:flex flex-col items-end bg-slate-800/60 px-2 py-1 rounded border border-slate-700">
                <div className="text-xs text-slate-200">Prestige {prestige}</div>
                {totalObjectives > 0 && (
                  <div className="text-[11px] text-slate-400">
                    Objectives {completedObjectives}/{totalObjectives}
                    {era ? ` • ${era}` : ''}
                  </div>
                )}
              </div>
            )}

            {onDebugBattle && (
              <button
                onClick={onDebugBattle}
                className="bg-purple-600 hover:bg-purple-700 text-white px-3 py-2 rounded font-bold"
              >
                DEBUG BATTLE
              </button>
            )}
            
            <button 
              onClick={onNextTurn}
              className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded font-bold"
            >
              Next Turn
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TopBar;
