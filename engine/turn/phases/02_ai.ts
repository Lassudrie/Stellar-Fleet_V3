
import { GameState, FactionId, AIState } from '../../../types';
import { TurnContext } from '../types';
import { createEmptyAIState, getLegacyAiFactionId, planAiTurn } from '../../ai';
import { applyCommand } from '../../commands';

export const phaseAI = (state: GameState, ctx: TurnContext): GameState => {
    if (!state.rules.aiEnabled) return state;

    const aiFactions = state.factions
        .filter(faction => faction.aiProfile)
        .sort((a, b) => a.id.localeCompare(b.id));

    const ensuredAiStates: Record<FactionId, AIState> = { ...(state.aiStates ?? {}) };
    const legacyAiFactionId = getLegacyAiFactionId(state.factions);

    aiFactions.forEach(faction => {
        if (!ensuredAiStates[faction.id]) {
            const legacyState = faction.id === legacyAiFactionId ? state.aiState : undefined;
            ensuredAiStates[faction.id] = legacyState ?? createEmptyAIState();
        }
    });

    let nextState: GameState = { ...state, aiStates: ensuredAiStates };

    for (const faction of aiFactions) {
        const existingAiState = (nextState.aiStates ?? ensuredAiStates)[faction.id] ?? createEmptyAIState();

        const commands = planAiTurn(nextState, faction.id, existingAiState, ctx.rng);

        for (const cmd of commands) {
            nextState = applyCommand(nextState, cmd, ctx.rng);
        }
    }

    const mergedAiStates = { ...ensuredAiStates, ...(nextState.aiStates ?? {}) };

    return { ...nextState, aiStates: mergedAiStates };
};
