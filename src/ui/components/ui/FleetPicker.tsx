
import React, { useMemo } from 'react';
import { Fleet, StarSystem, FleetState, ShipType } from '../../../shared/types';
import { getFleetSpeed } from '../../../engine/movement/fleetSpeed';
import { fleetLabel } from '../../../engine/idUtils';
import { useI18n } from '../../i18n';
import { distSq } from '../../../engine/math/vec3';
import { CAPTURE_RANGE_SQ, MAX_HYPERJUMP_DISTANCE_LY } from '../../../content/data/static';
import { canFleetPayJump } from '../../../engine/logistics/fuel';

export const isFleetEligibleForMode = (
  fleet: Fleet,
  mode: FleetPickerProps['mode'],
  targetPosition: StarSystem['position']
): boolean => {
  const distanceSq = distSq(fleet.position, targetPosition);
  const distanceLy = Math.sqrt(distanceSq);

  if (mode === 'MOVE' || mode === 'ATTACK') {
      if (distanceLy > MAX_HYPERJUMP_DISTANCE_LY) return false;
      if (!canFleetPayJump(fleet, distanceLy)) return false;
      return distanceSq > CAPTURE_RANGE_SQ;
  }

  const hasTransport = fleet.ships.some(ship => ship.type === ShipType.TROOP_TRANSPORT);
  return hasTransport;
};

interface FleetPickerProps {
  mode: 'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK';
  targetSystem: StarSystem;
  blueFleets: Fleet[];
  onSelectFleet: (fleetId: string) => void;
  onClose: () => void;
}

const FleetPicker: React.FC<FleetPickerProps> = ({ mode, targetSystem, blueFleets, onSelectFleet, onClose }) => {
  const { t } = useI18n();

  // Sort fleets by distance to target system and filter based on mode
  const sortedFleets = useMemo(() => {
      const targetPos = targetSystem.position;

      const availableFleets = blueFleets.filter(fleet => {
          return isFleetEligibleForMode(fleet, mode, targetPos);
      });

      return availableFleets.sort((a, b) => {
          const distASq = distSq(a.position, targetPos);
          const distBSq = distSq(b.position, targetPos);
          return distASq - distBSq;
      });
  }, [blueFleets, mode, targetSystem]);

  const titleKey = mode === 'LOAD'
      ? 'picker.titleLoad'
      : mode === 'UNLOAD'
          ? 'picker.titleUnload'
          : mode === 'ATTACK'
              ? 'picker.titleAttack'
              : 'picker.title';

  const destinationKey = mode === 'LOAD'
      ? 'picker.destinationLoad'
      : mode === 'UNLOAD'
          ? 'picker.destinationUnload'
          : mode === 'ATTACK'
              ? 'picker.destinationAttack'
              : 'picker.destination';

  const emptyKey = mode === 'MOVE' || mode === 'ATTACK'
      ? 'picker.noFleets'
      : 'picker.noTransportFleets';

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] pointer-events-auto z-50">
        <div className="bg-slate-900 border border-blue-500/50 w-11/12 max-w-md max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden">
            <div className="bg-slate-950 p-4 border-b border-slate-800 flex justify-between items-center">
                <div>
                  <h3 className="text-blue-400 font-bold text-lg tracking-wider uppercase">{t(titleKey)}</h3>
                  <p className="text-xs text-slate-500">{t(destinationKey, { system: targetSystem.name })}</p>
                </div>
                <button onClick={onClose} className="text-slate-500 hover:text-white">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
                {sortedFleets.length === 0 ? (
                    <div className="text-center p-8 text-slate-500">
                      {t(emptyKey)}
                    </div>
                ) : (
                    sortedFleets.map(fleet => {
                        const fleetPos = fleet.position;
                        const targetPos = targetSystem.position;
                        const rawDistSq = distSq(fleetPos, targetPos);
                        const rawDist = Math.sqrt(rawDistSq);

                        const d = Math.round(rawDist);

                        // Calculate dynamic speed based on composition
                        const speed = getFleetSpeed(fleet);
                        const eta = Math.max(1, Math.ceil(rawDist / speed));
                        
                        // Localization for ETA
                        const etaText = eta === 1 
                            ? t('picker.eta_one') 
                            : t('picker.eta_other', { count: eta });

                        return (
                            <button
                              key={fleet.id}
                              onClick={() => onSelectFleet(fleet.id)}
                              className="w-full bg-slate-800/50 hover:bg-blue-900/30 border border-slate-700 hover:border-blue-500/50 p-3 rounded-lg flex items-center justify-between group transition-all"
                            >
                                <div className="text-left">
                                    <div className="text-white font-bold group-hover:text-blue-200">
                                        {fleetLabel(fleet.id)}
                                    </div>
                                    <div className="text-xs text-slate-400 flex gap-2 mt-1">
                                        <span>{fleet.ships.length} Ships</span>
                                        <span className={`${fleet.state === FleetState.COMBAT ? 'text-red-400' : 'text-slate-500'}`}>
                                            • {t(`fleet.status.${fleet.state.toLowerCase()}`, { defaultValue: fleet.state })}
                                        </span>
                                    </div>
                                </div>
                                <div className="text-right flex flex-col items-end">
                                    <div className="text-lg font-mono font-bold text-slate-500 group-hover:text-white leading-tight">
                                        {d} <span className="text-xs">{t('picker.ly')}</span>
                                    </div>
                                    <div className="text-xs font-mono font-bold text-blue-500/70 group-hover:text-blue-300">
                                        {etaText}
                                    </div>
                                </div>
                            </button>
                        )
                    })
                )}
            </div>
        </div>
    </div>
  );
};

export default FleetPicker;
