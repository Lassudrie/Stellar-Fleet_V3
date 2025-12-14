
import React, { useState } from 'react';
import { SCENARIO_TEMPLATES, buildScenario, ScenarioTemplate } from '../../scenarios';
import { GameScenario } from '../../scenarios/types';
import { useI18n } from '../../i18n';

interface ScenarioSelectScreenProps {
  onBack: () => void;
  onLaunch: (scenario: GameScenario) => void;
}

const ScenarioSelectScreen: React.FC<ScenarioSelectScreenProps> = ({ onBack, onLaunch }) => {
  const { t } = useI18n();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(SCENARIO_TEMPLATES[0].id);
  const [customSeed, setCustomSeed] = useState<string>('');

  const selectedTemplate = SCENARIO_TEMPLATES.find(t => t.id === selectedTemplateId) as ScenarioTemplate;

  const handleLaunch = () => {
    const seed = customSeed ? parseInt(customSeed, 10) || Date.now() : Date.now();
    const scenario = buildScenario(selectedTemplateId, seed);
    onLaunch(scenario);
  };

  const getScenarioTitle = (template: ScenarioTemplate) => t(`scenario.${template.id}.title`, { defaultValue: template.meta.title });
  const getScenarioDesc = (template: ScenarioTemplate) => t(`scenario.${template.id}.desc`, { defaultValue: template.meta.description });

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950 select-none animate-in fade-in duration-300">
      
      {/* Background Decor */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-20">
         <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-blue-900/20 blur-[120px] rounded-full"></div>
         <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-purple-900/10 blur-[100px] rounded-full"></div>
      </div>

      <div className="relative z-10 w-full max-w-5xl h-[85vh] flex flex-col md:flex-row bg-slate-900/80 border border-slate-800 rounded-xl shadow-2xl overflow-hidden backdrop-blur-sm">
        
        {/* LEFT COLUMN: LIST */}
        <div className="w-full md:w-1/3 border-r border-slate-800 flex flex-col bg-slate-950/50 shrink-0">
          <div className="p-4 md:p-6 border-b border-slate-800 flex justify-between items-center bg-slate-900/80">
            <div>
              <h2 className="text-lg md:text-xl font-bold text-white tracking-wider uppercase">{t('scenario.title')}</h2>
              <p className="text-[10px] md:text-xs text-slate-500 mt-1">{t('scenario.select')}</p>
            </div>
            
            {/* MOBILE QUICK LAUNCH BUTTON */}
            <button 
              onClick={handleLaunch}
              className="md:hidden bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded shadow-[0_0_15px_rgba(37,99,235,0.4)] uppercase text-xs font-bold tracking-widest active:scale-95 transition-transform flex items-center gap-2"
            >
              <span>{t('scenario.launch_short')}</span>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                <path fillRule="evenodd" d="M4.5 5.653c0-1.426 1.529-2.33 2.779-1.643l11.54 6.348c1.295.712 1.295 2.573 0 3.285L7.28 19.991c-1.25.687-2.779-.217-2.779-1.643V5.653z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1 min-h-[150px]">
            {SCENARIO_TEMPLATES.map(template => (
              <button
                key={template.id}
                onClick={() => setSelectedTemplateId(template.id)}
                className={`w-full text-left p-4 rounded-lg transition-all duration-200 border ${
                  selectedTemplateId === template.id 
                    ? 'bg-blue-900/20 border-blue-500/50 shadow-[inset_0_0_20px_rgba(59,130,246,0.1)]' 
                    : 'bg-transparent border-transparent hover:bg-slate-800/50 hover:border-slate-700'
                }`}
              >
                <div className={`font-bold text-sm mb-1 ${selectedTemplateId === template.id ? 'text-blue-300' : 'text-slate-300'}`}>
                  {getScenarioTitle(template)}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono">
                   <span>{template.generation.systemCount} {t('scenario.stars')}</span>
                   <span>•</span>
                   <span>R:{template.generation.radius}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="p-4 border-t border-slate-800 md:block hidden">
            <button 
              onClick={onBack}
              className="w-full py-3 rounded border border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors uppercase font-bold text-xs tracking-widest"
            >
              {t('scenario.back')}
            </button>
          </div>
        </div>

        {/* RIGHT COLUMN: DETAILS */}
        <div className="flex-1 flex flex-col p-6 md:p-8 relative overflow-y-auto custom-scrollbar bg-slate-900/30">
           {/* Header Info */}
           <div className="mb-6 md:mb-8">
              <h1 className="text-2xl md:text-4xl font-black text-white uppercase mb-2 tracking-tight">
                {getScenarioTitle(selectedTemplate)}
              </h1>
              <div className="flex gap-2 mb-4 md:mb-6">
                 {selectedTemplate.rules.fogOfWar && (
                   <span className="px-2 py-1 bg-slate-800 text-slate-300 text-[10px] font-bold uppercase rounded border border-slate-700">{t('scenario.fog')}</span>
                 )}
                 {selectedTemplate.rules.aiEnabled && (
                   <span className="px-2 py-1 bg-slate-800 text-slate-300 text-[10px] font-bold uppercase rounded border border-slate-700">{t('scenario.ai')}</span>
                 )}
              </div>
              <p className="text-slate-400 leading-relaxed text-sm max-w-lg border-l-2 border-blue-500/30 pl-4">
                {getScenarioDesc(selectedTemplate)}
              </p>
           </div>

           {/* Stats Grid */}
           <div className="grid grid-cols-2 gap-4 mb-8 max-w-md">
              <div className="bg-slate-800/30 p-4 rounded border border-slate-700/50">
                 <div className="text-[10px] text-slate-500 uppercase font-bold mb-1">{t('scenario.size')}</div>
                 <div className="text-xl md:text-2xl font-mono text-blue-200">{selectedTemplate.generation.systemCount} <span className="text-sm text-slate-600">{t('scenario.stars')}</span></div>
              </div>
              <div className="bg-slate-800/30 p-4 rounded border border-slate-700/50">
                 <div className="text-[10px] text-slate-500 uppercase font-bold mb-1">{t('scenario.radius')}</div>
                 <div className="text-xl md:text-2xl font-mono text-blue-200">{selectedTemplate.generation.radius} <span className="text-sm text-slate-600">LY</span></div>
              </div>
           </div>

           {/* Configuration */}
           <div className="mt-auto space-y-4 max-w-md pb-8 md:pb-0">
              <div className="space-y-2">
                <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                  {t('scenario.seed')}
                </label>
                <div className="flex gap-2">
                  <input 
                    type="number" 
                    placeholder={t('scenario.random')}
                    value={customSeed}
                    onChange={(e) => setCustomSeed(e.target.value)}
                    className="flex-1 bg-slate-950 border border-slate-700 text-white px-4 py-3 rounded focus:outline-none focus:border-blue-500 font-mono text-sm"
                  />
                  <button 
                    onClick={() => setCustomSeed(Math.floor(Math.random() * 999999).toString())}
                    className="px-4 py-3 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white border border-slate-700 rounded transition-colors"
                    title={t('scenario.random')}
                  >
                    🎲
                  </button>
                </div>
              </div>

              <button 
                onClick={handleLaunch}
                className="hidden md:block w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold uppercase tracking-widest rounded shadow-[0_0_20px_rgba(37,99,235,0.4)] hover:shadow-[0_0_30px_rgba(37,99,235,0.6)] transition-all transform hover:-translate-y-1 active:translate-y-0"
              >
                {t('scenario.launch')}
              </button>
              
              <button 
                onClick={onBack}
                className="md:hidden w-full py-3 rounded border border-slate-700 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors uppercase font-bold text-xs tracking-widest"
              >
                {t('scenario.back')}
              </button>
           </div>

           <div className="absolute top-1/2 right-[-100px] w-[300px] h-[300px] bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-full blur-3xl pointer-events-none"></div>
        </div>
      </div>
    </div>
  );
};

export default ScenarioSelectScreen;
