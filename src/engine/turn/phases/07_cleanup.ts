
import { ArmyState, GameState } from '../../../shared/types';
import { TurnContext } from '../types';
import { pruneBattles } from '../../battle/detection';
import { sanitizeArmies } from '../../army';

const LOG_RETENTION_LIMIT = 2000;
const MESSAGE_RETENTION_LIMIT = 500;

const trimLogs = (logs: GameState['logs']): GameState['logs'] => {
    if (logs.length <= LOG_RETENTION_LIMIT) return logs;
    return logs.slice(-LOG_RETENTION_LIMIT);
};

const trimMessages = (messages: GameState['messages']): GameState['messages'] => {
    if (messages.length <= MESSAGE_RETENTION_LIMIT) return messages;
    return messages.slice(-MESSAGE_RETENTION_LIMIT);
};

export const phaseCleanup = (state: GameState, ctx: TurnContext): GameState => {
    // 1. Prune Old Battles
    const activeBattles = pruneBattles(state.battles, ctx.turn);
    const fleetIds = new Set(state.fleets.map(fleet => fleet.id));

    const carrierLossLogs: string[] = [];
    const armiesAfterFleetLoss = state.armies.filter(army => {
        if (army.state === ArmyState.EMBARKED && !fleetIds.has(army.containerId)) {
            carrierLossLogs.push(`Army ${army.id} removed after losing transport fleet ${army.containerId}.`);
            return false;
        }
        return true;
    });
    
    // 2. Sanitize Armies (Remove orphans, fix references)
    // Note: We use a temp state with pruned battles to ensure army logic has fresh context
    const { state: sanitizedArmyState, logs: sanitizationLogs } = sanitizeArmies({
        ...state,
        armies: armiesAfterFleetLoss,
        battles: activeBattles
    });

    // 3. Add Tech Logs
    const newLogs = [...sanitizedArmyState.logs];
    [...carrierLossLogs, ...sanitizationLogs].forEach(txt => {
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
        logs: trimLogs(newLogs),
        messages: trimMessages(sanitizedArmyState.messages)
    };
};
