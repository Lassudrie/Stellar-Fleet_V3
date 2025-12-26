
import React, { useState } from 'react';
import { useI18n } from '../../i18n';

type NewGameScreenProps = {
  onBack: () => void;
  onLaunch: (seed: number) => void;
};

const NewGameScreen: React.FC<NewGameScreenProps> = ({ onBack, onLaunch }) => {
  const { t } = useI18n();
  const [seedInput, setSeedInput] = useState<string>('');

  const handleLaunch = () => {
    const parsedSeed = Number(seedInput);
    const seed = seedInput === '' || Number.isNaN(parsedSeed) ? Date.now() : parsedSeed;
    onLaunch(seed);
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950 text-white animate-in slide-in-from-right duration-300">
      <div className="w-full max-w-md p-8 bg-slate-900/50 border border-slate-800 rounded-lg backdrop-blur-sm">
        <h2 className="text-3xl font-bold mb-2 text-blue-400 uppercase tracking-wide">{t('newgame.title')}</h2>
        <p className="text-slate-500 text-sm mb-8">{t('newgame.subtitle')}</p>

        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-xs uppercase font-bold text-slate-400 tracking-wider">{t('scenario.seed')}</label>
            <input 
              type="number" 
              placeholder={t('scenario.random')}
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value)}
              className="w-full bg-black/40 border border-slate-700 text-white px-4 py-3 rounded focus:outline-none focus:border-blue-500 font-mono"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs uppercase font-bold text-slate-400 tracking-wider">{t('newgame.faction')}</label>
            <div className="p-3 bg-blue-900/20 border border-blue-500/30 rounded text-blue-200 text-sm font-bold flex items-center gap-2">
              <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
              UNITED EARTH FLEET (BLUE)
            </div>
          </div>

          <div className="flex gap-4 pt-4">
            <button 
              onClick={onBack}
              className="flex-1 px-6 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold uppercase text-sm rounded transition-colors"
            >
              {t('newgame.cancel')}
            </button>
            <button 
              onClick={handleLaunch}
              className="flex-1 px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold uppercase text-sm rounded shadow-[0_0_15px_rgba(37,99,235,0.4)] transition-all hover:scale-[1.02]"
            >
              {t('newgame.launch')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NewGameScreen;
