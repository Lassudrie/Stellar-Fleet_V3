import React, { useMemo } from 'react';
import { Fleet, StarSystem } from '../../../shared/types';
import { useFleetName } from '../../context/FleetNames';
import { useI18n } from '../../i18n';
import { calculateFleetPower } from '../../../engine/world';

const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

interface OrbitingFleetPickerProps {
  system: StarSystem;
  fleets: Fleet[];
  onSelect: (fleetId: string) => void;
  onClose: () => void;
}

const OrbitingFleetPicker: React.FC<OrbitingFleetPickerProps> = ({ system, fleets, onSelect, onClose }) => {
  const { t } = useI18n();
  const getFleetName = useFleetName();

  const powerByFleetId = useMemo(() => {
      const cache = new Map<string, number>();
      fleets.forEach(fleet => {
          cache.set(fleet.id, calculateFleetPower(fleet));
      });
      return cache;
  }, [fleets]);

  const sortedFleets = useMemo(() => {
      return [...fleets].sort((a, b) => {
          const sizeDiff = b.ships.length - a.ships.length;
          if (sizeDiff !== 0) return sizeDiff;
          const powerDiff = (powerByFleetId.get(b.id) ?? 0) - (powerByFleetId.get(a.id) ?? 0);
          if (powerDiff !== 0) return powerDiff;
          return compareIds(a.id, b.id);
      });
  }, [fleets, powerByFleetId]);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur pointer-events-auto z-50">
        <div className="bg-slate-900 border border-blue-500/50 w-11/12 max-w-lg max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden">
            <div className="bg-slate-950 p-4 border-b border-slate-800 flex justify-between items-center">
                <div>
                    <h3 className="text-blue-400 font-bold text-lg tracking-wider uppercase">{t('orbitPicker.title')}</h3>
                    <p className="text-xs text-slate-500">{t('orbitPicker.subtitle', { system: system.name })}</p>
                </div>
                <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
                {sortedFleets.length === 0 ? (
                    <div className="text-center p-8 text-slate-500">
                        {t('orbitPicker.noFleets')}
                    </div>
                ) : (
                    sortedFleets.map(fleet => (
                        <button
                            key={fleet.id}
                            onClick={() => onSelect(fleet.id)}
                            className="w-full bg-slate-800/50 hover:bg-blue-900/30 border border-slate-700 hover:border-blue-500/50 p-3 rounded-lg flex items-center justify-between group transition-all"
                        >
                            <div className="text-left">
                                <div className="text-white font-bold group-hover:text-blue-200">
                                    {getFleetName(fleet.id)}
                                </div>
                                <div className="text-xs text-slate-400 flex gap-3 mt-1">
                                    <span>{t('orbitPicker.shipCount', { count: fleet.ships.length })}</span>
                                    <span className="text-blue-300">
                                        {t('orbitPicker.power', { power: (powerByFleetId.get(fleet.id) ?? 0).toLocaleString() })}
                                    </span>
                                </div>
                            </div>
                        </button>
                    ))
                )}
            </div>
        </div>
    </div>
  );
};

export default OrbitingFleetPicker;
