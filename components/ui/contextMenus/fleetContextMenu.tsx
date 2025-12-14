import React from 'react';
import { Fleet, GameState } from '../../../types';
import { useI18n } from '../../../i18n';
import { canEmbarkTroops, canDisembarkTroops } from './fleetContextMenuRules';

interface FleetContextMenuProps {
  position: { x: number; y: number };
  fleet: Fleet;
  world: GameState;
  onEmbarkTroops: () => void;
  onDisembarkTroops: () => void;
  onClose: () => void;
}

export function FleetContextMenu({
  position,
  fleet,
  world,
  onEmbarkTroops,
  onDisembarkTroops,
  onClose
}: FleetContextMenuProps) {
  const { t } = useI18n();

  const canEmbark = canEmbarkTroops(fleet, world);
  const canDisembark = canDisembarkTroops(fleet, world);

  return (
    <div
      className="absolute z-40 bg-slate-900/95 border border-blue-500/30 text-white p-2 rounded shadow-2xl backdrop-blur min-w-[200px] animate-in fade-in zoom-in-95 duration-100 pointer-events-auto flex flex-col gap-1"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-2 text-xs font-bold text-blue-200 border-b border-slate-700 mb-1 uppercase tracking-wider">
        Fleet Actions
      </div>

      {canEmbark && (
        <button
          onClick={() => {
            onEmbarkTroops();
            onClose();
          }}
          className="text-left px-3 py-2 hover:bg-blue-600/20 text-blue-300 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 uppercase"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
          </svg>
          Embark Troops
        </button>
      )}

      {canDisembark && (
        <button
          onClick={() => {
            onDisembarkTroops();
            onClose();
          }}
          className="text-left px-3 py-2 hover:bg-blue-600/20 text-blue-300 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 uppercase"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M4 10a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H4.75A.75.75 0 014 10z" clipRule="evenodd" />
          </svg>
          Disembark Troops
        </button>
      )}

      <button
        onClick={onClose}
        className="text-left px-3 py-2 hover:bg-white/10 text-slate-400 hover:text-white rounded transition-colors text-sm uppercase"
      >
        {t('ctx.cancel')}
      </button>
    </div>
  );
}
