
import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { planAiTurn } from '../../ai';
import { applyCommand } from '../../commands';

export const phaseAI = (state: GameState, ctx: TurnContext): GameState => {
    if (!state.rules.aiEnabled) return state;

    const aiFactions = state.factions
        .filter(faction => faction.aiProfile)
        .sort((a, b) => a.id.localeCompare(b.id));

    let nextState = state;

    for (const faction of aiFactions) {
        const existingAiState = state.aiStates?.[faction.id] || state.aiState;

        const commands = planAiTurn(nextState, faction.id, existingAiState, ctx.rng);

        for (const cmd of commands) {
            nextState = applyCommand(nextState, cmd, ctx.rng);
        }
    }

    return nextState;
};
