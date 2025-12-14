
import React from 'react';
import { useI18n } from '../../i18n';

type OptionsScreenProps = {
  onBack: () => void;
};

const OptionsScreen: React.FC<OptionsScreenProps> = ({ onBack }) => {
  const { t, locale, setLocale } = useI18n();

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950 text-white animate-in slide-in-from-right duration-300">
      <div className="w-full max-w-md p-8 bg-slate-900/50 border border-slate-800 rounded-lg backdrop-blur-sm">
        <h2 className="text-3xl font-bold text-slate-300 uppercase mb-8 text-center">{t('options.title')}</h2>
        
        {/* Language Selection */}
        <div className="flex items-center justify-between mb-8 p-4 bg-slate-800/50 rounded-lg">
            <span className="text-sm font-bold uppercase text-slate-400">{t('sidemenu.language')}</span>
            <div className="flex gap-2">
                <button 
                    onClick={() => setLocale('en')}
                    className={`px-4 py-2 rounded text-sm font-bold transition-all ${locale === 'en' ? 'bg-blue-600 text-white shadow' : 'bg-slate-700 text-slate-400 hover:text-white'}`}
                >
                    ENGLISH
                </button>
                <button 
                    onClick={() => setLocale('fr')}
                    className={`px-4 py-2 rounded text-sm font-bold transition-all ${locale === 'fr' ? 'bg-blue-600 text-white shadow' : 'bg-slate-700 text-slate-400 hover:text-white'}`}
                >
                    FRANÇAIS
                </button>
            </div>
        </div>

        <div className="text-center space-y-6">
            <div className="p-4 border border-slate-800 bg-slate-900/50 rounded text-slate-500 font-mono text-xs">
                {t('screen.underConstruction')}
            </div>
            <button 
            onClick={onBack}
            className="w-full px-8 py-3 bg-slate-800 hover:bg-slate-700 text-white font-bold uppercase tracking-wider rounded transition-colors"
            >
            {t('screen.return')}
            </button>
        </div>
      </div>
    </div>
  );
};

export default OptionsScreen;
