
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FactionId, StarSystem } from '../../../shared/types';
import { useI18n } from '../../i18n';
import { computeConstrainedMenuPosition, SafeAreaInsets, ViewportRect } from './positioning/computeConstrainedMenuPosition';

type GroundForceStats = {
  count: number;
  currentStrength: number;
  maxStrength: number;
  losses: number;
  lossPercent: number;
  averageMoralePercent: number;
};

export type GroundForceSummaryEntry = GroundForceStats & {
  factionId: FactionId;
  factionName: string;
  color: string;
  isPlayer: boolean;
};

interface SystemContextMenuProps {
  position: { x: number, y: number };
  system: StarSystem;
  groundForces: Record<FactionId, GroundForceSummaryEntry> | null;
  showInvadeOption: boolean; // Computed by parent based on strict rules
  showAttackOption: boolean;
  showLoadOption: boolean;
  showUnloadOption: boolean;
  showGroundOpsOption: boolean;
  canSelectFleet: boolean;
  onOpenSystemDetails: () => void;
  onSelectFleetAtSystem: () => void;
  onOpenFleetPicker: () => void;
  onOpenLoadPicker: () => void;
  onOpenUnloadPicker: () => void;
  onOpenGroundOps: () => void;
  onInvade: () => void;
  onAttack: () => void;
  onClose: () => void;
}

const SAFE_PADDING = 8;
const MENU_OFFSET = 12;
const OVERLAY_ID = 'ui-overlay';

const readSafeAreaInsets = (): SafeAreaInsets => {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
        return { top: 0, right: 0, bottom: 0, left: 0 };
    }

    const style = window.getComputedStyle(overlay);
    const toNumber = (value: string | null) => {
        const parsed = Number.parseFloat(value ?? '');
        return Number.isFinite(parsed) ? parsed : 0;
    };

    return {
        top: toNumber(style.paddingTop),
        right: toNumber(style.paddingRight),
        bottom: toNumber(style.paddingBottom),
        left: toNumber(style.paddingLeft),
    };
};

const readViewportRect = (): ViewportRect => {
    const vv = window.visualViewport;

    if (vv) {
        return {
            left: vv.offsetLeft,
            top: vv.offsetTop,
            width: vv.width,
            height: vv.height,
        };
    }

    return {
        left: 0,
        top: 0,
        width: window.innerWidth,
        height: window.innerHeight,
    };
};

const SystemContextMenu: React.FC<SystemContextMenuProps> = ({
    position, system, groundForces, showInvadeOption, showAttackOption, showLoadOption, showUnloadOption, showGroundOpsOption,
    canSelectFleet, onOpenSystemDetails, onSelectFleetAtSystem,
    onOpenFleetPicker, onOpenLoadPicker, onOpenUnloadPicker, onOpenGroundOps, onInvade, onAttack, onClose
}) => {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [resolvedPosition, setResolvedPosition] = useState(position);
  const [menuConstraints, setMenuConstraints] = useState<{ maxHeight?: number; maxWidth?: number }>({});

  const recalcPosition = useCallback(() => {
      const menu = menuRef.current;
      if (!menu) return;

      const viewport = readViewportRect();
      const safeInsets = readSafeAreaInsets();
      const rect = menu.getBoundingClientRect();

      const constrained = computeConstrainedMenuPosition({
          anchor: position,
          menuSize: { width: rect.width, height: rect.height },
          viewport,
          safeInsets,
          offset: MENU_OFFSET,
          padding: SAFE_PADDING,
      });

      setResolvedPosition(constrained);

      const maxHeight = Math.max(SAFE_PADDING, viewport.height - safeInsets.top - safeInsets.bottom - (SAFE_PADDING * 2));
      const maxWidth = Math.max(SAFE_PADDING, viewport.width - safeInsets.left - safeInsets.right - (SAFE_PADDING * 2));

      setMenuConstraints({ maxHeight, maxWidth });
  }, [position]);

  useLayoutEffect(() => {
      recalcPosition();
  }, [
      recalcPosition,
      groundForces,
      showGroundOpsOption,
      showAttackOption,
      showInvadeOption,
      showLoadOption,
      showUnloadOption,
      canSelectFleet,
      system,
  ]);

  useEffect(() => {
      const menu = menuRef.current;
      if (!menu) return;

      if (typeof ResizeObserver === 'undefined') {
          recalcPosition();
          return;
      }

      const observer = new ResizeObserver(() => recalcPosition());
      observer.observe(menu);

      return () => observer.disconnect();
  }, [recalcPosition]);

  useEffect(() => {
      const handleViewportChange = () => recalcPosition();

      window.addEventListener('resize', handleViewportChange);
      const vv = window.visualViewport;
      vv?.addEventListener('resize', handleViewportChange);
      vv?.addEventListener('scroll', handleViewportChange);

      return () => {
          window.removeEventListener('resize', handleViewportChange);
          vv?.removeEventListener('resize', handleViewportChange);
          vv?.removeEventListener('scroll', handleViewportChange);
      };
  }, [recalcPosition]);

  useEffect(() => {
      recalcPosition();
  }, [position, recalcPosition]);

  const renderFactionBlock = (entry: GroundForceSummaryEntry, labelOverride?: string) => {
      const colorStyle = { color: entry.color };

      return (
          <div key={entry.factionId} className="flex flex-col gap-0.5">
              <div className="flex justify-between text-sm" style={colorStyle}>
                  <span>{labelOverride ?? entry.factionName} x{entry.count}</span>
                  <span className="font-mono">{entry.currentStrength.toLocaleString()} / {entry.maxStrength.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-[10px] text-slate-300">
                  <span>{t('ctx.losses')}</span>
                  <span className="font-mono">-{entry.losses.toLocaleString()} ({entry.lossPercent.toFixed(1)}%)</span>
              </div>
              <div className="flex justify-between text-[10px] text-slate-300">
                  <span>{t('ctx.morale')}</span>
                  <span className="font-mono">{entry.averageMoralePercent.toFixed(1)}%</span>
              </div>
          </div>
      );
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-40 bg-slate-900/95 border border-blue-500/30 text-white p-2 rounded shadow-2xl backdrop-blur min-w-[200px] animate-in fade-in zoom-in-95 duration-100 pointer-events-auto flex flex-col gap-1 overflow-y-auto overscroll-contain"
      style={{
          left: resolvedPosition.x,
          top: resolvedPosition.y,
          maxHeight: menuConstraints.maxHeight,
          maxWidth: menuConstraints.maxWidth,
      }}
    >
      <div className="px-3 py-2 text-xs font-bold text-blue-200 border-b border-slate-700 mb-1 uppercase tracking-wider flex items-center gap-2">
          <span>{system.name}</span>
          {system.isHomeworld && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-100 border border-blue-500/30">
                  {t('ctx.homeworld')}
              </span>
          )}
      </div>

      <button
          onClick={onOpenSystemDetails}
          className="text-left px-3 py-2 hover:bg-slate-700/50 text-slate-200 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 uppercase"
      >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zm0 1.5a8.25 8.25 0 110 16.5 8.25 8.25 0 010-16.5z" />
              <path d="M11.25 11.25a.75.75 0 000 1.5h.5v3a.75.75 0 001.5 0v-3A1.75 1.75 0 0011.5 10h-.25a.75.75 0 00-.75.75z" />
              <circle cx="12" cy="8" r="1" />
          </svg>
          {t('ctx.systemDetails')}
      </button>

      {canSelectFleet && (
          <button
              onClick={onSelectFleetAtSystem}
              className="text-left px-3 py-2 hover:bg-indigo-600/20 text-indigo-300 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 uppercase"
          >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M11.47 3.72a.75.75 0 011.06 0l8.25 8.25a.75.75 0 01-1.06 1.06L12 5.56 4.28 13.03a.75.75 0 11-1.06-1.06l8.25-8.25z" clipRule="evenodd" />
                  <path fillRule="evenodd" d="M4.22 12.22a.75.75 0 011.06 0L12 18.94l6.72-6.72a.75.75 0 111.06 1.06l-7.25 7.25a.75.75 0 01-1.06 0l-7.25-7.25a.75.75 0 010-1.06z" clipRule="evenodd" />
              </svg>
              {t('ctx.selectFleet')}
          </button>
      )}

      {/* GROUND INTEL SECTION */}
      {groundForces && (
          <div className="px-3 py-2 mb-1 bg-slate-800/50 rounded border border-slate-700/50 text-[10px]">
              <div className="uppercase font-bold text-slate-400 mb-1 flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                    <path fillRule="evenodd" d="M10 2c-1.716 0-3.408.106-5.07.31C3.806 2.45 3 3.414 3 4.517V17.25a.75.75 0 001.075.676L10 15.082l5.925 2.844A.75.75 0 0017 17.25V4.517c0-1.103-.806-2.068-1.93-2.207A41.403 41.403 0 0010 2z" clipRule="evenodd" />
                  </svg>
                  {t('ctx.groundForces')}
              </div>
              <div className="flex flex-col gap-1">
                  {(() => {
                      const entries = Object.values(groundForces);
                      const playerEntry = entries.find(entry => entry.isPlayer);
                      const hostileEntries = entries
                          .filter(entry => !entry.isPlayer)
                          .sort((a, b) => b.currentStrength - a.currentStrength || b.maxStrength - a.maxStrength);

                      const highlightedHostiles = hostileEntries.slice(0, 2);
                      const coalitionEntries = hostileEntries.slice(2);

                          const coalition = coalitionEntries.length > 0
                          ? coalitionEntries.reduce<GroundForceSummaryEntry | null>((acc, entry) => {
                              if (!acc) {
                                  return {
                                      ...entry,
                                      factionId: 'hostile-coalition',
                                      factionName: t('ctx.hostileCoalition'),
                                      color: '#f87171',
                                      isPlayer: false,
                                  };
                              }

                              const totalCount = acc.count + entry.count;
                              const combinedMorale = (acc.averageMoralePercent * acc.count) + (entry.averageMoralePercent * entry.count);

                              const updatedMax = acc.maxStrength + entry.maxStrength;
                              const updatedCurrent = acc.currentStrength + entry.currentStrength;
                              const updatedLosses = updatedMax - updatedCurrent;

                              return {
                                  ...acc,
                                  count: totalCount,
                                  currentStrength: updatedCurrent,
                                  maxStrength: updatedMax,
                                  losses: updatedLosses,
                                  lossPercent: updatedMax > 0 ? (updatedLosses / updatedMax) * 100 : 0,
                                  averageMoralePercent: totalCount > 0 ? combinedMorale / totalCount : 0,
                              };
                          }, null)
                          : null;

                      return (
                          <>
                              {playerEntry && renderFactionBlock(playerEntry)}
                              {highlightedHostiles.map(entry => renderFactionBlock(entry))}
                              {coalition && renderFactionBlock(coalition)}
                          </>
                      );
                  })()}
              </div>
          </div>
      )}

      {showGroundOpsOption && (
          <button
              onClick={onOpenGroundOps}
              className="text-left px-3 py-2 hover:bg-indigo-600/20 text-indigo-300 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 uppercase"
          >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M12 3.75a.75.75 0 01.75.75v2.5a.75.75 0 01-1.5 0v-2.5a.75.75 0 01.75-.75z" />
                  <path d="M12 16.5a.75.75 0 01.75.75v2.5a.75.75 0 01-1.5 0v-2.5a.75.75 0 01.75-.75z" />
                  <path d="M3.75 12a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
                  <path d="M16.5 12a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75z" />
                  <path d="M12 8.25a3.75 3.75 0 100 7.5 3.75 3.75 0 000-7.5zM9.75 12a2.25 2.25 0 114.5 0 2.25 2.25 0 01-4.5 0z" />
              </svg>
              {t('ctx.groundOps')}
          </button>
      )}

      {/* MOVE OR ATTACK ACTION */}
      <button
          onClick={showAttackOption ? onAttack : onOpenFleetPicker}
          className="text-left px-3 py-2 hover:bg-blue-600/20 text-blue-300 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 uppercase"
      >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
            <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
          </svg>
          {showAttackOption ? t('ctx.attack') : t('ctx.moveTo')}
      </button>

      {/* LOAD ARMIES */}
      {showLoadOption && (
          <button
              onClick={onOpenLoadPicker}
              className="text-left px-3 py-2 hover:bg-emerald-600/20 text-emerald-300 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 uppercase"
          >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M11.47 3.72a.75.75 0 011.06 0l4.5 4.5a.75.75 0 11-1.06 1.06L12.75 6.56V16a.75.75 0 01-1.5 0V6.56L8.09 9.28a.75.75 0 01-1.06-1.06l4.44-4.5z" />
                  <path d="M5.75 18.5a.75.75 0 00-.75.75v.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0019 19.75v-.5a.75.75 0 00-.75-.75H5.75z" />
              </svg>
              {t('ctx.load')}
          </button>
      )}

      {/* UNLOAD ARMIES */}
      {showUnloadOption && (
          <button
              onClick={onOpenUnloadPicker}
              className="text-left px-3 py-2 hover:bg-amber-600/20 text-amber-300 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 uppercase"
          >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                  <path d="M12.53 20.28a.75.75 0 01-1.06 0l-4.5-4.5a.75.75 0 111.06-1.06l3.16 3.16V8a.75.75 0 111.5 0v9.88l3.16-3.16a.75.75 0 111.06 1.06l-4.38 4.5z" />
                  <path d="M5.75 3.5A1.75 1.75 0 004 5.25v.5c0 .414.336.75.75.75h14.5a.75.75 0 00.75-.75v-.5A1.75 1.75 0 0018.25 3.5H5.75z" />
              </svg>
              {t('ctx.unload')}
          </button>
      )}

      {/* INVADE ACTION (Conditional) */}
      {showInvadeOption && (
          <button 
              onClick={onInvade}
              className="text-left px-3 py-2 bg-red-900/20 hover:bg-red-600/40 text-red-300 hover:text-white rounded transition-colors text-sm font-bold flex items-center gap-2 border border-red-500/30 uppercase"
          >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                 <path fillRule="evenodd" d="M8.25 6.75a3.75 3.75 0 117.5 0 3.75 3.75 0 01-7.5 0zM15.75 9.75a3 3 0 116 0 3 3 0 01-6 0zM2.25 9.75a3 3 0 116 0 3 3 0 01-6 0zM6.31 15.117A6.745 6.745 0 0112 12a6.745 6.745 0 016.709 7.498.75.75 0 01-.372.568A12.696 12.696 0 0112 21.75c-2.305 0-4.47-.612-6.337-1.684a.75.75 0 01-.372-.568 6.787 6.787 0 011.019-4.38z" clipRule="evenodd" />
                 <path d="M5.082 14.254a6.755 6.755 0 01-1.717-1.432 12.78 12.78 0 011.855-4.243C5.22 8.579 5.25 8.579 5.25 8.579c0 .139.186.206.29.105l.507-.507a6 6 0 013.78-1.55 6.002 6.002 0 013.78 1.55l.507.507c.104.101.29.034.29-.105 0 0 .03 0 .029.001a12.78 12.78 0 011.855 4.243 6.755 6.755 0 01-1.717 1.432l-.258.129a8 8 0 00-2.275-.853A6.71 6.71 0 0012 13.5a6.71 6.71 0 00-2.292.407 8 8 0 00-2.275.853l-.258-.129z" opacity="0.5"/>
              </svg>
              {t('ctx.invade')}
          </button>
      )}

      {/* CANCEL */}
      <button 
          onClick={onClose}
          className="text-left px-3 py-2 hover:bg-white/10 text-slate-400 hover:text-white rounded transition-colors text-sm uppercase"
      >
          {t('ctx.cancel')}
      </button>
    </div>
  );
};

export default SystemContextMenu;
