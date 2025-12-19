import { Battle, FactionId } from '../../types';

export type FactionRegistry = Record<string, { name: string; color: string }>;

export interface BattleOutcome {
    label: string;
    color: string;
    winnerName: string | null;
    status: 'victory' | 'defeat' | 'draw' | 'unknown';
}

export type TranslateFn = (key: string, params?: Record<string, string | number | undefined>) => string;

const fallbackFactionMeta = (factionId: string | undefined, registry: FactionRegistry) => {
    if (!factionId) {
        return { name: 'UNKNOWN', color: '#94a3b8' };
    }

    return registry[factionId] || { name: factionId.toUpperCase(), color: '#94a3b8' };
};

export const resolveBattleOutcome = (
    battle: Battle,
    playerFactionId: FactionId,
    registry: FactionRegistry,
    translate: TranslateFn
): BattleOutcome => {
    if (!battle.winnerFactionId) {
        return { label: translate('battle.unknown'), color: '#cbd5e1', winnerName: null, status: 'unknown' };
    }

    if (battle.winnerFactionId === 'draw') {
        return { label: translate('battle.draw'), color: '#94a3b8', winnerName: null, status: 'draw' };
    }

    const winnerMeta = fallbackFactionMeta(battle.winnerFactionId, registry);
    const isPlayerVictory = battle.winnerFactionId === playerFactionId;

    return {
        label: translate('battle.victory', { winner: winnerMeta.name }),
        color: winnerMeta.color,
        winnerName: winnerMeta.name,
        status: isPlayerVictory ? 'victory' : 'defeat'
    };
};
