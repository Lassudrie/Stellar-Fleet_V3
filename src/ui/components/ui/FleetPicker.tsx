
import React, { useMemo } from 'react';
import { Fleet, StarSystem, FleetState, ShipType } from '../../../shared/types';
import { getFleetSpeed } from '../../../engine/movement/fleetSpeed';
import { useFleetName } from '../../context/FleetNames';
import { useI18n } from '../../i18n';
import { distSq } from '../../../engine/math/vec3';
import { CAPTURE_RANGE_SQ, MAX_HYPERJUMP_DISTANCE_LY } from '../../../content/data/static';
import { canFleetPayJump } from '../../../engine/logistics/fuel';
import { getOrbitingSystem } from '../../../engine/orbit';
import { sorted } from '../../../shared/sorting';

interface FleetPickerProps {
  mode: 'MOVE' | 'LOAD' | 'UNLOAD' | 'ATTACK';
  targetSystem: StarSystem;
  systems: StarSystem[];
  blueFleets: Fleet[];
  unlimitedFuel?: boolean;
  onSelectFleet: (fleetId: string) => void;
  onClose: () => void;
}

export type FleetEligibilityReason = 'captureRange' | 'outOfRange' | 'insufficientFuel' | 'missingTransport' | 'notOrbit';

export const getFleetEligibility = (
  fleet: Fleet,
  mode: FleetPickerProps['mode'],
  targetSystem: StarSystem,
  systems: StarSystem[],
  unlimitedFuel?: boolean
): { eligible: boolean; reason: FleetEligibilityReason | null; distanceLy: number; distanceSq: number } => {
  const sourceSystem = getOrbitingSystem(fleet, systems);
  const targetPosition = targetSystem.position;
  const distanceSq = sourceSystem ? distSq(sourceSystem.position, targetPosition) : distSq(fleet.position, targetPosition);
  const distanceLy = Math.sqrt(distanceSq);

  if (fleet.state !== FleetState.ORBIT) return { eligible: false, reason: 'notOrbit', distanceLy, distanceSq };

  if (mode === 'MOVE' || mode === 'ATTACK') {
      if (distanceLy > MAX_HYPERJUMP_DISTANCE_LY) return { eligible: false, reason: 'outOfRange', distanceLy, distanceSq };
      if (!canFleetPayJump(fleet, distanceLy, { unlimitedFuel })) return { eligible: false, reason: 'insufficientFuel', distanceLy, distanceSq };
      if (distanceSq <= CAPTURE_RANGE_SQ) return { eligible: false, reason: 'captureRange', distanceLy, distanceSq };
      return { eligible: true, reason: null, distanceLy, distanceSq };
  }

  const hasTransport = fleet.ships.some(ship => ship.type === ShipType.TRANSPORTER);
  if (!hasTransport) return { eligible: false, reason: 'missingTransport', distanceLy, distanceSq };
  if (distanceLy > MAX_HYPERJUMP_DISTANCE_LY) return { eligible: false, reason: 'outOfRange', distanceLy, distanceSq };
  if (!canFleetPayJump(fleet, distanceLy, { unlimitedFuel })) return { eligible: false, reason: 'insufficientFuel', distanceLy, distanceSq };

  return { eligible: true, reason: null, distanceLy, distanceSq };
};

export const isFleetEligibleForMode = (
  fleet: Fleet,
  mode: FleetPickerProps['mode'],
  targetSystem: StarSystem,
  systems: StarSystem[],
  unlimitedFuel?: boolean
): boolean => {
  return getFleetEligibility(fleet, mode, targetSystem, systems, unlimitedFuel).eligible;
};

const FleetPicker: React.FC<FleetPickerProps> = ({ mode, targetSystem, systems, blueFleets, unlimitedFuel, onSelectFleet, onClose }) => {
  const { t } = useI18n();
  const getFleetName = useFleetName();

  const fleetOptions = useMemo(() => {
      return sorted(
          blueFleets.map(fleet => {
              const eligibility = getFleetEligibility(fleet, mode, targetSystem, systems, unlimitedFuel);
              const { distanceLy, distanceSq } = eligibility;
              const speed = getFleetSpeed(fleet);
              const eta = Math.max(1, Math.ceil(distanceLy / speed));

              return { fleet, distanceSq, distanceLy, eligibility, eta };
          }),
          (a, b) => {
              if (a.eligibility.eligible !== b.eligibility.eligible) {
                  return a.eligibility.eligible ? -1 : 1;
              }
              return a.distanceSq - b.distanceSq;
          }
      );
  }, [blueFleets, mode, systems, targetSystem, unlimitedFuel]);

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
                {fleetOptions.length === 0 ? (
                    <div className="text-center p-8 text-slate-500">
                      {t(emptyKey)}
                    </div>
                ) : (
                    fleetOptions.map(({ fleet, distanceLy, eligibility, eta }) => {
                        const roundedDistance = Math.round(distanceLy);
                        const etaText = eta === 1 
                            ? t('picker.eta_one') 
                            : t('picker.eta_other', { count: eta });

                        const disabled = !eligibility.eligible;
                        const restrictionKey = eligibility.reason
                            ? `picker.restriction.${eligibility.reason}`
                            : null;

                        return (
                            <button
                              key={fleet.id}
                              onClick={() => !disabled && onSelectFleet(fleet.id)}
                              disabled={disabled}
                              className={`w-full border p-3 rounded-lg flex items-center justify-between group transition-all ${
                                  disabled
                                      ? 'bg-slate-800/30 border-slate-700/70 cursor-not-allowed opacity-70'
                                      : 'bg-slate-800/50 hover:bg-blue-900/30 border-slate-700 hover:border-blue-500/50'
                              }`}
                            >
                                <div className="text-left">
                                    <div className="text-white font-bold group-hover:text-blue-200">
                                        {getFleetName(fleet.id)}
                                    </div>
                                    <div className="text-xs text-slate-400 flex gap-2 mt-1">
                                        <span>{fleet.ships.length} Ships</span>
                                        <span className={`${fleet.state === FleetState.COMBAT ? 'text-red-400' : 'text-slate-500'}`}>
                                            • {t(`fleet.status.${fleet.state.toLowerCase()}`, { defaultValue: fleet.state })}
                                        </span>
                                    </div>
                                    {!eligibility.eligible && restrictionKey && (
                                        <div className="text-xs text-amber-300 mt-1">
                                            {t(restrictionKey)}
                                        </div>
                                    )}
                                </div>
                                <div className="text-right flex flex-col items-end">
                                    <div className="text-lg font-mono font-bold text-slate-500 group-hover:text-white leading-tight">
                                        {roundedDistance} <span className="text-xs">{t('picker.ly')}</span>
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
