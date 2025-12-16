
import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { pruneBattles } from '../../../services/battle/detection';
import { sanitizeArmyLinks } from '../../army';

export const phaseCleanup = (state: GameState, ctx: TurnContext): GameState => {
    // 1. Prune Old Battles
    const activeBattles = pruneBattles(state.battles, state.day);
    
    // 2. Sanitize Armies (Remove orphans, fix references)
    // Note: We use a temp state with pruned battles to ensure army logic has fresh context
    const { state: sanitizedArmyState, logs: sanitizationLogs } = sanitizeArmyLinks({ ...state, battles: activeBattles });

    // 3. Add Tech Logs
    const newLogs = [...sanitizedArmyState.logs];
    sanitizationLogs.forEach(txt => {
        newLogs.push({
            id: ctx.rng.id('log'),
            day: state.day,
            text: `[SYSTEM] ${txt}`,
            type: 'info'
        });
    });

    return {
        ...sanitizedArmyState,
        battles: activeBattles,
        logs: newLogs
    };
};
