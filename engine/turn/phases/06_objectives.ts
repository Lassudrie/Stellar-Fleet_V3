
import { GameState } from '../../../types';
import { TurnContext } from '../types';
import { checkVictoryConditions } from '../../objectives';

export const phaseObjectives = (state: GameState, ctx: TurnContext): GameState => {
    if (state.winnerFactionId) return state; // Already decided

    const winnerFactionId = checkVictoryConditions(state);
    
    if (winnerFactionId) {
        return { ...state, winnerFactionId };
    }
    
    return state;
};
