
import { GameState, FleetState } from '../../../types';
import { TurnContext } from '../types';
import { detectNewBattles } from '../../../services/battle/detection';

export const phaseBattleDetection = (state: GameState, ctx: TurnContext): GameState => {
    // Only detect if advanced combat is enabled
    if (!state.rules.useAdvancedCombat) return state;

    // 1. Detect New Battles based on positions
    const newBattles = detectNewBattles(state, ctx.rng);
    
    if (newBattles.length === 0) return state;

    // 2. Collect IDs of all fleets engaged
    const involvedFleetIds = new Set<string>();
    newBattles.forEach(b => b.involvedFleetIds.forEach(id => involvedFleetIds.add(id)));

    // 3. Update Fleets to COMBAT state
    // This locks them from moving next turn until resolved
    const nextFleets = state.fleets.map(f => {
        if (involvedFleetIds.has(f.id)) {
            // Force stop movement
            return { 
                ...f, 
                state: FleetState.COMBAT, 
                stateStartTurn: state.day, // Mark conflict start
                targetSystemId: null,
                targetPosition: null
            };
        }
        return f;
    });

    return {
        ...state,
        fleets: nextFleets,
        battles: [...state.battles, ...newBattles]
    };
};
