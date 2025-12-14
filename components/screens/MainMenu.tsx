
import React from 'react';
import { useI18n } from '../../i18n';

type MainMenuProps = {
  onNavigate: (screen: 'SCENARIO' | 'LOAD_GAME' | 'OPTIONS') => void;
};

const MainMenu: React.FC<MainMenuProps> = ({ onNavigate }) => {
  const { t } = useI18n();

  return (
    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-slate-950 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black select-none">
      
      {/* Background Decor */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-blue-600/10 blur-[100px] rounded-full animate-pulse"></div>
      </div>

      <div className="z-10 flex flex-col items-center gap-12 animate-in fade-in zoom-in-95 duration-700">
        {/* Title */}
        <div className="text-center space-y-2">
          <h1 className="text-7xl md:text-9xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-white to-slate-500 uppercase drop-shadow-2xl">
            {t('menu.title')}
          </h1>
          <h2 className="text-blue-500 text-3xl md:text-4xl tracking-[0.5em] font-bold uppercase ml-4">
            {t('menu.subtitle')}
          </h2>
        </div>

        {/* Menu Buttons */}
        <div className="flex flex-col gap-4 w-64 md:w-80">
          <MenuButton onClick={() => onNavigate('SCENARIO')} label={t('menu.newGame')} primary />
          <MenuButton onClick={() => onNavigate('LOAD_GAME')} label={t('menu.loadGame')} />
          <MenuButton onClick={() => onNavigate('OPTIONS')} label={t('menu.options')} />
        </div>

        <div className="text-slate-600 text-xs font-mono uppercase tracking-widest mt-8">
          {t('menu.systemReady')} • v1.1
        </div>
      </div>
    </div>
  );
};

const MenuButton: React.FC<{ onClick: () => void; label: string; primary?: boolean }> = ({ onClick, label, primary }) => (
  <button
    onClick={onClick}
    className={`
      relative group overflow-hidden px-8 py-4 w-full text-center transition-all duration-300
      border border-slate-800 rounded-sm hover:border-blue-500/50
      ${primary 
        ? 'bg-blue-900/20 text-white hover:bg-blue-800/30' 
        : 'bg-slate-900/40 text-slate-300 hover:bg-slate-800/60 hover:text-white'
      }
    `}
  >
    <div className={`absolute left-0 top-0 bottom-0 w-1 bg-blue-500 transition-all duration-300 ${primary ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} />
    <span className="relative z-10 font-bold tracking-widest uppercase text-sm group-hover:tracking-[0.2em] transition-all">
      {label}
    </span>
  </button>
);

export default MainMenu;
