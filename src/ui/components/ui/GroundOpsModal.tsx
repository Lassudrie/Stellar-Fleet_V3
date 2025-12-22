import React, { useMemo } from 'react';
import { Army, ArmyState, FactionId, FactionState, Fleet, FleetState, ShipType, StarSystem } from '../../../shared/types';
import { useI18n } from '../../i18n';
import { ORBIT_PROXIMITY_RANGE_SQ } from '../../../content/data/static';
import { distSq } from '../../../engine/math/vec3';
import { shortId } from '../../../engine/idUtils';
import { getBombardedPlanetIdsForSystem } from '../../../engine/orbitalBombardment';

const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

interface GroundOpsModalProps {
  system: StarSystem;
  armies: Army[];
  fleets: Fleet[];
  factions: FactionState[];
  playerFactionId: FactionId;
  day: number;
  onTransfer: (armyId: string, fromPlanetId: string, toPlanetId: string) => void;
  onClose: () => void;
}

const GroundOpsModal: React.FC<GroundOpsModalProps> = ({
  system,
  armies,
  fleets,
  factions,
  playerFactionId,
  day,
  onTransfer,
  onClose
}) => {
  const { t } = useI18n();

  const factionLookup = useMemo(() => {
    return factions.reduce<Record<FactionId, FactionState>>((acc, faction) => {
      acc[faction.id] = faction;
      return acc;
    }, {});
  }, [factions]);

  const solidPlanets = useMemo(() => {
    return system.planets
      .filter(planet => planet.isSolid)
      .sort((a, b) => compareIds(a.id, b.id));
  }, [system.planets]);

  const bombardedPlanetIds = useMemo(() => {
    return getBombardedPlanetIdsForSystem(system, armies, fleets);
  }, [system, armies, fleets]);

  const planetIdSet = useMemo(() => new Set(solidPlanets.map(planet => planet.id)), [solidPlanets]);

  const armiesByPlanetId = useMemo(() => {
    const map = new Map<string, Army[]>();
    armies.forEach(army => {
      if (army.state !== ArmyState.DEPLOYED) return;
      if (!planetIdSet.has(army.containerId)) return;
      const list = map.get(army.containerId) ?? [];
      list.push(army);
      map.set(army.containerId, list);
    });
    return map;
  }, [armies, planetIdSet]);

  const availableTransportCount = useMemo(() => {
    return fleets
      .filter(fleet =>
        fleet.factionId === playerFactionId &&
        fleet.state === FleetState.ORBIT &&
        distSq(fleet.position, system.position) <= ORBIT_PROXIMITY_RANGE_SQ
      )
      .reduce((count, fleet) => {
        const eligible = fleet.ships.filter(ship => {
          if (ship.type !== ShipType.TROOP_TRANSPORT) return false;
          if (ship.carriedArmyId) return false;
          return (ship.transferBusyUntilDay ?? -Infinity) < day;
        });
        return count + eligible.length;
      }, 0);
  }, [fleets, playerFactionId, system.position, day]);

  const canTransfer = availableTransportCount > 0 && solidPlanets.length > 1;

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[2px] pointer-events-auto z-50 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-indigo-500/40 w-11/12 max-w-3xl max-h-[85vh] flex flex-col rounded-xl shadow-2xl overflow-hidden">
        <div className="bg-slate-950 p-4 border-b border-slate-800 flex justify-between items-center">
          <div>
            <h3 className="text-indigo-300 font-bold text-lg tracking-wider uppercase flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M12 3.75a.75.75 0 01.75.75v2.5a.75.75 0 01-1.5 0v-2.5a.75.75 0 01.75-.75z" />
                <path d="M12 16.5a.75.75 0 01.75.75v2.5a.75.75 0 01-1.5 0v-2.5a.75.75 0 01.75-.75z" />
                <path d="M3.75 12a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
                <path d="M16.5 12a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
                <path d="M12 8.25a3.75 3.75 0 100 7.5 3.75 3.75 0 000-7.5zM9.75 12a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0z" />
              </svg>
              {t('groundOps.title')}
            </h3>
            <p className="text-xs text-slate-400">
              {t('groundOps.system', { system: system.name })}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">X</button>
        </div>

        <div className="px-4 py-2 border-b border-slate-800 text-xs text-slate-300 flex items-center justify-between">
          <span>{t('groundOps.transports', { count: availableTransportCount })}</span>
          {availableTransportCount === 0 && (
            <span className="text-amber-300">{t('groundOps.transportsNone')}</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
          {solidPlanets.length === 0 ? (
            <div className="text-center py-8 text-slate-500 italic text-sm border border-dashed border-slate-700 rounded">
              {t('groundOps.noLandingZones')}
            </div>
          ) : (
            solidPlanets.map(planet => {
              const planetArmies = armiesByPlanetId.get(planet.id) ?? [];
              const isBombarded = bombardedPlanetIds.has(planet.id);
              const byFaction = planetArmies.reduce<Map<FactionId, Army[]>>((map, army) => {
                const list = map.get(army.factionId) ?? [];
                list.push(army);
                map.set(army.factionId, list);
                return map;
              }, new Map());

              const playerArmies = planetArmies.filter(army => army.factionId === playerFactionId);
              const enemyArmies = planetArmies.filter(army => army.factionId !== playerFactionId);
              const isContested = playerArmies.length > 0 && enemyArmies.length > 0;

              const factionSummaries = Array.from(byFaction.entries())
                .map(([factionId, list]) => {
                  const faction = factionLookup[factionId];
                  const strength = list.reduce((sum, army) => sum + army.strength, 0);
                  return {
                    factionId,
                    name: faction?.name ?? factionId,
                    color: faction?.color ?? '#cbd5f5',
                    count: list.length,
                    strength
                  };
                })
                .sort((a, b) => b.strength - a.strength || b.count - a.count);

              const ownerLabel = planet.ownerFactionId
                ? factionLookup[planet.ownerFactionId]?.name ?? planet.ownerFactionId
                : t('groundOps.neutral');

              return (
                <div key={planet.id} className="bg-slate-800/60 border border-slate-700 rounded-lg p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-semibold text-white">{planet.name}</div>
                        {isBombarded && (
                          <span className="text-[10px] uppercase text-red-200 bg-red-900/40 border border-red-500/40 px-2 py-0.5 rounded">
                            {t('groundOps.bombardment')}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] uppercase text-slate-400">
                        {planet.bodyType} / {planet.class}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase text-slate-400">{t('groundOps.owner')}</div>
                      <div className={`text-xs font-semibold ${isContested ? 'text-amber-300' : 'text-slate-200'}`}>
                        {isContested ? t('groundOps.contested') : ownerLabel}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    {factionSummaries.length === 0 ? (
                      <span className="text-slate-500">{t('groundOps.noTroops')}</span>
                    ) : (
                      factionSummaries.map(entry => (
                        <div
                          key={entry.factionId}
                          className="px-2 py-1 rounded border border-slate-600/60 bg-slate-900/60"
                          style={{ borderColor: entry.color }}
                        >
                          <span className="font-semibold" style={{ color: entry.color }}>{entry.name}</span>
                          <span className="text-slate-300"> x{entry.count} </span>
                          <span className="text-slate-400">({entry.strength})</span>
                        </div>
                      ))
                    )}
                  </div>

                  {playerArmies.length > 0 && (
                    <div className="mt-4 border-t border-slate-700/70 pt-3">
                      <div className="text-[10px] uppercase text-slate-400 mb-2">{t('groundOps.transfer')}</div>
                      <div className="space-y-2">
                        {playerArmies.map(army => (
                          <div key={army.id} className="flex items-center justify-between gap-2">
                            <div className="text-xs text-slate-200 font-mono">
                              {shortId(army.id)} <span className="text-slate-400">({army.strength})</span>
                            </div>
                            <select
                              className="bg-slate-900 border border-slate-600 text-slate-200 text-[10px] py-1 px-2 rounded focus:outline-none focus:border-indigo-400"
                              onChange={(e) => {
                                if (e.target.value) {
                                  onTransfer(army.id, planet.id, e.target.value);
                                  e.target.value = "";
                                }
                              }}
                              disabled={!canTransfer}
                              defaultValue=""
                            >
                              <option value="" disabled>{t('groundOps.transferTo')}</option>
                              {solidPlanets
                                .filter(dest => dest.id !== planet.id)
                                .map(dest => (
                                  <option key={dest.id} value={dest.id}>
                                    {dest.name}
                                  </option>
                                ))}
                            </select>
                          </div>
                        ))}
                      </div>
                      {!canTransfer && (
                        <div className="mt-2 text-[10px] text-slate-500">
                          {t('groundOps.transferDisabled')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="p-4 bg-slate-950 border-t border-slate-800 text-center">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white uppercase transition-colors"
          >
            {t('ctx.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GroundOpsModal;
