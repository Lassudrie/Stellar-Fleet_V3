
import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { planAiTurn } from '../../ai';
import { applyCommand } from '../../commands';

export const phaseAI = (state: GameState, ctx: TurnContext): GameState => {
    if (!state.rules.aiEnabled) return state;

    // 1. Generate Commands for Red Faction
    // Uses current state (after battle resolution)
    // Assuming 'red' is the AI faction for now, based on legacy logic
    const commands = planAiTurn(state, 'red', state.aiState, ctx.rng);
    
    // 2. Apply Commands Sequentially
    let nextState = state;
    for (const cmd of commands) {
        nextState = applyCommand(nextState, cmd, ctx.rng);
    }
    
    return nextState;
};
