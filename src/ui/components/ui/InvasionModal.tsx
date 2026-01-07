
import React, { useEffect, useMemo, useState } from 'react';
import { Fleet, StarSystem, ShipType } from '../../../shared/shared';
import { useFleetName } from '../../context/FleetNames';
import { useI18n } from '../../i18n';
import { getFleetSpeed } from '../../../engine/movement';
import { dist, distSq } from '../../../engine/math/vec3';
import { ORBIT_PROXIMITY_RANGE_SQ } from '../../../content/data/static';
import { isOrbitContested } from '../../../engine/orbit';
import { sorted } from '../../../shared/shared';

interface InvasionModalProps {
  targetSystem: StarSystem;
  fleets: Fleet[]; // All fleets
  onConfirm: (fleetId: string, planetId: string | null) => void; // Changed: returns FleetID now
  onClose: () => void;
  playerFactionId: string;
  onOpenSurfaceView: (planetId: string) => void;
}

const InvasionModal: React.FC<InvasionModalProps> = ({ targetSystem, fleets, onConfirm, onClose, playerFactionId, onOpenSurfaceView }) => {
  const { t } = useI18n();
  const getFleetName = useFleetName();
  const solidPlanets = useMemo(() => targetSystem.planets.filter(planet => planet.isSolid), [targetSystem]);
  const [selectedPlanetId, setSelectedPlanetId] = useState<string | null>(solidPlanets[0]?.id ?? null);

  useEffect(() => {
    setSelectedPlanetId(solidPlanets[0]?.id ?? null);
  }, [solidPlanets, targetSystem.id]);

  // Filter fleets: Blue + Contains Loaded Troop Transport
  // Sort by: Distance to system
  const invasionCandidates = useMemo(() => {
    const targetPos = targetSystem.position;

    const candidates = fleets.filter(f => {
      if (f.factionId !== playerFactionId) return false;
      if (f.retreating) return false; // Retreating fleets can't accept orders

      // Check content: Must have at least one loaded transport
      return f.ships.some(s => s.type === ShipType.TRANSPORTER && s.carriedArmyId);
    });

    // Sort by Distance
    return sorted(
        candidates,
        (a, b) => dist(a.position, targetPos) - dist(b.position, targetPos)
    );
  }, [fleets, targetSystem, playerFactionId]);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[2px] pointer-events-auto z-50 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-red-500/50 w-11/12 max-w-lg max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden">
        
        {/* HEADER */}
        <div className="bg-red-950/30 p-4 border-b border-red-900/50 flex justify-between items-center">
          <div>
            <h3 className="text-red-400 font-bold text-lg tracking-wider uppercase flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M8.25 6.75a3.75 3.75 0 117.5 0 3.75 3.75 0 01-7.5 0zM15.75 9.75a3 3 0 116 0 3 3 0 01-6 0zM2.25 9.75a3 3 0 116 0 3 3 0 01-6 0zM6.31 15.117A6.745 6.745 0 0112 12a6.745 6.745 0 016.709 7.498.75.75 0 01-.372.568A12.696 12.696 0 0112 21.75c-2.305 0-4.47-.612-6.337-1.684a.75.75 0 01-.372-.568 6.787 6.787 0 011.019-4.38z" clipRule="evenodd" />
              </svg>
              {t('invasion.title')}
            </h3>
            <p className="text-xs text-red-200/60 font-mono">{t('invasion.target', { system: targetSystem.name.toUpperCase() })}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">✕</button>
        </div>

        {/* CONTENT */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-slate-900/50">
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-300 font-semibold">{t('invasion.selectPlanet')}</label>
            <select
              value={selectedPlanetId ?? ''}
              onChange={e => setSelectedPlanetId(e.target.value || null)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100"
            >
              {solidPlanets.map(planet => (
                <option key={planet.id} value={planet.id}>
                  {planet.name}
                </option>
              ))}
              {solidPlanets.length === 0 && <option value="">{t('invasion.noSolidPlanets')}</option>}
            </select>
            <button
              disabled={!selectedPlanetId}
              onClick={() => selectedPlanetId && onOpenSurfaceView(selectedPlanetId)}
              className="text-[10px] uppercase rounded border border-slate-600 px-2 py-1 text-slate-200 hover:border-indigo-400 hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('invasion.viewSurface')}
            </button>
          </div>
          {invasionCandidates.length === 0 ? (
            <div className="text-center py-8 text-slate-500 italic text-sm border border-dashed border-slate-700 rounded">
              {t('invasion.noFleets')}
            </div>
          ) : (
            invasionCandidates.map(fleet => {
              const transports = fleet.ships.filter(s => s.type === ShipType.TRANSPORTER && s.carriedArmyId);
              
              // Distance Calc
              const fleetPos = fleet.position;
              const targetPos = targetSystem.position;
              const distanceSq = distSq(fleetPos, targetPos);
              const isHere = distanceSq <= ORBIT_PROXIMITY_RANGE_SQ;
              const d = Math.sqrt(distanceSq);
              
              // ETA Calc
              const speed = getFleetSpeed(fleet);
              const eta = isHere ? 0 : Math.ceil(d / speed);
              const etaText = eta === 0 ? 'ORBIT' : `${eta} T`;

              return (
                <button 
                    key={fleet.id} 
                    onClick={() => onConfirm(fleet.id, selectedPlanetId)}
                    className="w-full bg-slate-800/40 hover:bg-red-900/20 border border-slate-700/50 hover:border-red-500/50 rounded-lg overflow-hidden transition-all group text-left disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={!selectedPlanetId}
                >
                  <div className="px-3 py-2 flex justify-between items-center">
                    <div>
                        <div className="text-blue-300 font-bold text-sm group-hover:text-red-300 transition-colors">{getFleetName(fleet.id)}</div>
                        <div className="text-[10px] text-slate-500 uppercase flex gap-2">
                            <span>{t('fleet.status.' + fleet.state.toLowerCase(), {defaultValue: fleet.state})}</span>
                            {isHere && <span className="text-emerald-500 font-bold">IN RANGE</span>}
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-lg font-mono font-bold text-slate-400 group-hover:text-white leading-tight">
                            {etaText}
                        </div>
                        <div className="text-[10px] text-slate-600 font-mono">{Math.round(d)} LY</div>
                    </div>
                  </div>
                  
                  <div className="px-3 pb-2 flex gap-1 flex-wrap">
                    {transports.map((ship, i) => (
                        <div key={i} className="flex items-center gap-1 bg-black/40 px-1.5 py-0.5 rounded border border-slate-700/50">
                             <div className="w-1.5 h-1.5 bg-red-500 rounded-full"></div>
                             <span className="text-[9px] font-mono text-slate-400">ARMY</span>
                        </div>
                    ))}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* FOOTER */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 text-center">
            <button 
                onClick={onClose}
                className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white uppercase transition-colors"
            >
                {t('invasion.cancel')}
            </button>
        </div>
      </div>
    </div>
  );
};

export default InvasionModal;

interface InvasionDecisionModalProps {
  system: StarSystem;
  fleet: Fleet | null;
  fleets: Fleet[];
  suggestedPlanetId: string | null;
  onSiege: () => void;
  onAttack: (planetId: string) => void;
  onClose: () => void;
}

export const InvasionDecisionModal: React.FC<InvasionDecisionModalProps> = ({
  system,
  fleet,
  fleets,
  suggestedPlanetId,
  onSiege,
  onAttack,
  onClose
}) => {
  const { t } = useI18n();
  const getFleetName = useFleetName();

  const solidPlanets = useMemo(() => {
    return sorted(
      system.planets.filter(planet => planet.isSolid),
      (a, b) => a.id.localeCompare(b.id)
    );
  }, [system.planets]);

  const [selectedPlanetId, setSelectedPlanetId] = useState<string | null>(null);

  useEffect(() => {
    const preferred = suggestedPlanetId && solidPlanets.some(p => p.id === suggestedPlanetId) ? suggestedPlanetId : null;
    setSelectedPlanetId(preferred ?? solidPlanets[0]?.id ?? null);
  }, [suggestedPlanetId, solidPlanets, system.id]);

  const contested = useMemo(() => isOrbitContested(system, fleets), [system, fleets]);

  const loadedTransports = useMemo(() => {
    if (!fleet) return [];
    return fleet.ships.filter(ship => ship.type === ShipType.TRANSPORTER && ship.carriedArmyId);
  }, [fleet]);

  const canAttack = Boolean(fleet && selectedPlanetId && loadedTransports.length > 0);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[2px] pointer-events-auto z-50 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-red-500/50 w-11/12 max-w-lg max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden">
        <div className="bg-red-950/30 p-4 border-b border-red-900/50 flex justify-between items-center">
          <div>
            <h3 className="text-red-300 font-bold text-lg tracking-wider uppercase">
              {t('invasionDecision.title')}
            </h3>
            <p className="text-xs text-red-200/60 font-mono">{t('invasionDecision.system', { system: system.name.toUpperCase() })}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-slate-900/50">
          <div className="text-xs text-slate-300">
            {t('invasionDecision.fleet', { fleet: fleet ? getFleetName(fleet.id) : '—' })}
          </div>

          {contested && (
            <div className="text-xs text-amber-200 bg-amber-900/20 border border-amber-500/30 rounded p-2">
              {t('invasionDecision.contested')}
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-300 font-semibold">{t('invasionDecision.selectPlanet')}</label>
            <select
              value={selectedPlanetId ?? ''}
              onChange={e => setSelectedPlanetId(e.target.value || null)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-100"
              disabled={solidPlanets.length === 0}
            >
              {solidPlanets.map(planet => (
                <option key={planet.id} value={planet.id}>
                  {planet.name}
                </option>
              ))}
              {solidPlanets.length === 0 && <option value="">{t('invasionDecision.noSolidPlanets')}</option>}
            </select>
          </div>

          {fleet && loadedTransports.length === 0 && (
            <div className="text-xs text-slate-400">{t('invasionDecision.noEmbarkedArmies')}</div>
          )}
        </div>

        <div className="p-4 bg-slate-950 border-t border-slate-800 flex items-center justify-between gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white uppercase transition-colors"
          >
            {t('invasionDecision.later')}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onSiege}
              className="px-4 py-2 text-xs font-bold uppercase rounded border border-slate-700 text-slate-200 hover:border-red-400 hover:text-white transition-colors"
            >
              {t('invasionDecision.siege')}
            </button>
            <button
              onClick={() => selectedPlanetId && onAttack(selectedPlanetId)}
              disabled={!canAttack}
              className="px-4 py-2 text-xs font-bold uppercase rounded bg-red-600/70 hover:bg-red-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('invasionDecision.attack')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
