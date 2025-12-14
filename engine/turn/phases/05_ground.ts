
import { GameState, FactionId } from '../../../types';
import { TurnContext } from '../types';
import { resolveGroundConflict } from '../../conquest';
import { COLORS } from '../../../data/static';

export const phaseGround = (state: GameState, ctx: TurnContext): GameState => {
    let nextSystems = [...state.systems];
    let nextLogs = [...state.logs];
    
    // Track armies to remove (destroyed)
    const armiesToDestroyIds = new Set<string>();
    
    // Helper to get faction color
    const getFactionColor = (id: FactionId): string => {
        const f = state.factions.find(f => f.id === id);
        return f ? f.color : '#999999';
    };

    // 1. Resolve Conflict per System
    nextSystems = nextSystems.map(system => {
        // Pure calculation based on current state
        const result = resolveGroundConflict(system, state);
        
        if (!result) return system;
        
        // Queue destroyed armies
        result.armiesDestroyed.forEach(id => armiesToDestroyIds.add(id));
        
        // Add Logs
        result.logs.forEach(txt => {
            nextLogs.push({
                id: ctx.rng.id('log'),
                day: state.day,
                text: txt,
                type: 'combat'
            });
        });
        
        // Update Ownership
        if (result.conquestOccurred && result.winnerFactionId && result.winnerFactionId !== 'draw') {
            return {
                ...system,
                ownerFactionId: result.winnerFactionId,
                color: getFactionColor(result.winnerFactionId)
            };
        }
        
        return system;
    });

    // 2. Filter Destroyed Armies
    let nextArmies = state.armies;
    if (armiesToDestroyIds.size > 0) {
        nextArmies = state.armies.filter(a => !armiesToDestroyIds.has(a.id));
    }

    return {
        ...state,
        systems: nextSystems,
        armies: nextArmies,
        logs: nextLogs
    };
};
