
import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { pruneBattles } from '../../../services/battle/detection';
import { sanitizeArmyLinks } from '../../army';

const LOG_RETENTION_LIMIT = 2000;

const trimLogs = (logs: GameState['logs']): GameState['logs'] => {
    if (logs.length <= LOG_RETENTION_LIMIT) return logs;
    return logs.slice(-LOG_RETENTION_LIMIT);
};

export const phaseCleanup = (state: GameState, ctx: TurnContext): GameState => {
    // 1. Prune Old Battles
    const activeBattles = pruneBattles(state.battles, ctx.turn);
    
    // 2. Sanitize Armies (Remove orphans, fix references)
    // Note: We use a temp state with pruned battles to ensure army logic has fresh context
    const { state: sanitizedArmyState, logs: sanitizationLogs } = sanitizeArmyLinks({ ...state, battles: activeBattles });

    // 3. Add Tech Logs
    const newLogs = [...sanitizedArmyState.logs];
    sanitizationLogs.forEach(txt => {
        newLogs.push({
            id: ctx.rng.id('log'),
            day: ctx.turn,
            text: `[SYSTEM] ${txt}`,
            type: 'info'
        });
    });

    return {
        ...sanitizedArmyState,
        battles: activeBattles,
        logs: trimLogs(newLogs)
    };
};
