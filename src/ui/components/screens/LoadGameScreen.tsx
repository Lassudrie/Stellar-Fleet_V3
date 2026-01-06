
import React, { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n';

type LoadGameScreenProps = {
  onBack: () => void;
  onLoad: (file: File) => void;
};

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

const getFocusableElements = (container: HTMLElement | null): HTMLElement[] => {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
};

const trapFocus = (event: React.KeyboardEvent, container: HTMLElement | null): void => {
  if (event.key !== 'Tab') return;
  const focusable = getFocusableElements(container);
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement as HTMLElement | null;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

const LoadGameScreen: React.FC<LoadGameScreenProps> = ({ onBack, onLoad }) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = 'load-game-title';
  const instructionId = 'load-game-instructions';

  useEffect(() => {
    if (typeof document === 'undefined') return;
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    const timer = setTimeout(() => {
      (primaryButtonRef.current ?? dialogRef.current)?.focus();
    }, 0);
    return () => {
      clearTimeout(timer);
      lastFocusedRef.current?.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onBack();
      return;
    }
    trapFocus(event, dialogRef.current);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onLoad(e.target.files[0]);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950 text-white animate-in slide-in-from-right duration-300">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={instructionId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-full max-w-md p-8 bg-slate-900/50 border border-slate-800 rounded-lg backdrop-blur-sm text-center space-y-8"
      >
        <h2 id={titleId} className="text-3xl font-bold text-blue-400 uppercase tracking-[0.2em]">{t('load.title')}</h2>
        
        <div className="p-6 border-2 border-dashed border-slate-700 rounded-lg bg-slate-900/30 flex flex-col items-center justify-center gap-4 hover:border-blue-500/50 transition-colors">
           <p id={instructionId} className="text-slate-300 text-sm leading-relaxed">{t('load.instructions')}</p>
           
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
              ref={primaryButtonRef}
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
