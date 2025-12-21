
import { GameState, FactionId, AIState } from '../../../types';
import { TurnContext } from '../types';
import { createEmptyAIState, getLegacyAiFactionId, planAiTurn } from '../../ai';
import { applyCommand } from '../../commands';

export const phaseAI = (state: GameState, ctx: TurnContext): GameState => {
    if (!state.rules.aiEnabled) return state;

    const currentTurnState = state.day === ctx.turn ? state : { ...state, day: ctx.turn };

    const aiFactions = state.factions
        .filter(faction => faction.aiProfile)
        .sort((a, b) => a.id.localeCompare(b.id));

    const ensuredAiStates: Record<FactionId, AIState> = { ...(currentTurnState.aiStates ?? {}) };
    const legacyAiFactionId = getLegacyAiFactionId(currentTurnState.factions);

    aiFactions.forEach(faction => {
        if (!ensuredAiStates[faction.id]) {
            const legacyState = faction.id === legacyAiFactionId ? state.aiState : undefined;
            ensuredAiStates[faction.id] = legacyState ?? createEmptyAIState();
        }
    });

    let nextState: GameState = { ...currentTurnState, aiStates: ensuredAiStates };

    for (const faction of aiFactions) {
        const existingAiState = (nextState.aiStates ?? ensuredAiStates)[faction.id] ?? createEmptyAIState();

        const commands = planAiTurn(nextState, faction.id, existingAiState, ctx.rng);

        for (const cmd of commands) {
            const updatedState = applyCommand(nextState, cmd, ctx.rng);
            nextState = updatedState.day === ctx.turn ? updatedState : { ...updatedState, day: ctx.turn };
        }
    }

    const mergedAiStates = { ...ensuredAiStates, ...(nextState.aiStates ?? {}) };

    const alignedState = nextState.day === ctx.turn ? nextState : { ...nextState, day: ctx.turn };

    return { ...alignedState, aiStates: mergedAiStates };
};
