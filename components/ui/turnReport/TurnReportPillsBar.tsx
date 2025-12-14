import React from 'react';
import { useI18n } from '../../../i18n';
import { TurnReportLogPayloadV1, TurnReportTab } from './turnReport';

interface TurnReportPillsBarProps {
  report: TurnReportLogPayloadV1;
  onOpen: (turn: number, tab: TurnReportTab) => void;
  onDismiss: (turn: number) => void;
}

const pillBase =
  'px-3 py-2 rounded-full border border-white/15 bg-black/60 backdrop-blur text-white text-xs font-bold tracking-wide hover:bg-black/80 hover:scale-[1.02] transition';

const TurnReportPillsBar: React.FC<TurnReportPillsBarProps> = ({ report, onOpen, onDismiss }) => {
  const { t } = useI18n();

  const s = report.summary;
  const shipsLost = s.shipsDestroyed;
  const systemsNet = `${s.systemsCaptured}/${s.systemsLost}`;
  const xp = s.xpDeltaTotal;

  return (
    <div className="pointer-events-auto">
      <div className="flex items-center gap-2 bg-slate-950/40 border border-slate-700 rounded-full px-3 py-2 shadow-xl">
        <div className="text-xs text-slate-200/80 font-mono">
          {t('reports.pills.newTurnReport', { defaultValue: 'TURN REPORT' })} • {t('ui.turn', { defaultValue: 'Turn' })} {report.turn}
        </div>

        <button className={pillBase} onClick={() => onOpen(report.turn, 'BATTLES')}>
          {t('reports.pills.battles_other', { defaultValue: '{{count}} Battles', count: s.battles })}
        </button>

        <button className={pillBase} onClick={() => onOpen(report.turn, 'SHIPS')}>
          {t('reports.pills.shipsLost_other', { defaultValue: '{{count}} Ships lost', count: shipsLost })}
        </button>

        <button className={pillBase} onClick={() => onOpen(report.turn, 'SYSTEMS')}>
          {t('reports.pills.systems_other', { defaultValue: 'Systems {{count}}', count: systemsNet })}
        </button>

        <button className={pillBase} onClick={() => onOpen(report.turn, 'XP')}>
          {t('reports.pills.xp_other', { defaultValue: '+{{count}} XP', count: xp })}
        </button>

        <button
          className="ml-1 px-3 py-2 rounded-full bg-slate-200 text-black text-xs font-bold hover:scale-105 transition"
          onClick={() => onOpen(report.turn, 'SUMMARY')}
        >
          {t('reports.pills.open', { defaultValue: 'Open' })}
        </button>

        <button
          className="ml-1 px-3 py-2 rounded-full bg-transparent border border-white/10 text-slate-200/80 text-xs hover:bg-white/5 transition"
          onClick={() => onDismiss(report.turn)}
          aria-label={t('reports.pills.dismiss', { defaultValue: 'Dismiss' })}
          title={t('reports.pills.dismiss', { defaultValue: 'Dismiss' })}
        >
          ✕
        </button>
      </div>
    </div>
  );
};

export default TurnReportPillsBar;
