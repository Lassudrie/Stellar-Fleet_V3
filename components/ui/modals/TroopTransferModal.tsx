import React, { useState } from 'react';
import { GameState, Army, ArmyState, ShipType } from '../../../types';
import { shortId } from '../../../engine/idUtils';
import { findNearestSystem } from '../../../engine/world';
import { ORBIT_RADIUS } from '../../../data/static';
import { distSq } from '../../../engine/math/vec3';

interface TroopTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'embark' | 'disembark';
  fleetId: string;
  world: GameState;
  onConfirm: (updatedWorld: GameState) => void;
}

const ORBIT_THRESHOLD_SQ = (ORBIT_RADIUS * 3) * (ORBIT_RADIUS * 3);

export function TroopTransferModal({
  isOpen,
  onClose,
  mode,
  fleetId,
  world,
  onConfirm
}: TroopTransferModalProps) {
  const [selectedArmyIds, setSelectedArmyIds] = useState<Set<string>>(new Set());

  const fleet = world.fleets.find(f => f.id === fleetId);
  if (!isOpen || !fleet) return null;

  const currentSystem =
    fleet.currentSystemId
      ? world.systems.find(s => s.id === fleet.currentSystemId) || findNearestSystem(world.systems, fleet.position)
      : findNearestSystem(world.systems, fleet.position);

  if (!currentSystem) return null;

  const inOrbit = distSq(fleet.position, currentSystem.position) <= ORBIT_THRESHOLD_SQ;
  if (!inOrbit) return null;

  const transportShips = fleet.ships.filter(s => s.type === ShipType.TROOP_TRANSPORT);
  const emptyTransportShips = transportShips.filter(s => !s.carriedArmyId);
  const loadedTransportShips = transportShips.filter(s => !!s.carriedArmyId);

  const isAlliedSystem = currentSystem.ownerFactionId === fleet.factionId;

  let availableArmies: Army[] = [];
  if (mode === 'embark') {
    availableArmies = world.armies
      .filter(a =>
        a.state === ArmyState.DEPLOYED &&
        a.containerId === currentSystem.id &&
        a.factionId === fleet.factionId
      )
      .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  } else {
    const carriedArmyIds = new Set<string>(
      loadedTransportShips
        .map(s => s.carriedArmyId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    );

    availableArmies = world.armies
      .filter(a => carriedArmyIds.has(a.id))
      .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  }

  const capacity = mode === 'embark' ? emptyTransportShips.length : loadedTransportShips.length;

  const canConfirm =
    selectedArmyIds.size > 0 &&
    (mode === 'embark'
      ? emptyTransportShips.length > 0
      : isAlliedSystem && loadedTransportShips.length > 0);

  const toggleSelect = (armyId: string) => {
    setSelectedArmyIds(prev => {
      const next = new Set(prev);

      if (next.has(armyId)) {
        next.delete(armyId);
        return next;
      }

      // Capacity guard (embark only)
      if (mode === 'embark' && next.size >= emptyTransportShips.length) {
        return next;
      }

      next.add(armyId);
      return next;
    });
  };

  const handleConfirm = () => {
    if (selectedArmyIds.size === 0) return;

    if (mode === 'disembark' && !isAlliedSystem) {
      // Disembark into non-allied system is forbidden
      return;
    }

    const selectedSorted = Array.from(selectedArmyIds).sort((a, b) => a.localeCompare(b));

    if (mode === 'embark') {
      const eligibleIdSet = new Set(availableArmies.map(a => a.id));
      const requested = selectedSorted.filter(id => eligibleIdSet.has(id));

      const availableShips = emptyTransportShips.slice().sort((a, b) => a.id.localeCompare(b.id));
      const max = Math.min(requested.length, availableShips.length);
      if (max <= 0) return;

      const assignments = new Map<string, string>(); // shipId -> armyId
      for (let i = 0; i < max; i++) {
        assignments.set(availableShips[i].id, requested[i]);
      }
      const embarkedArmyIds = new Set(requested.slice(0, max));

      const updatedWorld: GameState = {
        ...world,
        fleets: world.fleets.map(f => {
          if (f.id !== fleet.id) return f;
          return {
            ...f,
            ships: f.ships.map(s => {
              const armyId = assignments.get(s.id);
              if (!armyId) return s;
              return { ...s, carriedArmyId: armyId };
            })
          };
        }),
        armies: world.armies.map(a => {
          if (!embarkedArmyIds.has(a.id)) return a;
          return {
            ...a,
            state: ArmyState.EMBARKED,
            containerId: fleet.id
          };
        })
      };

      onConfirm(updatedWorld);
      onClose();
      return;
    }

    // Disembark: map carriedArmyId -> shipId
    const carriedArmyIdToShipId = new Map<string, string>();
    fleet.ships.forEach(s => {
      if (s.type === ShipType.TROOP_TRANSPORT && s.carriedArmyId) {
        carriedArmyIdToShipId.set(s.carriedArmyId, s.id);
      }
    });

    const disembarkableArmyIds = selectedSorted.filter(id => carriedArmyIdToShipId.has(id));
    if (disembarkableArmyIds.length === 0) return;

    const disembarkSet = new Set(disembarkableArmyIds);
    const shipsToClear = new Set<string>(disembarkableArmyIds.map(id => carriedArmyIdToShipId.get(id)!));

    const updatedWorld: GameState = {
      ...world,
      fleets: world.fleets.map(f => {
        if (f.id !== fleet.id) return f;
        return {
          ...f,
          ships: f.ships.map(s => {
            if (!shipsToClear.has(s.id)) return s;
            return { ...s, carriedArmyId: null };
          })
        };
      }),
      armies: world.armies.map(a => {
        if (!disembarkSet.has(a.id)) return a;
        return {
          ...a,
          state: ArmyState.DEPLOYED,
          containerId: currentSystem.id
        };
      })
    };

    onConfirm(updatedWorld);
    onClose();
  };

  const title =
    mode === 'embark'
      ? `Embark Troops – Fleet ${shortId(fleet.id)}`
      : `Disembark Troops – Fleet ${shortId(fleet.id)}`;

  const subtitle =
    mode === 'embark'
      ? `System: ${currentSystem.name} • Slots available: ${emptyTransportShips.length}`
      : `System: ${currentSystem.name} • Loaded transports: ${loadedTransportShips.length}`;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
      <div className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-md max-h-[80vh] flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold text-slate-100">{title}</h2>
          <div className="text-sm text-slate-400">{subtitle}</div>
          {mode === 'disembark' && !isAlliedSystem && (
            <div className="mt-2 text-sm text-red-300">
              Disembark is only allowed in allied systems.
            </div>
          )}
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {availableArmies.length === 0 ? (
            <div className="text-slate-400 text-sm">
              No eligible armies available for this action.
            </div>
          ) : (
            <div className="space-y-2">
              {availableArmies.map(army => {
                const isSelected = selectedArmyIds.has(army.id);
                const disabled =
                  mode === 'embark' &&
                  !isSelected &&
                  selectedArmyIds.size >= capacity;

                return (
                  <button
                    key={army.id}
                    onClick={() => toggleSelect(army.id)}
                    disabled={disabled}
                    className={`w-full flex items-center justify-between p-3 rounded-md border ${
                      isSelected
                        ? 'bg-blue-900/30 border-blue-500'
                        : 'bg-slate-800 border-slate-700 hover:border-slate-500'
                    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <div className="flex flex-col items-start">
                      <span className="text-slate-100 font-medium">
                        Army {shortId(army.id)}
                      </span>
                      <span className="text-slate-400 text-sm">
                        Strength: {army.strength}
                      </span>
                    </div>
                    <div className="text-slate-300">
                      {isSelected ? '✓' : '○'}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-700 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md bg-slate-800 text-slate-200 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 rounded-md ${
              canConfirm
                ? 'bg-blue-600 text-white hover:bg-blue-500'
                : 'bg-slate-700 text-slate-400 cursor-not-allowed'
            }`}
          >
            Confirm ({selectedArmyIds.size}/{capacity})
          </button>
        </div>
      </div>
    </div>
  );
}
