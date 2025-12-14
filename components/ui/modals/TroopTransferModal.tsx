import React, { useState, useMemo } from 'react';
import { GameState, Army, ArmyState } from '../../../types';
import { useI18n } from '../../../i18n';
import { shortId } from '../../../engine/idUtils';
import { embarkTroopsCommand } from '../../../engine/commands/embarkTroopsCommand';
import { disembarkTroopsCommand } from '../../../engine/commands/disembarkTroopsCommand';
import { findNearestSystem } from '../../../engine/world';
import { ORBIT_RADIUS } from '../../../data/static';
import { distSq } from '../../../engine/math/vec3';

interface TroopTransferModalProps {
  mode: 'embark' | 'disembark';
  fleetId: string;
  world: GameState;
  onConfirm: (updatedWorld: GameState) => void;
  onClose: () => void;
}

export function TroopTransferModal({
  mode,
  fleetId,
  world,
  onConfirm,
  onClose
}: TroopTransferModalProps) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fleet = world.fleets.find(f => f.id === fleetId);
  if (!fleet) return null;

  // Determine current system
  const currentSystem = fleet.currentSystemId
    ? world.systems.find(s => s.id === fleet.currentSystemId)
    : findNearestSystem(world.systems, fleet.position);

  if (!currentSystem) return null;

  // Verify fleet is in orbit
  const orbitThresholdSq = (ORBIT_RADIUS * 3) ** 2;
  if (distSq(fleet.position, currentSystem.position) > orbitThresholdSq) return null;

  // Get available armies based on mode
  const armies = useMemo(() => {
    if (mode === 'embark') {
      return world.armies.filter(
        a =>
          a.containerId === currentSystem.id &&
          a.state === ArmyState.DEPLOYED &&
          a.factionId === fleet.factionId &&
          !a.embarkedFleetId
      );
    } else {
      // disembark mode
      return world.armies.filter(
        a => a.embarkedFleetId === fleet.id
      );
    }
  }, [mode, world.armies, currentSystem.id, fleet.id, fleet.factionId]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
  }

  function handleConfirm() {
    if (selected.size === 0) return;

    // Apply commands and get updated state
    const updatedWorld = mode === 'embark'
      ? embarkTroopsCommand(world, fleetId, [...selected])
      : disembarkTroopsCommand(world, fleetId, [...selected]);

    // Notify parent with updated state
    onConfirm(updatedWorld);
    onClose();
  }

  const title = mode === 'embark' ? 'Embark Troops' : 'Disembark Troops';
  const actionLabel = mode === 'embark' ? 'Embark' : 'Disembark';

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[2px] pointer-events-auto z-50 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-blue-500/50 w-11/12 max-w-lg max-h-[80vh] flex flex-col rounded-xl shadow-2xl overflow-hidden">
        
        {/* HEADER */}
        <div className="bg-blue-950/30 p-4 border-b border-blue-900/50 flex justify-between items-center">
          <div>
            <h3 className="text-blue-400 font-bold text-lg tracking-wider uppercase flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M8.25 6.75a3.75 3.75 0 117.5 0 3.75 3.75 0 01-7.5 0zM15.75 9.75a3 3 0 116 0 3 3 0 01-6 0zM2.25 9.75a3 3 0 116 0 3 3 0 01-6 0zM6.31 15.117A6.745 6.745 0 0112 12a6.745 6.745 0 016.709 7.498.75.75 0 01-.372.568A12.696 12.696 0 0112 21.75c-2.305 0-4.47-.612-6.337-1.684a.75.75 0 01-.372-.568 6.787 6.787 0 011.019-4.38z" clipRule="evenodd" />
              </svg>
              {title}
            </h3>
            <p className="text-xs text-blue-200/60 font-mono">
              {mode === 'embark' 
                ? `Select armies to embark from ${currentSystem.name}`
                : `Select armies to disembark at ${currentSystem.name}`
              }
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">✕</button>
        </div>

        {/* CONTENT */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar bg-slate-900/50">
          {armies.length === 0 ? (
            <div className="text-center py-8 text-slate-500 italic text-sm border border-dashed border-slate-700 rounded">
              {mode === 'embark' 
                ? 'No deployable armies available in this system'
                : 'No armies embarked on this fleet'
              }
            </div>
          ) : (
            armies.map(army => {
              const isSelected = selected.has(army.id);
              return (
                <div
                  key={army.id}
                  onClick={() => toggle(army.id)}
                  className={`cursor-pointer px-3 py-2 rounded border transition-all ${
                    isSelected
                      ? 'bg-blue-600/30 border-blue-500/50'
                      : 'bg-slate-800/40 border-slate-700/50 hover:bg-slate-700/40'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {isSelected && (
                        <div className="w-2 h-2 rounded-full bg-blue-400"></div>
                      )}
                      <span className="font-mono text-sm text-slate-300">
                        {shortId(army.id)}
                      </span>
                    </div>
                    <span className="text-xs text-slate-400 font-bold">
                      STR {army.strength.toLocaleString()}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* FOOTER */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex justify-between items-center">
          <div className="text-xs text-slate-400">
            {selected.size > 0 && `${selected.size} army${selected.size > 1 ? 'ies' : ''} selected`}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white uppercase transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={selected.size === 0}
              onClick={handleConfirm}
              className={`px-4 py-2 text-xs font-bold uppercase transition-colors ${
                selected.size > 0
                  ? 'bg-blue-600 hover:bg-blue-500 text-white'
                  : 'bg-slate-800 text-slate-500 cursor-not-allowed'
              }`}
            >
              {actionLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
