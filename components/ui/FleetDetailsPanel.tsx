import React from 'react';
import { Fleet, StarSystem, FactionId } from '../../types';
import { useI18n } from '../../i18n';
import { fleetLabel } from '../../engine/idUtils';

interface FleetDetailsPanelProps {
  fleet: Fleet;
  system: StarSystem | null | undefined;
  factions: { id: FactionId; name: string; color: string; isPlayer: boolean }[];
  onClose: () => void;
  onSelectShip: (shipId: string | null) => void;
  onSplitFleet: (fleetId: string, shipIds: string[]) => void;
  onMergeFleets: (fleetId1: string, fleetId2: string) => void;
  onMoveFleet: (fleetId: string, systemId: string) => void;
  onSetStance: (fleetId: string, stance: string) => void;
  onSetPatrolRoute: (fleetId: string, route: string[] | null) => void;
  onTransferTroops: (fromFleetId: string, toFleetId: string) => void;
  onStartInvasion: (fleetId: string, planetId: string) => void;
}

const FleetDetailsPanel: React.FC<FleetDetailsPanelProps> = ({
  fleet,
  system,
  factions,
  onClose,
  onSelectShip,
  onSplitFleet,
  onMergeFleets,
  onMoveFleet,
  onSetStance,
  onSetPatrolRoute,
  onTransferTroops,
  onStartInvasion,
}) => {
  const { t } = useI18n();

  const owner = factions.find(f => f.id === fleet.factionId)?.name ?? fleet.factionId;

  return (
    <div className="absolute top-20 right-4 w-80 bg-slate-900/90 border border-slate-700 rounded-lg shadow-xl pointer-events-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div>
          <div className="text-sm text-slate-400">{t('sidemenu.fleet', { defaultValue: 'Fleet' })}</div>
          <div className="text-lg font-bold text-white">{fleetLabel(fleet.id)}</div>
          <div className="text-xs text-slate-500">{owner}</div>
        </div>
        <button onClick={onClose} className="text-slate-300 hover:text-white text-xl" aria-label={t('ui.close', { defaultValue: 'Close' })}>
          ×
        </button>
      </div>

      <div className="px-4 py-3 space-y-2 text-slate-200">
        <div className="text-xs uppercase tracking-wide text-slate-400">{t('ui.location', { defaultValue: 'Location' })}</div>
        <div className="font-bold">{system?.name ?? fleet.location.systemId}</div>

        <div className="text-xs uppercase tracking-wide text-slate-400 mt-3">{t('sidemenu.ships', { defaultValue: 'Ships' })}</div>
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {fleet.ships.map(ship => (
            <button
              key={ship.id}
              onClick={() => onSelectShip(ship.id)}
              className="w-full text-left px-3 py-2 rounded bg-slate-800/60 hover:bg-slate-700/60 border border-slate-700"
            >
              <div className="font-bold text-white">{ship.type}</div>
              <div className="text-xs text-slate-400">{ship.id}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-slate-800 flex flex-wrap gap-2 text-xs">
        <button onClick={() => onSplitFleet(fleet.id, [])} className="flex-1 bg-slate-800 text-white px-3 py-2 rounded hover:bg-slate-700">
          {t('ui.split', { defaultValue: 'Split' })}
        </button>
        <button onClick={() => onMergeFleets(fleet.id, fleet.id)} className="flex-1 bg-slate-800 text-white px-3 py-2 rounded hover:bg-slate-700">
          {t('ui.merge', { defaultValue: 'Merge' })}
        </button>
        <button onClick={() => onMoveFleet(fleet.id, fleet.location.systemId)} className="flex-1 bg-slate-800 text-white px-3 py-2 rounded hover:bg-slate-700">
          {t('ui.move', { defaultValue: 'Move' })}
        </button>
        <button onClick={() => onSetStance(fleet.id, fleet.stance)} className="flex-1 bg-slate-800 text-white px-3 py-2 rounded hover:bg-slate-700">
          {t('ui.stance', { defaultValue: 'Stance' })}
        </button>
        <button onClick={() => onSetPatrolRoute(fleet.id, null)} className="flex-1 bg-slate-800 text-white px-3 py-2 rounded hover:bg-slate-700">
          {t('ui.patrol', { defaultValue: 'Patrol' })}
        </button>
        <button onClick={() => onTransferTroops(fleet.id, fleet.id)} className="flex-1 bg-slate-800 text-white px-3 py-2 rounded hover:bg-slate-700">
          {t('ui.transfer', { defaultValue: 'Transfer' })}
        </button>
        <button onClick={() => onStartInvasion(fleet.id, fleet.location.systemId)} className="flex-1 bg-slate-800 text-white px-3 py-2 rounded hover:bg-slate-700">
          {t('ui.invasion', { defaultValue: 'Invasion' })}
        </button>
      </div>
    </div>
  );
};

export default FleetDetailsPanel;
