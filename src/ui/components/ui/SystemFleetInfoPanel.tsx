import React from 'react';
import { Fleet, FleetState } from '../../../shared/shared';
import { useI18n } from '../../i18n';

interface SystemFleetInfoPanelProps {
  fleet: Fleet;
  fleetName: string;
  factionName?: string;
  factionColor?: string;
  power?: number;
  isSelected: boolean;
  onClearSelection?: () => void;
  onCenter?: () => void;
  onInspect?: () => void;
}

const formatFleetStateKey = (state: FleetState): string => {
  switch (state) {
    case FleetState.ORBIT:
      return 'systemView.fleetInfo.state.orbit';
    case FleetState.MOVING:
      return 'systemView.fleetInfo.state.moving';
    case FleetState.COMBAT:
      return 'systemView.fleetInfo.state.combat';
    default:
      return 'systemView.fleetInfo.state.orbit';
  }
};

const formatPower = (power: number | undefined): string | undefined => {
  if (typeof power !== 'number' || !Number.isFinite(power)) return undefined;
  return Math.round(power).toLocaleString();
};

const SystemFleetInfoPanel: React.FC<SystemFleetInfoPanelProps> = ({
  fleet,
  fleetName,
  factionName,
  factionColor,
  power,
  isSelected,
  onClearSelection,
  onCenter,
  onInspect
}) => {
  const { t } = useI18n();
  const isHover = !isSelected;
  const powerLabel = formatPower(power);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/85 p-4 text-sm text-slate-100 shadow-xl backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">{t('systemView.fleetInfo.title')}</div>
          <div className="text-lg font-semibold leading-tight">{fleetName}</div>
          <div className="text-xs text-slate-400">
            {isHover ? t('systemView.fleetInfo.hovered') : t('systemView.fleetInfo.selected')}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {onCenter && (
            <button
              type="button"
              onClick={onCenter}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              {t('systemView.fleetInfo.center')}
            </button>
          )}
          {onInspect && (
            <button
              type="button"
              onClick={onInspect}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              {t('systemView.fleetInfo.inspect')}
            </button>
          )}
          {factionName && (
            <span
              className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-200"
              style={factionColor ? { borderColor: factionColor, color: factionColor } : undefined}
            >
              {factionName}
            </span>
          )}
          {!isHover && onClearSelection && (
            <button
              type="button"
              onClick={onClearSelection}
              className="text-[11px] font-semibold uppercase tracking-wide text-slate-200 transition hover:text-white"
            >
              {t('systemView.fleetInfo.clearSelection')}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm text-slate-200">
        <div className="flex justify-between gap-2">
          <span className="text-slate-400">{t('systemView.fleetInfo.state')}</span>
          <span className="font-semibold text-white">{t(formatFleetStateKey(fleet.state))}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-400">{t('systemView.fleetInfo.ships')}</span>
          <span className="font-semibold text-white">{fleet.ships.length}</span>
        </div>
        {powerLabel && (
          <div className="flex justify-between gap-2">
            <span className="text-slate-400">{t('systemView.fleetInfo.power')}</span>
            <span className="font-semibold text-white">{powerLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default SystemFleetInfoPanel;
