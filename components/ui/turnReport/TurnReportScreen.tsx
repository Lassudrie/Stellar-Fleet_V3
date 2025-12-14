import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../../i18n';
import { fleetLabel } from '../../../engine/idUtils';
import {
  TurnReportBattleV1,
  TurnReportLogPayloadV1,
  TurnReportTab,
  TurnReportSystemChangeV1,
} from './turnReport';

interface TurnReportScreenProps {
  reports: TurnReportLogPayloadV1[];
  initialTurn?: number | null;
  initialTab?: TurnReportTab;
  availableBattleIds?: Set<string>;
  onOpenBattle?: (battleId: string) => void;
  onClose: () => void;
}

const sumRecord = (rec: Record<string, number>): number =>
  Object.values(rec ?? {}).reduce((acc, v) => acc + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);

const tabButtonBase = 'px-3 py-2 rounded-md text-xs font-bold tracking-wider uppercase transition border';

const formatWinner = (winnerFactionId: string | 'draw' | null, t: (k: string, p?: any) => string): string => {
  if (!winnerFactionId) return t('battle.unknownWinner', { defaultValue: 'Unknown' });
  if (winnerFactionId === 'draw') return t('battle.draw', { defaultValue: 'Draw' });
  return winnerFactionId;
};

const TurnReportScreen: React.FC<TurnReportScreenProps> = ({
  reports,
  initialTurn,
  initialTab,
  availableBattleIds,
  onOpenBattle,
  onClose,
}) => {
  const { t } = useI18n();

  const sortedAsc = useMemo(() => [...(reports ?? [])].sort((a, b) => a.turn - b.turn), [reports]);
  const sortedDesc = useMemo(() => [...(reports ?? [])].sort((a, b) => b.turn - a.turn), [reports]);

  const allTurns = useMemo(() => sortedDesc.map(r => r.turn), [sortedDesc]);

  const [selectedTurn, setSelectedTurn] = useState<number | null>(() => {
    if (typeof initialTurn === 'number') return initialTurn;
    return sortedDesc[0]?.turn ?? null;
  });

  const [tab, setTab] = useState<TurnReportTab>(() => initialTab ?? 'SUMMARY');

  useEffect(() => {
    if (typeof initialTurn === 'number') setSelectedTurn(initialTurn);
  }, [initialTurn]);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  const report = useMemo(() => {
    if (!sortedAsc.length) return null;
    if (selectedTurn === null) return sortedAsc[sortedAsc.length - 1];
    return sortedAsc.find(r => r.turn === selectedTurn) ?? sortedAsc[sortedAsc.length - 1];
  }, [sortedAsc, selectedTurn]);

  // Build XP totals per fleet (across all available reports) to show "progression".
  const xpTotalsByFleet = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of sortedAsc) {
      for (const [fleetId, delta] of Object.entries(r.xp?.fleetXpDelta ?? {})) {
        const d = typeof delta === 'number' && Number.isFinite(delta) ? delta : 0;
        totals.set(fleetId, (totals.get(fleetId) ?? 0) + d);
      }
    }
    return totals;
  }, [sortedAsc]);

  const renderSummary = () => {
    if (!report) return null;
    const s = report.summary;

    const cards: Array<{ label: string; value: string }> = [
      { label: t('reports.battles', { defaultValue: 'Battles' }), value: `${s.battles} (W${s.battlesWon}/L${s.battlesLost})` },
      { label: t('reports.systems', { defaultValue: 'Systems' }), value: `+${s.systemsCaptured} / -${s.systemsLost}` },
      { label: t('reports.ships', { defaultValue: 'Ships' }), value: `+${s.shipsCreated} / -${s.shipsDestroyed}` },
      { label: t('reports.fleets', { defaultValue: 'Fleets' }), value: `+${s.fleetsCreated} / -${s.fleetsDestroyed}` },
      { label: t('reports.xp', { defaultValue: 'XP' }), value: `+${s.xpDeltaTotal}` },
    ];

    return (
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-400">{t('reports.summary', { defaultValue: 'Summary' })}</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
          {cards.map(c => (
            <div key={c.label} className="bg-slate-900/30 border border-slate-800 rounded-lg p-4">
              <div className="text-xs text-slate-400">{c.label}</div>
              <div className="text-2xl font-bold text-slate-100 mt-1">{c.value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          <div className="bg-slate-950/30 border border-slate-800 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400">{t('reports.systems', { defaultValue: 'Systems' })}</div>
            <div className="mt-2">{renderSystems(report.systems)}</div>
          </div>

          <div className="bg-slate-950/30 border border-slate-800 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-slate-400">{t('reports.battles', { defaultValue: 'Battles' })}</div>
            <div className="mt-2">{renderBattles(report.battles)}</div>
          </div>
        </div>
      </div>
    );
  };

  const renderSystems = (systems: TurnReportSystemChangeV1[]) => {
    if (!systems || systems.length === 0) {
      return <div className="text-slate-400">{t('reports.none', { defaultValue: 'None' })}</div>;
    }

    return (
      <div className="space-y-2">
        {systems.map((s, idx) => (
          <div key={`${s.systemId}_${idx}`} className="flex items-center justify-between bg-slate-900/20 border border-slate-800 rounded-md px-3 py-2">
            <div className="font-bold text-slate-100">{s.systemName}</div>
            <div className={`text-xs font-bold ${s.kind === 'CAPTURED' ? 'text-emerald-300' : 'text-rose-300'}`}>
              {s.kind === 'CAPTURED'
                ? t('reports.captured', { defaultValue: 'Captured' })
                : t('reports.lost', { defaultValue: 'Lost' })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderShips = () => {
    if (!report) return null;

    const rows = Object.entries(report.deltas?.shipByType ?? {})
      .map(([type, d]) => ({ type, created: d?.created ?? 0, destroyed: d?.destroyed ?? 0 }))
      .filter(r => r.created !== 0 || r.destroyed !== 0)
      .sort((a, b) => (b.destroyed + b.created) - (a.destroyed + a.created));

    if (rows.length === 0) {
      return <div className="text-slate-400">{t('reports.none', { defaultValue: 'None' })}</div>;
    }

    return (
      <div className="overflow-hidden rounded-lg border border-slate-800">
        <div className="grid grid-cols-12 bg-slate-900/40 text-xs uppercase tracking-wider text-slate-400 px-3 py-2">
          <div className="col-span-6">{t('reports.shipType', { defaultValue: 'Ship type' })}</div>
          <div className="col-span-3 text-right">{t('reports.created', { defaultValue: 'Created' })}</div>
          <div className="col-span-3 text-right">{t('reports.destroyed', { defaultValue: 'Destroyed' })}</div>
        </div>
        {rows.map(r => (
          <div key={r.type} className="grid grid-cols-12 px-3 py-2 border-t border-slate-800 bg-slate-950/20">
            <div className="col-span-6 font-bold text-slate-200">{r.type}</div>
            <div className="col-span-3 text-right text-emerald-200 font-bold">+{r.created}</div>
            <div className="col-span-3 text-right text-rose-200 font-bold">-{r.destroyed}</div>
          </div>
        ))}
      </div>
    );
  };

  const renderFleets = () => {
    if (!report) return null;

    const created = report.deltas?.fleetCreated ?? [];
    const destroyed = report.deltas?.fleetDestroyed ?? [];

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-slate-900/30 border border-slate-800 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">{t('reports.fleetsCreated', { defaultValue: 'Fleets created' })}</div>
          <div className="mt-2 space-y-2">
            {created.length === 0 ? (
              <div className="text-slate-400">{t('reports.none', { defaultValue: 'None' })}</div>
            ) : (
              created.map(id => (
                <div key={id} className="bg-slate-950/30 border border-slate-800 rounded-md px-3 py-2">
                  <div className="font-bold text-slate-100">{fleetLabel(id)}</div>
                  <div className="text-xs text-slate-500">{id}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-slate-900/30 border border-slate-800 rounded-lg p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">{t('reports.fleetsDestroyed', { defaultValue: 'Fleets destroyed' })}</div>
          <div className="mt-2 space-y-2">
            {destroyed.length === 0 ? (
              <div className="text-slate-400">{t('reports.none', { defaultValue: 'None' })}</div>
            ) : (
              destroyed.map(id => (
                <div key={id} className="bg-slate-950/30 border border-slate-800 rounded-md px-3 py-2">
                  <div className="font-bold text-slate-100">{fleetLabel(id)}</div>
                  <div className="text-xs text-slate-500">{id}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderBattles = (battles: TurnReportBattleV1[]) => {
    if (!battles || battles.length === 0) {
      return <div className="text-slate-400">{t('reports.noBattles', { defaultValue: 'No battles resolved this turn.' })}</div>;
    }

    return (
      <div className="space-y-3">
        {battles.map(b => {
          const playerLost = sumRecord(b.playerShipsLostByType);
          const enemyLost = sumRecord(b.enemyShipsLostByType);
          const canOpenBattle = !!onOpenBattle && !!availableBattleIds?.has(b.battleId);

          return (
            <div key={b.battleId} className="bg-slate-900/30 border border-slate-800 rounded-lg p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="font-bold text-slate-100">{b.systemName}</div>
                  <div className="text-xs text-slate-400">{b.systemId} • {t('battle.rounds_other', { defaultValue: '{{count}} ROUNDS', count: b.roundsPlayed ?? 0 })}</div>
                  <div className="mt-1 text-xs text-slate-300">
                    {t('battle.reportTitle', { defaultValue: 'Battle Report' })}: {formatWinner(b.winnerFactionId, t)}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {canOpenBattle ? (
                    <button
                      type="button"
                      onClick={() => onOpenBattle?.(b.battleId)}
                      className="px-3 py-2 rounded bg-slate-200 text-black font-bold hover:scale-105 transition"
                    >
                      {t('reports.openBattle', { defaultValue: 'Open' })}
                    </button>
                  ) : (
                    <div className="text-xs text-slate-500">{t('reports.archived', { defaultValue: 'Archived' })}</div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                <div className="bg-slate-950/40 border border-slate-800 rounded-md p-3">
                  <div className="text-xs uppercase tracking-wider text-slate-400">{t('reports.yourLosses', { defaultValue: 'Your losses' })}</div>
                  <div className="text-lg font-bold text-slate-100">{playerLost}</div>
                  <div className="text-xs text-slate-400 mt-1">
                    {Object.entries(b.playerShipsLostByType).map(([k, v]) => (
                      <span key={k} className="inline-block mr-2">{k}:{v}</span>
                    ))}
                  </div>
                </div>
                <div className="bg-slate-950/40 border border-slate-800 rounded-md p-3">
                  <div className="text-xs uppercase tracking-wider text-slate-400">{t('reports.enemyLosses', { defaultValue: 'Enemy losses' })}</div>
                  <div className="text-lg font-bold text-slate-100">{enemyLost}</div>
                  <div className="text-xs text-slate-400 mt-1">
                    {Object.entries(b.enemyShipsLostByType).map(([k, v]) => (
                      <span key={k} className="inline-block mr-2">{k}:{v}</span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="mt-3 text-xs text-slate-400">
                {t('reports.tactical', { defaultValue: 'Tactical:' })} {t('battle.interceptions', { defaultValue: 'Interceptions' })} {b.missilesIntercepted} • {t('battle.pdKills', { defaultValue: 'PD Kills' })} {b.projectilesDestroyedByPd}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderXp = () => {
    if (!report) return null;
    const entries = Object.entries(report.xp?.fleetXpDelta ?? {})
      .map(([fleetId, delta]) => ({ fleetId, delta: typeof delta === 'number' && Number.isFinite(delta) ? delta : 0 }))
      .filter(e => e.delta !== 0)
      .sort((a, b) => b.delta - a.delta);

    if (entries.length === 0) {
      return <div className="text-slate-400">{t('reports.noXp', { defaultValue: 'No XP changes recorded.' })}</div>;
    }

    return (
      <div className="space-y-2">
        {entries.map(e => {
          const total = xpTotalsByFleet.get(e.fleetId) ?? e.delta;
          const level = Math.floor(total / 25) + 1;
          const nextLevelAt = level * 25;
          const prevLevelAt = (level - 1) * 25;
          const progress = nextLevelAt > prevLevelAt ? (total - prevLevelAt) / (nextLevelAt - prevLevelAt) : 0;
          const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));

          return (
            <div key={e.fleetId} className="bg-slate-900/30 border border-slate-800 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="font-bold text-slate-100">{fleetLabel(e.fleetId)}</div>
                <div className="text-sm font-bold text-slate-200">+{e.delta} XP</div>
              </div>
              <div className="text-xs text-slate-500">{e.fleetId}</div>

              <div className="mt-2">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <div>{t('reports.level', { defaultValue: 'Level' })} {level}</div>
                  <div>{total}/{nextLevelAt}</div>
                </div>
                <div className="w-full h-2 bg-slate-800 rounded mt-1 overflow-hidden">
                  <div className="h-2 bg-slate-200" style={{ width: `${pct}%` }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  if (!report) {
    return (
      <div className="absolute inset-0 z-50 pointer-events-auto">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="absolute top-10 left-1/2 -translate-x-1/2 w-[min(900px,calc(100vw-2rem))] bg-slate-950/90 border border-slate-700 rounded-xl shadow-2xl p-6">
          <div className="flex items-center justify-between">
            <div className="text-xl font-bold text-slate-100">{t('reports.title', { defaultValue: 'Turn Report' })}</div>
            <button onClick={onClose} className="px-3 py-2 rounded bg-slate-200 text-black font-bold">{t('reports.close', { defaultValue: 'Close' })}</button>
          </div>
          <div className="mt-4 text-slate-400">{t('reports.noReports', { defaultValue: 'No reports available yet.' })}</div>
        </div>
      </div>
    );
  }

  const selectedIndex = allTurns.indexOf(report.turn);
  const prevTurn = selectedIndex >= 0 && selectedIndex < allTurns.length - 1 ? allTurns[selectedIndex + 1] : null;
  const nextTurn = selectedIndex > 0 ? allTurns[selectedIndex - 1] : null;

  return (
    <div className="absolute inset-0 z-50 pointer-events-auto">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div className="absolute top-10 left-1/2 -translate-x-1/2 w-[min(1100px,calc(100vw-2rem))] h-[min(760px,calc(100vh-5rem))] bg-slate-950/90 border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex">
        <div className="w-44 border-r border-slate-800 bg-slate-950/40 overflow-y-auto">
          <div className="p-3 text-xs uppercase tracking-wider text-slate-400">{t('reports.turns', { defaultValue: 'Turns' })}</div>
          <div className="px-2 pb-3 space-y-1">
            {sortedDesc.map(r => {
              const active = r.turn === report.turn;
              return (
                <button
                  key={r.turn}
                  type="button"
                  onClick={() => setSelectedTurn(r.turn)}
                  className={`w-full text-left px-3 py-2 rounded border ${active ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-slate-950/20 border-slate-900 text-slate-300 hover:bg-slate-900/40'}`}
                >
                  <div className="font-bold">{t('ui.turn', { defaultValue: 'Turn' })} {r.turn}</div>
                  <div className="text-xs text-slate-500">{t('reports.battles', { defaultValue: 'Battles' })}: {r.summary?.battles ?? 0}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          <div className="p-4 border-b border-slate-800 flex items-center justify-between gap-3">
            <div>
              <div className="text-2xl font-bold text-slate-100">{t('reports.title', { defaultValue: 'Turn Report' })}</div>
              <div className="text-sm text-slate-400">{t('ui.turn', { defaultValue: 'Turn' })} {report.turn}</div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => prevTurn && setSelectedTurn(prevTurn)}
                disabled={!prevTurn}
                className={`px-3 py-2 rounded border ${prevTurn ? 'bg-slate-900 border-slate-700 hover:bg-slate-800 text-slate-200' : 'bg-slate-950 border-slate-900 text-slate-600 cursor-not-allowed'}`}
              >
                ◀
              </button>
              <button
                type="button"
                onClick={() => nextTurn && setSelectedTurn(nextTurn)}
                disabled={!nextTurn}
                className={`px-3 py-2 rounded border ${nextTurn ? 'bg-slate-900 border-slate-700 hover:bg-slate-800 text-slate-200' : 'bg-slate-950 border-slate-900 text-slate-600 cursor-not-allowed'}`}
              >
                ▶
              </button>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded bg-slate-200 text-black font-bold hover:scale-105 transition"
              >
                {t('reports.close', { defaultValue: 'Close' })}
              </button>
            </div>
          </div>

          <div className="px-4 border-b border-slate-800 flex flex-wrap gap-2">
            {(['SUMMARY', 'BATTLES', 'SYSTEMS', 'SHIPS', 'FLEETS', 'XP'] as TurnReportTab[]).map(k => {
              const active = tab === k;
              const labelKey =
                k === 'SUMMARY' ? 'reports.summary' :
                k === 'BATTLES' ? 'reports.battles' :
                k === 'SYSTEMS' ? 'reports.systems' :
                k === 'SHIPS' ? 'reports.ships' :
                k === 'FLEETS' ? 'reports.fleets' :
                'reports.xp';

              return (
                <button
                  key={k}
                  type="button"
                  className={`${tabButtonBase} ${active ? 'border-slate-200 text-slate-100' : 'border-transparent text-slate-400 hover:text-slate-200'}`}
                  onClick={() => setTab(k)}
                >
                  {t(labelKey, { defaultValue: k })}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {tab === 'SUMMARY' && renderSummary()}
            {tab === 'BATTLES' && renderBattles(report.battles)}
            {tab === 'SYSTEMS' && renderSystems(report.systems)}
            {tab === 'SHIPS' && renderShips()}
            {tab === 'FLEETS' && renderFleets()}
            {tab === 'XP' && renderXp()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TurnReportScreen;
