import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ScenarioTemplate } from '../../scenarios/templates';
import { useGameStore } from '../../stores/gameStore';

export const ScenarioSelectScreen: React.FC = () => {
  const { t } = useTranslation();
  const { startScenario } = useGameStore();

  const templates = useMemo(() => ScenarioTemplate.getAll(), []);
  const [selectedId, setSelectedId] = React.useState<string>(templates[0]?.id ?? '');

  const selectedTemplate = useMemo(() => templates.find(tpl => tpl.id === selectedId) ?? templates[0], [templates, selectedId]);

  if (!selectedTemplate) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400">
        {t('scenario.none')}
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col md:flex-row">
      {/* Left list */}
      <div className="w-full md:w-1/3 border-r border-slate-800 overflow-y-auto">
        <div className="p-4 border-b border-slate-800">
          <h2 className="text-lg font-bold text-slate-200">{t('scenario.select')}</h2>
          <div className="text-xs text-slate-400 mt-1">{t('scenario.select_hint')}</div>
        </div>

        <div className="p-2">
          {templates.map(tpl => {
            const active = tpl.id === selectedTemplate.id;
            return (
              <button
                key={tpl.id}
                className={`w-full text-left px-3 py-3 rounded mb-1 border ${
                  active ? 'border-slate-600 bg-slate-900' : 'border-slate-800 bg-slate-950 hover:bg-slate-900'
                }`}
                onClick={() => setSelectedId(tpl.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-bold text-slate-200">{tpl.name}</div>
                  <div className="text-xs text-slate-500">v{tpl.version}</div>
                </div>
                <div className="text-xs text-slate-400 mt-1 line-clamp-2">{tpl.description}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right details */}
      <div className="w-full md:w-2/3 p-4 md:p-6 overflow-y-auto">
        <div className="max-w-3xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold text-slate-100">{selectedTemplate.name}</h1>
              <p className="text-sm text-slate-400 mt-2">{selectedTemplate.description}</p>
            </div>

            <button
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded"
              onClick={() => startScenario(selectedTemplate.id)}
            >
              {t('scenario.start')}
            </button>
          </div>

          <div className="mt-6">
            <div className="text-xs text-slate-500 uppercase font-bold mb-2">{t('scenario.rules')}</div>

            <div className="flex gap-2 mb-4 md:mb-6">
              {selectedTemplate.rules.fogOfWar && (
                <span className="px-2 py-1 bg-slate-800 text-slate-300 text-[10px] font-bold uppercase rounded border border-slate-700">{t('scenario.fog')}</span>
              )}
              {selectedTemplate.rules.aiEnabled && (
                <span className="px-2 py-1 bg-slate-800 text-slate-300 text-[10px] font-bold uppercase rounded border border-slate-700">{t('scenario.ai')}</span>
              )}
              {selectedTemplate.rules.totalWar && (
                <span className="px-2 py-1 bg-slate-800 text-slate-300 text-[10px] font-bold uppercase rounded border border-slate-700">{t('scenario.total_war')}</span>
              )}
              {selectedTemplate.rules.groundCombat?.enabled && (
                <span className="px-2 py-1 bg-slate-800 text-slate-300 text-[10px] font-bold uppercase rounded border border-slate-700">
                  {t('scenario.groundCombat', { defaultValue: 'Ground Combat' })}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 bg-slate-950 border border-slate-800 rounded">
                <div className="text-xs text-slate-500 uppercase font-bold">{t('scenario.factions')}</div>
                <div className="mt-2 text-sm text-slate-300">
                  {selectedTemplate.factions.map(f => (
                    <div key={f.id} className="flex items-center gap-2 mb-1">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: f.color }} />
                      <span className="font-bold">{f.name}</span>
                      <span className="text-xs text-slate-500">{f.aiControlled ? t('scenario.ai_controlled') : t('scenario.player_controlled')}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 bg-slate-950 border border-slate-800 rounded">
                <div className="text-xs text-slate-500 uppercase font-bold">{t('scenario.systems')}</div>
                <div className="mt-2 text-sm text-slate-300">
                  <div className="text-slate-400">{t('scenario.system_count', { count: selectedTemplate.systems.length })}</div>
                  <div className="text-slate-400 mt-1">{t('scenario.fleet_count', { count: selectedTemplate.fleets.length })}</div>
                  {selectedTemplate.armies && (
                    <div className="text-slate-400 mt-1">{t('scenario.army_count', { count: selectedTemplate.armies.length })}</div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 text-xs text-slate-500">
              {t('scenario.tip')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
