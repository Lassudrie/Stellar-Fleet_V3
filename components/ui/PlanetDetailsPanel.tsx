import React from 'react';
import { StarSystem } from '../../types';
import { useI18n } from '../../i18n';

interface PlanetDetailsPanelProps {
  planet: any;
  system: StarSystem;
  onClose: () => void;
}

const PlanetDetailsPanel: React.FC<PlanetDetailsPanelProps> = ({ planet, system, onClose }) => {
  const { t } = useI18n();
  const name = planet?.name ?? t('ui.planet', { defaultValue: 'Planet' });

  return (
    <div className="absolute top-28 right-4 w-72 bg-slate-900/90 border border-slate-700 rounded-lg shadow-xl pointer-events-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-xs text-slate-400 uppercase tracking-wide">{t('ui.planet', { defaultValue: 'Planet' })}</div>
          <div className="text-lg font-bold text-white">{name}</div>
          <div className="text-xs text-slate-500">{system.name}</div>
        </div>
        <button onClick={onClose} className="text-slate-300 hover:text-white text-xl" aria-label={t('ui.close', { defaultValue: 'Close' })}>
          ×
        </button>
      </div>
      <div className="px-4 py-3 text-slate-200 text-sm space-y-2">
        {planet?.resource && <div>{t('ui.resource', { defaultValue: 'Resource' })}: {planet.resource}</div>}
        {planet?.population && <div>{t('ui.population', { defaultValue: 'Population' })}: {planet.population}</div>}
        {!planet?.resource && !planet?.population && (
          <div className="text-slate-400">{t('ui.noData', { defaultValue: 'No additional data.' })}</div>
        )}
      </div>
    </div>
  );
};

export default PlanetDetailsPanel;
