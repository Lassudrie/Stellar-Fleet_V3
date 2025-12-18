
import React, { useMemo, useEffect, useRef } from 'react';
import { GameState, Fleet, FactionId, Battle, BattleShipSnapshot, FactionState } from '../../types';
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
  const factionLookup = useMemo(() => {
      const map = new Map<FactionId, FactionState>();
      gameState.factions.forEach(f => map.set(f.id, f));
      return map;
  }, [gameState.factions]);

  const stats = useMemo(() => {
      if (!battle || !battle.initialShips) return null;

      const survivorSet = new Set(battle.survivorShipIds || []);
      const grouped = new Map<FactionId, BattleShipSnapshot[]>();

      battle.initialShips.forEach(snap => {
          if (!grouped.has(snap.factionId)) grouped.set(snap.factionId, []);
          grouped.get(snap.factionId)!.push(snap);
      });

      const factionStats = Array.from(grouped.entries()).map(([factionId, snaps]) => {
          const faction = factionLookup.get(factionId);
          const lost = snaps.reduce((count, s) => count + (survivorSet.has(s.shipId) ? 0 : 1), 0);
          const fleets = Array.from(new Set(snaps.map(s => s.fleetId.split('_').pop()?.toUpperCase() || '???')));

          const composition: Record<string, { engaged: number; lost: number }> = {};
          snaps.forEach(s => {
              if (!composition[s.type]) composition[s.type] = { engaged: 0, lost: 0 };
              composition[s.type].engaged++;
              if (!survivorSet.has(s.shipId)) composition[s.type].lost++;
          });

          return {
              factionId,
              factionName: faction?.name || factionId.toUpperCase(),
              color: faction?.color || '#38bdf8',
              initial: snaps.length,
              lost,
              survivors: snaps.length - lost,
              fleets,
              composition,
          };
      });

      const ordered = factionStats.sort((a, b) => b.initial - a.initial);
      const playerEntry = ordered.find(s => s.factionId === playerFactionId);
      const enemyEntry = ordered.find(s => s.factionId !== playerFactionId);
      const rest = ordered.filter(s => s !== playerEntry && s !== enemyEntry);

      return playerEntry || enemyEntry
          ? [playerEntry, enemyEntry, ...rest].filter(Boolean) as typeof factionStats
          : ordered;
  }, [battle, factionLookup, playerFactionId]);

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

  const renderComposition = (comp: Record<string, { engaged: number, lost: number }>, color: string) => {
      const types = Object.keys(comp).sort();
      if (types.length === 0) return null;

      return (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 w-full max-w-[200px] text-[10px] font-mono opacity-80">
              {types.map(type => {
                  const data = comp[type];
                  return (
                      <React.Fragment key={type}>
                          <div className="text-slate-400 capitalize text-right">{type}</div>
                          <div className="font-bold" style={{ color }}>
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
            {stats.map(stat => (
                <div
                    key={stat.factionId}
                    className="bg-slate-900/50 p-4 flex flex-col items-center border-b-4"
                    style={{ borderBottomColor: stat.color }}
                >
                    <div
                        className="font-bold uppercase tracking-widest text-sm mb-1"
                        style={{ color: stat.color }}
                    >
                        {t('battle.factionForces', { faction: stat.factionName })}
                    </div>
                    <div className="flex gap-8 text-center mb-1">
                        <div>
                            <div className="text-3xl font-black text-white">{stat.survivors}</div>
                            <div className="text-[10px] text-slate-400 uppercase">{t('battle.survivors')}</div>
                        </div>
                        <div>
                            <div className="text-3xl font-black text-red-400">-{stat.lost}</div>
                            <div className="text-[10px] text-slate-400 uppercase">{t('battle.lost')}</div>
                        </div>
                    </div>
                    {renderComposition(stat.composition, stat.color)}
                    <div className="mt-2 text-xs text-slate-500">
                        {t('battle.fleets')} {stat.fleets.join(', ') || t('battle.none')}
                    </div>
                </div>
            ))}
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
