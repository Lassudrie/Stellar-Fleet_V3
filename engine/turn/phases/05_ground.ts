
import { GameState, FactionId } from '../../../types';
import { TurnContext } from '../types';
import { resolveGroundConflict } from '../../conquest';
import { COLORS } from '../../../data/static';

export const phaseGround = (state: GameState, ctx: TurnContext): GameState => {
    let nextLogs = [...state.logs];
    
    // Track armies to remove (destroyed)
    const armiesToDestroyIds = new Set<string>();
    
    // Store system updates (systemId -> updated system)
    const systemUpdates = new Map<string, typeof state.systems[0]>();
    
    // 1. Resolve Conflict per System (sorted by ID for determinism)
    const sortedSystems = [...state.systems].sort((a, b) => a.id.localeCompare(b.id));
    
    for (const system of sortedSystems) {
        // Pure calculation based on current state
        const result = resolveGroundConflict(system, state);
        
        if (!result) continue;
        
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
            systemUpdates.set(system.id, {
                ...system,
                ownerFactionId: result.winnerFactionId,
                color: result.winnerFactionId === 'blue' ? COLORS.blue : COLORS.red
            });
        }
    }
    
    // Apply system updates (preserve original array order)
    const nextSystems = state.systems.map(system => 
        systemUpdates.get(system.id) || system
    );

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
