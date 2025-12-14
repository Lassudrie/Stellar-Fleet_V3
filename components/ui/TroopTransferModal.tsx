import React, { useState } from 'react';
import { Fleet } from '../../types';
import { useI18n } from '../../i18n';

interface TroopTransferModalProps {
  fromFleetId: string;
  toFleetId: string;
  fleets: Fleet[];
  onConfirm: (troopCount: number) => void;
  onCancel: () => void;
}

const TroopTransferModal: React.FC<TroopTransferModalProps> = ({ fromFleetId, toFleetId, fleets, onConfirm, onCancel }) => {
  const { t } = useI18n();
  const [count, setCount] = useState(0);

  const fromFleet = fleets.find(f => f.id === fromFleetId);
  const toFleet = fleets.find(f => f.id === toFleetId);

  return (
    <div className="absolute inset-0 z-50 pointer-events-auto">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 bg-slate-900 border border-slate-700 rounded-lg shadow-xl p-4">
        <div className="text-lg font-bold text-white mb-2">{t('ui.transfer', { defaultValue: 'Transfer troops' })}</div>
        <div className="text-sm text-slate-300 mb-3">
          {fromFleet?.id} → {toFleet?.id}
        </div>
        <input
          type="number"
          className="w-full bg-slate-800 text-white px-3 py-2 rounded border border-slate-700"
          value={count}
          onChange={e => setCount(Number(e.target.value) || 0)}
          min={0}
        />
        <div className="mt-4 flex gap-2 justify-end">
          <button onClick={onCancel} className="px-3 py-2 rounded bg-slate-700 text-white">
            {t('ui.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button onClick={() => onConfirm(count)} className="px-3 py-2 rounded bg-blue-600 text-white">
            {t('ui.confirm', { defaultValue: 'Confirm' })}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TroopTransferModal;
