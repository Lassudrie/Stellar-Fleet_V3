import React, { useMemo } from 'react';
import { StarSystem } from '../../types';
import { useI18n } from '../../i18n';

interface SystemInspectorModalProps {
  system: StarSystem;
  onClose: () => void;
}

const format = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : '—');

const SystemInspectorModal: React.FC<SystemInspectorModalProps> = ({ system, onClose }) => {
  const { t } = useI18n();
  const astro = system.astro;

  const planets = useMemo(() => {
    if (!astro?.planets) return [];
    return [...astro.planets].sort((a, b) => a.semiMajorAxisAu - b.semiMajorAxisAu);
  }, [astro]);

  return (
    <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="bg-slate-900 text-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden border border-slate-700">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div>
            <div className="text-sm text-slate-300">{t('astro.inspectorTitle')}</div>
            <div className="text-2xl font-bold">{system.name}</div>
          </div>
          <button
            className="text-slate-300 hover:text-white transition-colors"
            onClick={onClose}
            aria-label={t('astro.close')}
          >
            ✕
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto max-h-[78vh]">
          {!astro ? (
            <div className="text-slate-400">{t('astro.noData')}</div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                  <div className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">{t('astro.title')}</div>
                  <div className="text-sm text-slate-200 flex justify-between">
                    <span>{t('astro.primary')}</span>
                    <span className="font-mono">{astro.primarySpectralType} • {astro.starCount}★</span>
                  </div>
                  <div className="text-sm text-slate-200 flex justify-between">
                    <span>{t('astro.planets')}</span>
                    <span className="font-mono">{astro.planets.length}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-300">
                    <div className="bg-slate-900/40 border border-slate-700 rounded p-2">
                      <div className="text-slate-500 uppercase text-[10px] font-bold">HZ</div>
                      <div className="font-mono">{format(astro.derived.hzInnerAu, 2)}–{format(astro.derived.hzOuterAu, 2)} AU</div>
                    </div>
                    <div className="bg-slate-900/40 border border-slate-700 rounded p-2">
                      <div className="text-slate-500 uppercase text-[10px] font-bold">Snow line</div>
                      <div className="font-mono">{format(astro.derived.snowLineAu, 2)} AU</div>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                  <div className="text-xs uppercase tracking-wider text-slate-400 font-bold mb-2">{t('astro.stars')}</div>
                  <div className="space-y-2">
                    {astro.stars.map((s, idx) => (
                      <div key={`${s.role}-${idx}`} className="bg-slate-900/40 border border-slate-700 rounded p-3">
                        <div className="flex justify-between items-center">
                          <div className="font-bold text-slate-100 uppercase text-xs">{s.role}</div>
                          <div className="font-mono text-xs text-slate-300">{s.spectralType}</div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mt-2 text-[11px] text-slate-300">
                          <div>Mass: <span className="font-mono">{format(s.massSun, 2)} M☉</span></div>
                          <div>Lum: <span className="font-mono">{format(s.luminositySun, 2)} L☉</span></div>
                          <div>Radius: <span className="font-mono">{format(s.radiusSun, 2)} R☉</span></div>
                          <div>Teff: <span className="font-mono">{format(s.teffK, 0)} K</span></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-lg font-semibold mb-3">{t('astro.planetsSection')}</div>
                {planets.length === 0 ? (
                  <div className="text-slate-400">—</div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {planets.map((p, idx) => (
                      <div key={`p-${idx}`} className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
                        <div className="flex justify-between items-center mb-2">
                          <div className="font-bold text-slate-100">#{idx + 1} {p.type}</div>
                          <div className="font-mono text-xs text-slate-300">a={format(p.semiMajorAxisAu, 2)} AU</div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-300">
                          <div>e: <span className="font-mono">{format(p.eccentricity, 2)}</span></div>
                          <div>g: <span className="font-mono">{format(p.gravityG, 2)} g</span></div>
                          <div>T: <span className="font-mono">{format(p.temperatureK, 0)} K</span></div>
                          <div>Atm: <span className="font-mono">{p.atmosphere}</span></div>
                        </div>
                        <div className="mt-3 bg-slate-900/40 border border-slate-700 rounded p-2">
                          <div className="text-[10px] uppercase font-bold text-slate-500">{t('astro.moons')}</div>
                          <div className="text-[11px] text-slate-300">
                            {p.moons.length === 0 ? '—' : p.moons.map((m, mIdx) => (
                              <span key={`m-${idx}-${mIdx}`} className="inline-block mr-2">
                                {m.type}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SystemInspectorModal;
