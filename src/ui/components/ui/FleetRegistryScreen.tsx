import React from 'react';
import { Fleet, StarSystem } from '../../../shared/types';
import { useI18n } from '../../i18n';
import { FleetRegistryList } from './SideMenu';

interface FleetRegistryScreenProps {
  isOpen: boolean;
  blueFleets: Fleet[];
  systems: StarSystem[];
  day: number;
  onSelectFleet: (fleetId: string) => void;
  onInspectFleet: (fleetId: string) => void;
  onClose: () => void;
}

const FleetRegistryScreen: React.FC<FleetRegistryScreenProps> = ({
  isOpen,
  blueFleets,
  systems,
  day,
  onSelectFleet,
  onInspectFleet,
  onClose
}) => {
  const { t } = useI18n();

  if (!isOpen) return null;

  return (
    <div className="absolute inset-0 z-50 pointer-events-auto safe-area">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-full flex items-center justify-center p-6">
        <div className="w-full max-w-6xl h-[90vh] bg-slate-950/80 border border-slate-700/70 rounded-2xl shadow-2xl backdrop-blur-md flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/70">
            <div>
              <div className="text-xs text-slate-400 uppercase tracking-widest">
                {t('sidemenu.registry')}
              </div>
              <div className="text-lg font-bold text-white">
                {t('sidemenu.activeUnits', { count: blueFleets.length })}
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white transition-colors"
              aria-label={t('battle.close')}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-7 h-7">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 overflow-hidden flex">
            <FleetRegistryList
              blueFleets={blueFleets}
              systems={systems}
              day={day}
              onSelectFleet={onSelectFleet}
              onInspectFleet={onInspectFleet}
              onClose={onClose}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default FleetRegistryScreen;
