
import React from 'react';
import { useI18n } from '../../i18n';

type LoadingStatus = 'loading' | 'error' | 'done';

type LoadingScreenProps = {
  progress: number | null;
  stageLabel?: string | null;
  detail?: string | null;
  status?: LoadingStatus;
  errorMessage?: string | null;
  onBack?: () => void;
};

const clampProgress = (value: number) => Math.max(0, Math.min(1, value));

const LoadingScreen: React.FC<LoadingScreenProps> = ({
  progress,
  stageLabel,
  detail,
  status = 'loading',
  errorMessage,
  onBack
}) => {
  const { t } = useI18n();
  const isError = status === 'error';
  const normalizedProgress = progress === null ? null : clampProgress(progress);
  const percent = normalizedProgress === null ? null : Math.round(normalizedProgress * 100);
  const resolvedStageLabel = stageLabel ?? t('loading.init');

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

         {isError ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="text-sm font-bold uppercase tracking-[0.3em] text-red-400">
              {t('loading.error.title')}
            </div>
            <p className="text-xs text-slate-400 max-w-xs">{t('loading.error.subtitle')}</p>
            {errorMessage ? (
              <p className="text-xs text-slate-500 max-w-sm break-words">{errorMessage}</p>
            ) : null}
            {onBack ? (
              <button
                onClick={onBack}
                className="mt-2 rounded border border-slate-600 bg-slate-900/70 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-slate-200 transition hover:border-blue-400 hover:text-white"
              >
                {t('loading.error.back')}
              </button>
            ) : null}
          </div>
         ) : (
          <div className="flex flex-col items-center gap-4">
             {/* Progress Bar Container */}
             <div
               className="w-56 h-2 bg-slate-800 rounded-full overflow-hidden relative"
               role="progressbar"
               aria-valuemin={percent === null ? undefined : 0}
               aria-valuemax={percent === null ? undefined : 100}
               aria-valuenow={percent === null ? undefined : percent}
               aria-valuetext={
                 percent === null
                   ? t('loading.indeterminate')
                   : t('loading.percent', { p: percent })
               }
               aria-label={resolvedStageLabel}
             >
                {percent === null ? (
                  <div className="absolute top-0 left-0 bottom-0 bg-blue-500 w-1/3 animate-[slideInFromLeft_1s_infinite_linear] rounded-full shadow-[0_0_10px_rgba(59,130,246,0.8)]"></div>
                ) : (
                  <div
                    className="absolute top-0 left-0 bottom-0 bg-gradient-to-r from-blue-400 to-blue-600 rounded-full shadow-[0_0_12px_rgba(59,130,246,0.7)]"
                    style={{ width: `${percent}%` }}
                  />
                )}
             </div>
             
             <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce"></div>
                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:0.1s]"></div>
                <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                <span className="text-xs font-mono text-slate-500 uppercase tracking-widest ml-2">
                  {resolvedStageLabel}
                </span>
                {percent !== null ? (
                  <span className="text-xs font-mono text-slate-600">{t('loading.percent', { p: percent })}</span>
                ) : null}
             </div>
             {detail ? (
               <div className="text-[10px] text-slate-600 font-mono uppercase tracking-widest">{detail}</div>
             ) : null}
          </div>
         )}
         
         <div className="absolute bottom-8 text-[10px] text-slate-700 font-mono">
            {t('loading.version')}
         </div>
      </div>
    </div>
  );
};

export default LoadingScreen;
