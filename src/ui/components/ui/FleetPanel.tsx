
import React, { useState, useMemo, useEffect } from 'react';
import { Fleet, ShipEntity, ShipType, FactionId, Army, StarSystem } from '../../../shared/types';
import { shortId, fleetLabel } from '../../../engine/idUtils';
import { useI18n } from '../../i18n';
import { computeFleetFuelSummary } from '../../utils/fleetFuel';

const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

export interface AvailableArmy {
  army: Army;
  planetId: string;
  planetName: string;
}

interface FleetPanelProps {
  fleet: Fleet;
  otherFleetsInSystem: Fleet[];
  // Ground Context
  currentSystem: StarSystem | null;
  availableArmies: AvailableArmy[];
  // Actions
  onSplit: (shipIds: string[]) => void;
  onMerge: (targetFleetId: string) => void;
  onDeploy: (shipId: string, planetId: string) => void;
  onEmbark: (shipId: string, armyId: string) => void;
  playerFactionId: string;
}

// Minimalist Ship Icons
const ShipIcon: React.FC<{ type: string; className?: string }> = ({ type, className }) => {
  const props = { className, fill: "currentColor", viewBox: "0 0 24 24", xmlns: "http://www.w3.org/2000/svg" };

  switch (type as ShipType) {
    case ShipType.CARRIER:
      return (
        <svg {...props}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
        </svg>
      );
    case ShipType.CRUISER:
      return (
        <svg {...props}>
          <path d="M12 2L2 9v13h20V9L12 2z" />
        </svg>
      );
    case ShipType.DESTROYER:
      return (
        <svg {...props}>
           <path d="M12 2L2 22h20L12 2z" />
        </svg>
      );
    case ShipType.FRIGATE:
      return (
        <svg {...props}>
           <path d="M12 2l10 10-10 10L2 12z" />
        </svg>
      );
    case ShipType.BOMBER:
      return (
        <svg {...props} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
           <path d="M12 3v18M3 12h18" />
        </svg>
      );
    case ShipType.FIGHTER:
      return (
        <svg {...props}>
           <circle cx="12" cy="12" r="8" />
        </svg>
      );
    case ShipType.TROOP_TRANSPORT:
      return (
        <svg {...props}>
           <path d="M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z" />
        </svg>
      );
    case ShipType.TANKER:
      return (
        <svg {...props}>
          <path d="M4 6h16v12H4z" />
          <path d="M7 9h10v6H7z" fill="currentColor" />
        </svg>
      );
    case ShipType.EXTRACTOR:
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="6" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      );
    default:
      return <div className={className} />;
  }
};

const FleetPanel: React.FC<FleetPanelProps> = ({ 
    fleet, otherFleetsInSystem, currentSystem, availableArmies,
    onSplit, onMerge, onDeploy, onEmbark, playerFactionId 
}) => {
  const { t } = useI18n();
  const [selectedShipIds, setSelectedShipIds] = useState<Set<string>>(new Set());

  const fuelSummary = useMemo(() => computeFleetFuelSummary(fleet), [fleet]);

  const solidPlanets = useMemo(() => {
    if (!currentSystem) return [];
    return currentSystem.planets
      .filter(planet => planet.isSolid)
      .sort((a, b) => compareIds(a.id, b.id));
  }, [currentSystem]);

  // Reset selection when fleet changes
  useEffect(() => {
    setSelectedShipIds(new Set());
  }, [fleet.id]);

  // Group ships by type for clean display
  const shipGroups = useMemo(() => {
    const groups: Record<string, ShipEntity[]> = {};
    if (!fleet.ships) return groups;
    
    fleet.ships.forEach(s => {
      if (!s || !s.type) return; 
      if (!groups[s.type]) groups[s.type] = [];
      groups[s.type].push(s);
    });
    return groups;
  }, [fleet]);

  const toggleShipSelect = (id: string) => {
    if (fleet.factionId !== playerFactionId) return; // Prevent selection on enemy fleets
    const next = new Set(selectedShipIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedShipIds(next);
  };

  const handleDetach = () => {
    if (fleet.factionId !== playerFactionId) return;
    onSplit(Array.from(selectedShipIds));
    setSelectedShipIds(new Set());
  };

  // Sort order: Capital first, but put transports high if they have actions
  const sortOrder = [
    ShipType.TROOP_TRANSPORT,
    ShipType.TANKER,
    ShipType.EXTRACTOR,
    ShipType.CARRIER, 
    ShipType.CRUISER, 
    ShipType.DESTROYER, 
    ShipType.FRIGATE, 
    ShipType.BOMBER, 
    ShipType.FIGHTER
  ];

  const isPlayer = fleet.factionId === playerFactionId;
  const factionColor = isPlayer ? 'text-blue-500' : 'text-red-500';
  const factionTitle = isPlayer ? 'text-blue-400' : 'text-red-400';

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-slate-900/95 border-t border-slate-700 p-4 pointer-events-auto transition-transform duration-300 max-h-[40vh] flex flex-col animate-in slide-in-from-bottom duration-300 shadow-2xl z-30">
      
      {/* HEADER */}
      <div className="flex justify-between items-center mb-3">
        <div>
            <h2 className={`${factionTitle} font-bold text-lg flex items-center gap-2`}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={`w-5 h-5 ${factionColor}`}>
                  <path fillRule="evenodd" d="M14.615 1.595a.75.75 0 01.359.852L12.981 9.75h5.527a.75.75 0 01.625 1.072l-12 14a.75.75 0 01-1.196-.86l4.634-11.492h-5.91a.75.75 0 01-.662-1.006l6.635-9.28a.75.75 0 01.98-.189z" clipRule="evenodd" />
                </svg>
                {isPlayer ? fleetLabel(fleet.id) : `ENEMY CONTACT ${shortId(fleet.id)}`}
            </h2>
            <div className="text-xs text-slate-400 ml-7 flex gap-2">
                <span>Ships: {fleet.ships.length}</span>
                <span>•</span>
                <span>Status: <span className="text-white">{t(`fleet.status.${fleet.state.toLowerCase()}`, { defaultValue: fleet.state })}</span></span>
                {currentSystem && (
                    <>
                        <span>•</span>
                        <span className="text-emerald-400">{t('fleet.orbiting', { system: currentSystem.name })}</span>
                    </>
                )}
            </div>
            <div className="text-[11px] text-slate-400 ml-7 flex gap-2">
                <span>He-3: <span className="text-white font-mono">{Math.round(fuelSummary.totalFuel)}/{Math.round(fuelSummary.totalCapacity)}</span></span>
                <span>•</span>
                <span>Range: <span className="text-white font-mono">{fuelSummary.cappedCurrentReach.toFixed(1)} ly</span></span>
                <span className="text-slate-600">/</span>
                <span className="text-slate-300">{fuelSummary.cappedFullReach.toFixed(1)} ly</span>
            </div>
        </div>
        
        {isPlayer ? (
            <button 
                disabled={selectedShipIds.size === 0 || selectedShipIds.size === fleet.ships.length}
                onClick={handleDetach}
                className={`px-4 py-2 rounded text-xs font-bold transition-all uppercase tracking-wider border ${
                    selectedShipIds.size > 0 && selectedShipIds.size < fleet.ships.length
                    ? 'bg-blue-600 text-white border-blue-500 hover:bg-blue-500 shadow-[0_0_10px_rgba(37,99,235,0.5)]' 
                    : 'bg-slate-800 text-slate-500 border-slate-700 cursor-not-allowed'
                }`}
            >
                {t('fleet.split', { count: selectedShipIds.size })}
            </button>
        ) : (
             <div className="px-3 py-1.5 rounded bg-red-900/30 border border-red-800 text-red-400 text-[10px] font-mono tracking-widest animate-pulse uppercase">
                 {t('fleet.hostile')}
             </div>
        )}
      </div>

      {/* MERGE OPTIONS */}
      {isPlayer && otherFleetsInSystem.length > 0 && (
          <div className="mb-2 p-2 bg-blue-900/10 border border-blue-500/20 rounded">
              <div className="text-[10px] text-blue-300 uppercase font-bold mb-1 flex items-center gap-1">
                 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                   <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                 </svg>
                 {t('fleet.mergeOp')}
              </div>
              <div className="flex flex-wrap gap-2">
                  {otherFleetsInSystem.map(other => (
                      <button
                          key={other.id}
                          onClick={() => onMerge(other.id)}
                          className="px-2 py-1 bg-blue-800/60 hover:bg-blue-600 text-white text-[10px] rounded border border-blue-500/40 flex items-center gap-1 transition-colors"
                      >
                          <span>{t('fleet.mergeWith', { fleet: fleetLabel(other.id) })}</span>
                          <span className="opacity-50">({other.ships.length})</span>
                      </button>
                  ))}
              </div>
          </div>
      )}

      {/* SHIP LIST */}
      <div className="flex-1 overflow-y-auto grid grid-cols-2 gap-3 pb-4 custom-scrollbar pr-1">
        {sortOrder.map(type => {
            const ships = shipGroups[type];
            if (!ships) return null;

            return (
                <div key={type} className="bg-slate-800/40 p-2 rounded border border-slate-700/50">
                    <div className="text-xs uppercase font-bold text-slate-300 mb-2 border-b border-slate-700 pb-1 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <ShipIcon type={type} className={`w-3 h-3 ${isPlayer ? 'text-blue-400' : 'text-red-400'}`} />
                            <span>{type}</span>
                        </div>
                        <span className="text-slate-500 text-[10px]">x{ships.length}</span>
                    </div>
                    <div className="space-y-1">
                        {ships.map(ship => {
                            const isSelected = selectedShipIds.has(ship.id);
                            const percent = (ship.hp / ship.maxHp) * 100;
                            const hpColor = percent > 60 ? 'bg-green-500' : percent > 30 ? 'bg-yellow-500' : 'bg-red-500';
                            
                            // Army Logic for Transports
                            const hasArmy = !!ship.carriedArmyId;
                            const isTransport = ship.type === ShipType.TROOP_TRANSPORT;
                            const canDeploy = isPlayer && isTransport && hasArmy && solidPlanets.length > 0;
                            const canEmbark = isPlayer && isTransport && !hasArmy && currentSystem && availableArmies.length > 0;
                            const carriedArmyLabel = ship.carriedArmyId ? shortId(ship.carriedArmyId) : '?';
                            const deployDisabled = !ship.carriedArmyId;

                            return (
                                <div 
                                    key={ship.id}
                                    onClick={() => toggleShipSelect(ship.id)}
                                    className={`cursor-pointer px-2 py-1.5 rounded flex flex-col gap-2 transition-colors ${
                                        isSelected ? 'bg-blue-600/30 border border-blue-500/50' : 'bg-slate-900/40 border border-transparent'
                                    } ${isPlayer ? 'hover:bg-white/5' : 'cursor-default'}`}
                                >
                                    {/* ROW TOP: Status & Selection */}
                                    <div className="flex items-center justify-between w-full">
                                        <div className="flex items-center gap-2 w-full">
                                            <div className="w-1 h-3 bg-slate-700 rounded-full overflow-hidden shrink-0">
                                                <div className={`w-full ${hpColor} rounded-full transition-all duration-300`} style={{ height: `${percent}%`, marginTop: `${100-percent}%` }} />
                                            </div>
                                            <div className="flex items-center gap-1 w-full overflow-hidden">
                                                <span className={`truncate font-mono text-[10px] ${isSelected ? 'text-blue-100' : 'text-slate-400'}`}>
                                                    {shortId(ship.id)}
                                                </span>
                                                {hasArmy && (
                                                    <span title="Army Loaded" className="text-[8px] bg-green-900 text-green-300 px-1 rounded font-bold">ARM</span>
                                                )}
                                            </div>
                                        </div>
                                        
                                        {isSelected && isPlayer && (
                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shadow-[0_0_5px_rgba(96,165,250,0.8)] ml-2 shrink-0"></div>
                                        )}
                                    </div>

                                    {/* ROW BOTTOM: Actions (Transport Only) */}
                                    {isTransport && isPlayer && (canDeploy || canEmbark) && (
                                        <div className="flex justify-end pt-1 border-t border-white/5" onClick={e => e.stopPropagation()}>
                                            {canDeploy && solidPlanets.length <= 1 && (
                                                <button
                                                    onClick={() => onDeploy(ship.id, solidPlanets[0].id)}
                                                    className="w-full bg-green-600/80 hover:bg-green-500 text-white text-[9px] py-1 rounded font-bold uppercase tracking-wider"
                                                    disabled={deployDisabled}
                                                >
                                                    {t('fleet.deploy', { army: carriedArmyLabel })}
                                                </button>
                                            )}
                                            {canDeploy && solidPlanets.length > 1 && (
                                                <select
                                                    className="w-full bg-slate-800 border border-slate-600 text-slate-300 text-[9px] py-1 rounded focus:outline-none focus:border-blue-500"
                                                    onChange={(e) => {
                                                        if (e.target.value) {
                                                            onDeploy(ship.id, e.target.value);
                                                            e.target.value = "";
                                                        }
                                                    }}
                                                    defaultValue=""
                                                >
                                                    <option value="" disabled>{t('fleet.deployTo')}</option>
                                                    {solidPlanets.map(planet => (
                                                        <option key={planet.id} value={planet.id}>
                                                            {planet.name} ({carriedArmyLabel})
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                            {canEmbark && (
                                                <select
                                                    className="w-full bg-slate-800 border border-slate-600 text-slate-300 text-[9px] py-1 rounded focus:outline-none focus:border-blue-500"
                                                    onChange={(e) => {
                                                        if (e.target.value) {
                                                            onEmbark(ship.id, e.target.value);
                                                            e.target.value = ""; // Reset
                                                        }
                                                    }}
                                                    defaultValue=""
                                                >
                                                    <option value="" disabled>{t('fleet.load')}</option>
                                                    {availableArmies.map(({ army, planetName }) => (
                                                        <option key={army.id} value={army.id}>
                                                            {shortId(army.id)} ({planetName}) ({army.strength})
                                                        </option>
                                                    ))}
                                                </select>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            );
        })}
      </div>
    </div>
  );
};

export default FleetPanel;
