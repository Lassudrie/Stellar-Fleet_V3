
import React from 'react';
import { useI18n } from '../../i18n';

const LoadingScreen: React.FC = () => {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 z-[100] bg-slate-950 flex flex-col items-center justify-center select-none pointer-events-auto">
      <div className="flex flex-col items-center animate-in fade-in zoom-in-95 duration-500">
         {/* Logo / Title Area */}
         <div className="mb-10 relative text-center">
            {/* Background Glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-blue-600/20 blur-3xl rounded-full animate-pulse"></div>
            
            <h1 className="relative text-6xl md:text-8xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-600 uppercase drop-shadow-2xl">
              Stellar
            </h1>
            <h2 className="text-blue-500 text-2xl md:text-3xl tracking-[0.6em] font-bold uppercase -mt-2 md:-mt-4 ml-2">
              Fleet
            </h2>
         </div>

         {/* Loader Indicator */}
         <div className="flex flex-col items-center gap-4">
             {/* Progress Bar Container */}
             <div className="w-48 h-1 bg-slate-800 rounded-full overflow-hidden relative">
                {/* Indeterminate Loading Bar Animation */}
                <div className="absolute top-0 left-0 bottom-0 bg-blue-500 w-1/3 animate-[slideInFromLeft_1s_infinite_linear] rounded-full shadow-[0_0_10px_rgba(59,130,246,0.8)]"></div>
             </div>
             
             <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce"></div>
                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:0.1s]"></div>
                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                <span className="text-xs font-mono text-slate-500 uppercase tracking-widest ml-2">{t('loading.init')}</span>
             </div>
         </div>
         
         <div className="absolute bottom-8 text-[10px] text-slate-700 font-mono">
            {t('loading.version')}
         </div>
      </div>
    </div>
  );
};

export default LoadingScreen;
