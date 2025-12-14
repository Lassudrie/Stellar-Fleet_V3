
import React from 'react';
import { FactionId } from '../../types';
import { useI18n } from '../../i18n';

interface VictoryScreenProps {
  winner: FactionId;
  playerFactionId: string;
  day: number;
  onRestart: () => void;
}

const VictoryScreen: React.FC<VictoryScreenProps> = ({ winner, playerFactionId, day, onRestart }) => {
  const { t } = useI18n();
  const isPlayerWinner = winner === playerFactionId;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-auto">
      <div className="bg-slate-900 border border-slate-700 p-8 rounded-xl text-center shadow-2xl">
        <h1 className={`text-5xl font-bold mb-4 ${isPlayerWinner ? 'text-blue-500' : 'text-red-500'}`}>
          {isPlayerWinner ? t('victory.victory') : t('victory.defeat')}
        </h1>
        <p className="mb-6 text-slate-400">{t('victory.totalTurns', { day })}</p>
        <button onClick={onRestart} className="mt-4 px-6 py-3 bg-white text-black font-bold rounded hover:scale-105 transition">
          {t('victory.replay')}
        </button>
      </div>
    </div>
  );
};

export default VictoryScreen;
