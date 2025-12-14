import React from 'react';
import { Fleet, ShipEntity } from '../../types';
import { useI18n } from '../../i18n';

interface ShipDetailsPanelProps {
  ship: ShipEntity;
  fleet: Fleet;
  onClose: () => void;
}

const ShipDetailsPanel: React.FC<ShipDetailsPanelProps> = ({ ship, fleet, onClose }) => {
  const { t } = useI18n();

  return (
    <div className="absolute top-24 right-4 w-64 bg-slate-900/90 border border-slate-700 rounded-lg shadow-xl pointer-events-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-xs text-slate-400 uppercase tracking-wide">{t('sidemenu.ship', { defaultValue: 'Ship' })}</div>
          <div className="text-lg font-bold text-white">{ship.type}</div>
          <div className="text-xs text-slate-500">{ship.id}</div>
        </div>
        <button onClick={onClose} className="text-slate-300 hover:text-white text-xl" aria-label={t('ui.close', { defaultValue: 'Close' })}>
          ×
        </button>
      </div>
      <div className="px-4 py-3 text-slate-200 space-y-2 text-sm">
        <div>{t('ui.fleet', { defaultValue: 'Fleet' })}: {fleet.id}</div>
        <div>{t('ui.hp', { defaultValue: 'HP' })}: {ship.hp}/{ship.maxHp}</div>
        {ship.carriedArmyId && <div>{t('ui.army', { defaultValue: 'Army' })}: {ship.carriedArmyId}</div>}
      </div>
    </div>
  );
};

export default ShipDetailsPanel;
