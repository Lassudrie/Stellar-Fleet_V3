import React, { useMemo } from 'react';
import { Army, FactionState, Fleet, LogEntry, ShipEntity } from '../../types';
import { SHIP_STATS } from '../../data/static';
import { fleetLabel } from '../../engine/idUtils';

interface ShipDetailModalProps {
  fleet: Fleet;
  faction?: FactionState;
  armies: Army[];
  logs: LogEntry[];
  onClose: () => void;
}

const formatAmmo = (value: number | undefined, fallback: number) => {
  const stock = value ?? fallback;
  return stock > 0 ? stock.toString() : '0';
};

const ShipCard: React.FC<{ ship: ShipEntity; armies: Army[] }> = ({ ship, armies }) => {
  const stats = SHIP_STATS[ship.type];
  const carriedArmy = armies.find(a => a.id === ship.carriedArmyId);

  return (
    <div className="bg-slate-800/70 border border-slate-700 rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-lg capitalize">{ship.type.replace('_', ' ')}</div>
        <div className="text-sm text-slate-300">ID: {ship.id}</div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-slate-300">Health</div>
          <div className="font-semibold">{ship.hp} / {ship.maxHp}</div>
        </div>
        <div>
          <div className="text-slate-300">Damage</div>
          <div className="font-semibold">{stats.damage}</div>
        </div>
        <div>
          <div className="text-slate-300">Missiles</div>
          <div className="font-semibold">{formatAmmo(ship.offensiveMissilesLeft, stats.offensiveMissileStock)}</div>
        </div>
        <div>
          <div className="text-slate-300">Torpedoes</div>
          <div className="font-semibold">{formatAmmo(ship.torpedoesLeft, stats.torpedoStock)}</div>
        </div>
        <div>
          <div className="text-slate-300">Interceptors</div>
          <div className="font-semibold">{formatAmmo(ship.interceptorsLeft, stats.interceptorStock)}</div>
        </div>
        <div>
          <div className="text-slate-300">Point Defense</div>
          <div className="font-semibold">{stats.pdStrength}</div>
        </div>
      </div>

      {carriedArmy && (
        <div className="bg-slate-900/60 border border-slate-700 rounded-md p-3 text-sm">
          <div className="font-semibold mb-1">Embarked troops</div>
          <div className="text-slate-200">Army: {carriedArmy.id}</div>
          <div className="text-slate-300">Strength: {carriedArmy.strength} / {carriedArmy.maxStrength}</div>
          <div className="text-slate-300">Morale: {(carriedArmy.morale * 100).toFixed(0)}%</div>
        </div>
      )}
    </div>
  );
};

const ShipDetailModal: React.FC<ShipDetailModalProps> = ({ fleet, faction, armies, logs, onClose }) => {
  const killEntries = useMemo(() => {
    const fleetIdLower = fleet.id.toLowerCase();
    return logs
      .filter(entry => entry.type === 'combat' && entry.text.toLowerCase().includes(fleetIdLower))
      .sort((a, b) => a.day - b.day);
  }, [fleet.id, logs]);

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="bg-slate-900 text-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden border border-slate-700">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <div className="text-sm text-slate-300">{faction?.name ?? 'Unknown faction'}</div>
            <div className="text-2xl font-bold">{fleetLabel(fleet.id)} — {fleet.ships.length} ships</div>
          </div>
          <button
            className="text-slate-300 hover:text-white transition-colors"
            onClick={onClose}
            aria-label="Close ship details"
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto max-h-[78vh]">
          <div>
            <div className="text-lg font-semibold mb-3">Ships</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {fleet.ships.map(ship => (
                <ShipCard key={ship.id} ship={ship} armies={armies} />
              ))}
            </div>
          </div>

          <div>
            <div className="text-lg font-semibold mb-3">Kills</div>
            {killEntries.length === 0 ? (
              <div className="text-slate-300">No confirmed kills yet.</div>
            ) : (
              <ul className="space-y-2 text-sm">
                {killEntries.map(entry => (
                  <li key={entry.id} className="bg-slate-800/60 border border-slate-700 rounded-md p-3">
                    <div className="text-slate-400">Day {entry.day}</div>
                    <div className="text-slate-100">{entry.text}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ShipDetailModal;
