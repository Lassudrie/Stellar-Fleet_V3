import React, { useMemo } from 'react';
import type { GameState, PlanetBody } from '../../../shared/types';
import { generateSurfaceMapForState } from '../../../engine/planetSurface/access';
import { useI18n } from '../../i18n';

type PlanetView2DProps = {
  gameState: GameState;
  systemId: string;
  bodyId: string;
  onBack: () => void;
};

const PlanetView2D: React.FC<PlanetView2DProps> = ({ gameState, systemId, bodyId, onBack }) => {
  const { t } = useI18n();

  const { system, body } = useMemo(() => {
    const system = gameState.systems.find(s => s.id === systemId) ?? null;
    const body = system?.planets.find(p => p.id === bodyId) ?? null;
    return { system, body };
  }, [gameState.systems, systemId, bodyId]);

  const map = useMemo(() => {
    return generateSurfaceMapForState(gameState, bodyId);
  }, [gameState, bodyId]);

  const bodyName = (body as PlanetBody | null)?.name ?? bodyId;
  const systemName = system?.name ?? systemId;

  return (
    <div className="relative h-screen w-full bg-black text-white">
      <div className="pointer-events-auto absolute left-0 right-0 top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/70 p-3 backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          title={t('screen.return')}
          className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:border-slate-500 hover:bg-slate-800"
        >
          ←
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{systemName}</div>
          <div className="truncate text-lg font-bold">{bodyName}</div>
        </div>
        <div className="w-[44px]" />
      </div>

      <div className="absolute inset-0 pt-16">
        <div className="h-full w-full p-4">
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">PlanetView2D</div>
            <div className="mt-2 text-slate-300">
              {map
                ? `Grid: ${map.descriptor.config.w}×${map.descriptor.config.h} • settlements: ${map.settlements.length}`
                : 'Surface map not available (missing descriptor or astro).'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PlanetView2D;

