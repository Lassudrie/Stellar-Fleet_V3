import React from 'react';
import { PlanetBodyType } from '../../../shared/shared';
import { useI18n } from '../../i18n';

export type SystemBodyInfo = {
  id: string;
  name: string;
  bodyType: PlanetBodyType | 'star';
  bodySubType?: string;
  radiusKm?: number;
  atmosphere?: string;
  habitabilityScore?: number;
};

interface SystemBodyInfoPanelProps {
  body?: SystemBodyInfo;
  isSelected: boolean;
  onClearSelection?: () => void;
  onCenter?: (bodyId: string) => void;
}

const formatRadius = (radiusKm: number | undefined, unknown: string): string => {
  if (typeof radiusKm !== 'number' || !Number.isFinite(radiusKm)) return unknown;
  const display = radiusKm >= 1 ? radiusKm.toLocaleString(undefined, { maximumFractionDigits: 0 }) : radiusKm.toFixed(3);
  return `${display} km`;
};

const formatHabitability = (score: number | undefined, unknown: string): string => {
  if (typeof score !== 'number' || !Number.isFinite(score)) return unknown;
  return score.toFixed(2);
};

const SystemBodyInfoPanel: React.FC<SystemBodyInfoPanelProps> = ({ body, isSelected, onClearSelection, onCenter }) => {
  const { t } = useI18n();
  const unknown = t('systemView.bodyInfo.unknown');

  if (!body) {
    return (
      <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-4 text-sm text-slate-200 shadow-lg">
        <div className="text-xs uppercase tracking-wide text-slate-400">{t('systemView.bodyInfo.title')}</div>
        <div className="mt-2 text-slate-300">{t('systemView.bodyInfo.hoverHint')}</div>
      </div>
    );
  }

  const badgeLabel = t(`systemView.bodyInfo.bodyType.${body.bodyType}`);
  const isHover = !isSelected;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/85 p-4 text-sm text-slate-100 shadow-xl backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">{t('systemView.bodyInfo.title')}</div>
          <div className="text-lg font-semibold leading-tight">{body.name}</div>
          <div className="text-xs text-slate-400">
            {isHover ? t('systemView.bodyInfo.hovered') : t('systemView.bodyInfo.selected')}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {onCenter && (
            <button
              type="button"
              onClick={() => onCenter(body.id)}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              {t('systemView.bodyInfo.center')}
            </button>
          )}
          <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-200">
            {badgeLabel}
          </span>
          {body.bodySubType && (
            <span className="rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
              {body.bodySubType}
            </span>
          )}
          {!isHover && onClearSelection && (
            <button
              type="button"
              onClick={onClearSelection}
              className="text-[11px] font-semibold uppercase tracking-wide text-slate-200 transition hover:text-white"
            >
              {t('systemView.bodyInfo.clearSelection')}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm text-slate-200">
        <div className="flex justify-between gap-2">
          <span className="text-slate-400">{t('systemView.bodyInfo.radius')}</span>
          <span className="font-semibold text-white">{formatRadius(body.radiusKm, unknown)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-400">{t('systemView.bodyInfo.atmosphere')}</span>
          <span className="font-semibold text-white">{body.atmosphere ?? unknown}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-400">{t('systemView.bodyInfo.habitability')}</span>
          <span className="font-semibold text-white">{formatHabitability(body.habitabilityScore, unknown)}</span>
        </div>
      </div>
    </div>
  );
};

export default SystemBodyInfoPanel;
