import React from 'react';
import { Station } from '../../../shared/shared';
import { useI18n } from '../../i18n';

interface SystemStationInfoPanelProps {
  station: Station;
  stationName: string;
  factionName?: string;
  factionColor?: string;
  isSelected: boolean;
  onClearSelection?: () => void;
  onCenter?: () => void;
}

const stationTypeKey = (type: Station['type']): string => {
  switch (type) {
    case 'shipyard':
      return 'systemView.stationInfo.type.shipyard';
    case 'mining':
      return 'systemView.stationInfo.type.mining';
    case 'defense':
      return 'systemView.stationInfo.type.defense';
    case 'relay':
      return 'systemView.stationInfo.type.relay';
    case 'outpost':
      return 'systemView.stationInfo.type.outpost';
    default:
      return 'systemView.stationInfo.type.outpost';
  }
};

const SystemStationInfoPanel: React.FC<SystemStationInfoPanelProps> = ({
  station,
  stationName,
  factionName,
  factionColor,
  isSelected,
  onClearSelection,
  onCenter
}) => {
  const { t } = useI18n();
  const isHover = !isSelected;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/85 p-4 text-sm text-slate-100 shadow-xl backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">{t('systemView.stationInfo.title')}</div>
          <div className="text-lg font-semibold leading-tight">{stationName}</div>
          <div className="text-xs text-slate-400">
            {isHover ? t('systemView.stationInfo.hovered') : t('systemView.stationInfo.selected')}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          {onCenter && (
            <button
              type="button"
              onClick={onCenter}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-100 transition hover:border-slate-500 hover:bg-slate-700"
            >
              {t('systemView.stationInfo.center')}
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
              {t('systemView.stationInfo.clearSelection')}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-2 text-sm text-slate-200">
        <div className="flex justify-between gap-2">
          <span className="text-slate-400">{t('systemView.stationInfo.type')}</span>
          <span className="font-semibold text-white">{t(stationTypeKey(station.type))}</span>
        </div>
      </div>
    </div>
  );
};

export default SystemStationInfoPanel;
