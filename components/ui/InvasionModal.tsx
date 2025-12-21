
import React, { useMemo } from 'react';
import { Fleet, StarSystem, ShipType } from '../../types';
import { fleetLabel, shortId } from '../../engine/idUtils';
import { useI18n } from '../../i18n';
import { getFleetSpeed } from '../../services/movement/fleetSpeed';
import { dist, distSq } from '../../engine/math/vec3';
import { ORBIT_PROXIMITY_RANGE_SQ } from '../../data/static';

interface InvasionModalProps {
  targetSystem: StarSystem;
  fleets: Fleet[]; // All fleets
  onConfirm: (fleetId: string) => void; // Changed: returns FleetID now
  onClose: () => void;
  playerFactionId: string;
}

const InvasionModal: React.FC<InvasionModalProps> = ({ targetSystem, fleets, onConfirm, onClose, playerFactionId }) => {
  const { t } = useI18n();

  // Filter fleets: Blue + Contains Loaded Troop Transport
  // Sort by: Distance to system
  const invasionCandidates = useMemo(() => {
    const targetPos = targetSystem.position;

    const candidates = fleets.filter(f => {
      if (f.factionId !== playerFactionId) return false;
      if (f.retreating) return false; // Retreating fleets can't accept orders

      // Check content: Must have at least one loaded transport
      return f.ships.some(s => s.type === ShipType.TROOP_TRANSPORT && s.carriedArmyId);
    });

    // Sort by Distance
    return candidates.sort((a, b) => {
        const distA = dist(a.position, targetPos);
        const distB = dist(b.position, targetPos);
        return distA - distB;
    });
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
          {invasionCandidates.length === 0 ? (
            <div className="text-center py-8 text-slate-500 italic text-sm border border-dashed border-slate-700 rounded">
              {t('invasion.noFleets')}
            </div>
          ) : (
            invasionCandidates.map(fleet => {
              const transports = fleet.ships.filter(s => s.type === ShipType.TROOP_TRANSPORT && s.carriedArmyId);
              
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
                    onClick={() => onConfirm(fleet.id)}
                    className="w-full bg-slate-800/40 hover:bg-red-900/20 border border-slate-700/50 hover:border-red-500/50 rounded-lg overflow-hidden transition-all group text-left"
                >
                  <div className="px-3 py-2 flex justify-between items-center">
                    <div>
                        <div className="text-blue-300 font-bold text-sm group-hover:text-red-300 transition-colors">{fleetLabel(fleet.id)}</div>
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
