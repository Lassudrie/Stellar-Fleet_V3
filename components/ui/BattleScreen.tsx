
import React, { useMemo, useEffect, useRef } from 'react';
import { GameState, Fleet, FactionId, Battle, BattleShipSnapshot } from '../../types';
import { useI18n } from '../../i18n';

interface BattleScreenProps {
  battleId?: string;
  gameState: GameState;
  onClose: () => void;
  // Overrides kept for interface compatibility (debug only)
  blueFleetOverride?: Fleet;
  redFleetOverride?: Fleet;
}

const BattleScreen: React.FC<BattleScreenProps> = ({ 
    battleId, gameState, onClose, blueFleetOverride, redFleetOverride 
}) => {
  const { t } = useI18n();
  const logContainerRef = useRef<HTMLDivElement>(null);
  const playerFactionId = gameState.playerFactionId;

  // 1. Retrieve the Authoritative Battle Object OR Construct Mock
  const battle = useMemo(() => {
      const realBattle = gameState.battles?.find(b => b.id === battleId);
      if (realBattle) return realBattle;

      if (blueFleetOverride || redFleetOverride) {
           // Mock for Debug
           return {
               id: battleId || 'debug-mock',
               systemId: 'debug-system',
               turnCreated: gameState.day,
               turnResolved: gameState.day,
               status: 'resolved',
               involvedFleetIds: [blueFleetOverride?.id || 'mock-blue', redFleetOverride?.id || 'mock-red'],
               initialShips: [], // Mock simplified
               survivorShipIds: [],
               logs: ['[DEBUG] Com-Link Established.'],
               winnerFactionId: 'draw',
               roundsPlayed: 0,
               shipsLost: {},
               missilesIntercepted: 0,
               projectilesDestroyedByPd: 0
           } as Battle;
      }
      return undefined;
  }, [battleId, gameState.battles, blueFleetOverride, redFleetOverride, gameState.day]);

  // 2. Aggregate Data using Snapshot
  const stats = useMemo(() => {
      if (!battle) return null;

      // Identify Opponent (The first faction involved that isn't the player)
      let enemyFactionId = 'red'; // Fallback
      if (battle.initialShips && battle.initialShips.length > 0) {
          const distinctFactions = Array.from(new Set(battle.initialShips.map(s => s.factionId)));
          const enemy = distinctFactions.find(f => f !== playerFactionId);
          if (enemy) enemyFactionId = enemy;
      }

      // Prepare result object
      const result = {
          blue: { initial: 0, lost: 0, survivors: 0, fleets: [] as string[], composition: {} as any },
          red: { initial: 0, lost: 0, survivors: 0, fleets: [] as string[], composition: {} as any }
      };

      if (battle.initialShips && battle.survivorShipIds) {
          const survivorSet = new Set(battle.survivorShipIds);

          const processSide = (side: 'blue' | 'red', targetFactionId: string) => {
              const snaps = battle.initialShips!.filter(s => s.factionId === targetFactionId);
              const lost = snaps.reduce((count, s) => count + (survivorSet.has(s.shipId) ? 0 : 1), 0);
              const fleets = Array.from(new Set(snaps.map(s => s.fleetId.split('_').pop()?.toUpperCase() || '???')));
              
              const comp: any = {};
              snaps.forEach(s => {
                  if (!comp[s.type]) comp[s.type] = { engaged: 0, lost: 0 };
                  comp[s.type].engaged++;
                  if (!survivorSet.has(s.shipId)) comp[s.type].lost++;
              });

              result[side] = {
                  initial: snaps.length,
                  lost,
                  survivors: snaps.length - lost,
                  fleets,
                  composition: comp
              };
          };

          processSide('blue', playerFactionId);
          processSide('red', enemyFactionId);
      }

      return result;
  }, [battle, gameState.fleets, playerFactionId]);

  useEffect(() => {
      if (logContainerRef.current) {
          logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      }
  }, [battle]);

  if (!battle || !stats) return null;

  const systemName = battle.systemId === 'debug-system' 
      ? 'SIMULATION' 
      : (gameState.systems.find(s => s.id === battle.systemId)?.name || 'Unknown System');
  
  const winnerText = battle.winnerFactionId === 'draw' ? t('battle.draw')
                     : battle.winnerFactionId === playerFactionId ? t('battle.victory', { winner: 'FLEET' })
                     : battle.winnerFactionId ? t('battle.defeat')
                     : t('battle.unknown');
                     
  const winnerColor = battle.winnerFactionId === playerFactionId ? 'text-blue-500' 
                    : battle.winnerFactionId === 'draw' ? 'text-slate-400' 
                    : 'text-red-500';

  const roundsText = battle.roundsPlayed 
        ? (battle.roundsPlayed === 1 ? t('battle.rounds_one') : t('battle.rounds_other', { count: battle.roundsPlayed }))
        : t('battle.finished');

  const renderComposition = (comp: Record<string, { engaged: number, lost: number }>, colorClass: string) => {
      const types = Object.keys(comp).sort();
      if (types.length === 0) return null;

      return (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 w-full max-w-[200px] text-[10px] font-mono opacity-80">
              {types.map(type => {
                  const data = comp[type];
                  return (
                      <React.Fragment key={type}>
                          <div className="text-slate-400 capitalize text-right">{type}</div>
                          <div className={`${colorClass} font-bold`}>
                             {data.engaged - data.lost} <span className="text-slate-600">/ {data.engaged}</span>
                          </div>
                      </React.Fragment>
                  );
              })}
          </div>
      );
  };

  return (
    <div className="absolute inset-0 z-50 bg-slate-950/95 backdrop-blur-md flex flex-col pointer-events-auto animate-in fade-in duration-200 safe-area">
        {/* HEADER */}
        <div className="bg-slate-900 border-b border-slate-700 p-4 flex justify-between items-center shadow-lg shrink-0">
            <div>
                <div className="text-slate-400 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2">
                    <span>{t('battle.reportTitle')}</span>
                    <span className="w-1 h-1 bg-slate-500 rounded-full"></span>
                    <span>{t('ui.turn')} {battle.turnResolved || battle.turnCreated}</span>
                    <span className="w-1 h-1 bg-slate-500 rounded-full"></span>
                    <span>{roundsText}</span>
                </div>
                <div className="flex items-baseline gap-3">
                    <h1 className="text-white text-2xl font-bold uppercase tracking-tight">{systemName}</h1>
                    <span className={`text-xl font-black ${winnerColor} uppercase`}>{winnerText}</span>
                </div>
            </div>
            
            <button 
                onClick={onClose}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-6 py-2 rounded font-bold border border-slate-600 transition-colors uppercase text-sm tracking-wider"
            >
                {t('battle.close')}
            </button>
        </div>

        {/* STATS OVERVIEW */}
        <div className="grid grid-cols-2 gap-px bg-slate-800 shrink-0">
            {/* BLUE SIDE (PLAYER) */}
            <div className="bg-slate-900/50 p-4 flex flex-col items-center border-b-4 border-blue-600">
                <div className="text-blue-500 font-bold uppercase tracking-widest text-sm mb-1">{t('battle.blueForces')}</div>
                <div className="flex gap-8 text-center mb-1">
                    <div>
                        <div className="text-3xl font-black text-white">{stats.blue.survivors}</div>
                        <div className="text-[10px] text-slate-400 uppercase">{t('battle.survivors')}</div>
                    </div>
                    <div>
                        <div className="text-3xl font-black text-red-400">-{stats.blue.lost}</div>
                        <div className="text-[10px] text-slate-400 uppercase">{t('battle.lost')}</div>
                    </div>
                </div>
                {renderComposition(stats.blue.composition, 'text-blue-300')}
                <div className="mt-2 text-xs text-slate-500">
                    {t('battle.fleets')} {stats.blue.fleets.join(', ') || t('battle.none')}
                </div>
            </div>

            {/* RED SIDE (ENEMY) */}
            <div className="bg-slate-900/50 p-4 flex flex-col items-center border-b-4 border-red-600">
                <div className="text-red-500 font-bold uppercase tracking-widest text-sm mb-1">{t('battle.redForces')}</div>
                <div className="flex gap-8 text-center mb-1">
                    <div>
                        <div className="text-3xl font-black text-white">{stats.red.survivors}</div>
                        <div className="text-[10px] text-slate-400 uppercase">{t('battle.survivors')}</div>
                    </div>
                    <div>
                        <div className="text-3xl font-black text-red-400">-{stats.red.lost}</div>
                        <div className="text-[10px] text-slate-400 uppercase">{t('battle.lost')}</div>
                    </div>
                </div>
                {renderComposition(stats.red.composition, 'text-red-300')}
                <div className="mt-2 text-xs text-slate-500">
                     {t('battle.fleets')} {stats.red.fleets.join(', ') || t('battle.none')}
                </div>
            </div>
        </div>

        {/* COMBAT LOGS */}
        <div className="flex-1 overflow-hidden flex flex-col bg-black">
            <div className="bg-slate-900/80 px-4 py-2 text-[10px] text-slate-500 uppercase tracking-widest font-bold border-b border-slate-800">
                {t('battle.tacticalData')}
            </div>
            <div 
                ref={logContainerRef}
                className="flex-1 overflow-y-auto p-4 font-mono text-sm space-y-1 custom-scrollbar"
            >
                {battle.logs.length === 0 && <div className="text-slate-600 italic">{t('battle.noData')}</div>}
                {battle.logs.map((log, i) => {
                    let color = "text-slate-300";
                    if (log.includes("ROUND")) color = "text-blue-300 font-bold mt-4 mb-2 border-b border-blue-900/30 pb-1";
                    else if (log.includes("!!")) color = "text-red-400 font-bold";
                    else if (log.includes("intercepted")) color = "text-yellow-500/80";
                    else if (log.includes("PD from")) color = "text-cyan-500/80";
                    else if (log.includes("BATTLE ENDED")) color = "text-white font-black bg-slate-900 p-2 mt-4 text-center border border-slate-700";

                    return (
                        <div key={i} className={color}>
                           {!log.includes("ROUND") && !log.includes("BATTLE ENDED") && <span className="text-slate-700 mr-2 text-[10px] select-none">[{i.toString().padStart(3, '0')}]</span>}
                           {log}
                        </div>
                    );
                })}
            </div>
        </div>
    </div>
  );
};

export default BattleScreen;
