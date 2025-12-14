
import React, { useRef } from 'react';
import { useI18n } from '../../i18n';

type LoadGameScreenProps = {
  onBack: () => void;
  onLoad: (file: File) => void;
};

const LoadGameScreen: React.FC<LoadGameScreenProps> = ({ onBack, onLoad }) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onLoad(e.target.files[0]);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950 text-white animate-in slide-in-from-right duration-300">
      <div className="w-full max-w-md p-8 bg-slate-900/50 border border-slate-800 rounded-lg backdrop-blur-sm text-center space-y-8">
        <h2 className="text-3xl font-bold text-blue-400 uppercase tracking-wide">{t('load.title')}</h2>
        
        <div className="p-6 border-2 border-dashed border-slate-700 rounded-lg bg-slate-900/30 flex flex-col items-center justify-center gap-4 hover:border-blue-500/50 transition-colors">
           <p className="text-slate-400 text-sm">Select a .json save file to continue your campaign.</p>
           
           <input 
              type="file" 
              ref={fileInputRef}
              onChange={handleFileChange}
              accept=".json"
              className="hidden"
           />
           
           <button 
              onClick={() => fileInputRef.current?.click()}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white font-bold uppercase text-sm rounded shadow-[0_0_15px_rgba(37,99,235,0.4)] transition-all"
           >
              {t('sidemenu.import')}
           </button>
        </div>

        <button 
          onClick={onBack}
          className="px-8 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold uppercase tracking-wider rounded transition-colors text-sm"
        >
          {t('screen.return')}
        </button>
      </div>
    </div>
  );
};

export default LoadGameScreen;
