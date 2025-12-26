import React from 'react';
import { Army, FactionState, Fleet, ShipEntity, ShipConsumables, ShipKillRecord, ShipType } from '../../../shared/types';
import { SHIP_STATS } from '../../../content/data/static';
import { useFleetName } from '../../context/FleetNames';
import { useI18n } from '../../i18n';
import { sorted } from '../../../shared/sorting';
import { SHIP_ICONS } from '../../assets/ships/registry';

interface ShipDetailModalProps {
  fleet: Fleet;
  faction?: FactionState;
  armies: Army[];
  onClose: () => void;
}

const formatAmmo = (value: number | undefined) => (value && value > 0 ? value.toString() : '0');

const getAmmoFromConsumables = (
  ship: ShipEntity,
  key: keyof ShipConsumables,
  fallback: number,
  legacy?: number
) => ship.consumables?.[key] ?? legacy ?? fallback;

const ShipCard: React.FC<{ ship: ShipEntity; armies: Army[] }> = ({ ship, armies }) => {
  const { t } = useI18n();
  const stats = SHIP_STATS[ship.type];
  const carriedArmy = armies.find(a => a.id === ship.carriedArmyId);
  const killTurn = (entry: ShipKillRecord) => entry.turn ?? entry.day ?? 0;
  const kills = sorted(ship.killHistory ?? [], (a, b) => killTurn(a) - killTurn(b));

  const missileCount = getAmmoFromConsumables(ship, 'offensiveMissiles', stats.offensiveMissileStock, ship.offensiveMissilesLeft);
  const torpedoCount = getAmmoFromConsumables(ship, 'torpedoes', stats.torpedoStock, ship.torpedoesLeft);
  const interceptorCount = getAmmoFromConsumables(ship, 'interceptors', stats.interceptorStock, ship.interceptorsLeft);
  const getShipTypeLabel = (type: ShipType) => t(`shipType.${type}`, { defaultValue: type });
  const shipTypeLabel = getShipTypeLabel(ship.type);

  return (
    <div className="bg-slate-800/70 border border-slate-700 rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-md bg-slate-900/60 border border-slate-700 p-1">
            <img
              src={SHIP_ICONS[ship.type]}
              alt={t('ship.detail.imageAlt', { type: shipTypeLabel })}
              className="h-full w-full object-contain"
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="font-semibold text-lg">{shipTypeLabel}</div>
        </div>
        <div className="text-sm text-slate-300">{t('ship.detail.idLabel', { id: ship.id })}</div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-slate-300">{t('ship.detail.health')}</div>
          <div className="font-semibold">{ship.hp} / {ship.maxHp}</div>
        </div>
        <div>
          <div className="text-slate-300">{t('ship.detail.damage')}</div>
          <div className="font-semibold">{stats.damage}</div>
        </div>
        <div>
          <div className="text-slate-300">{t('ship.detail.missiles')}</div>
          <div className="font-semibold">{formatAmmo(missileCount)}</div>
        </div>
        <div>
          <div className="text-slate-300">{t('ship.detail.torpedoes')}</div>
          <div className="font-semibold">{formatAmmo(torpedoCount)}</div>
        </div>
        <div>
          <div className="text-slate-300">{t('ship.detail.interceptors')}</div>
          <div className="font-semibold">{formatAmmo(interceptorCount)}</div>
        </div>
        <div>
          <div className="text-slate-300">{t('ship.detail.pointDefense')}</div>
          <div className="font-semibold">{stats.pdStrength}</div>
        </div>
      </div>

      {carriedArmy && (
        <div className="bg-slate-900/60 border border-slate-700 rounded-md p-3 text-sm">
          <div className="font-semibold mb-1">{t('ship.detail.embarkedTroops')}</div>
          <div className="text-slate-200">{t('ship.detail.armyLabel', { id: carriedArmy.id })}</div>
          <div className="text-slate-300">
            {t('ship.detail.strengthLabel', { current: carriedArmy.strength, max: carriedArmy.maxStrength })}
          </div>
          <div className="text-slate-300">
            {t('ship.detail.moraleLabel', { percent: (carriedArmy.morale * 100).toFixed(0) })}
          </div>
        </div>
      )}

      <div className="bg-slate-900/60 border border-slate-700 rounded-md p-3 text-sm">
          <div className="font-semibold mb-2">{t('ship.detail.killLog')}</div>
          {kills.length === 0 ? (
            <div className="text-slate-400">{t('ship.detail.noKills')}</div>
          ) : (
            <ul className="space-y-1">
              {kills.map(entry => (
                <li key={entry.id} className="flex justify-between gap-2">
                <div className="text-slate-300">{t('ship.detail.turnLabel', { turn: killTurn(entry) })}</div>
                <div className="font-semibold text-slate-100 text-right">
                  {getShipTypeLabel(entry.targetType)} — {entry.targetId}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const ShipDetailModal: React.FC<ShipDetailModalProps> = ({ fleet, faction, armies, onClose }) => {
  const getFleetName = useFleetName();
  const { t } = useI18n();
  const shipCountLabel = t('orbitPicker.shipCount', { count: fleet.ships.length });
  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="bg-slate-900 text-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden border border-slate-700">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <div className="text-sm text-slate-300">{faction?.name ?? t('ship.detail.unknownFaction')}</div>
            <div className="text-2xl font-bold">{getFleetName(fleet.id)} — {shipCountLabel}</div>
          </div>
          <button
            className="text-slate-300 hover:text-white transition-colors"
            onClick={onClose}
            aria-label={t('ship.detail.close')}
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto max-h-[78vh]">
          <div>
            <div className="text-lg font-semibold mb-3">{t('ship.detail.shipsTitle')}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {fleet.ships.map(ship => (
                <ShipCard key={ship.id} ship={ship} armies={armies} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ShipDetailModal;
