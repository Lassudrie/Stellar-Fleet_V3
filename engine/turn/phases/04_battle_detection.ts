
import { GameState, FleetState, LogEntry } from '../../../types';
import { TurnContext } from '../types';
import { detectNewBattles } from '../../systems/battle/detection';

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

    // 4. Generate combat scheduled logs (for UI alerts)
    // Sort by systemId for deterministic log order
    const sortedBattles = [...newBattles].sort((a, b) => a.systemId.localeCompare(b.systemId));
    const newLogs: LogEntry[] = sortedBattles.map(battle => {
        const systemName = state.systems.find(s => s.id === battle.systemId)?.name || 'Unknown';
        return {
            id: ctx.rng.id('log'),
            day: state.day,
            text: `Battle scheduled at ${systemName}. Fleets engaged: ${battle.involvedFleetIds.length}.`,
            type: 'combat' as const
        };
    });

    return {
        ...state,
        fleets: nextFleets,
        battles: [...state.battles, ...newBattles],
        logs: [...state.logs, ...newLogs]
    };
};
