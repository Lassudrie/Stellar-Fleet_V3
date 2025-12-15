
import { GameState, FactionId, AIState } from '../../../types';
import { TurnContext } from '../types';
import { resolveGroundConflict } from '../../conquest';
import { COLORS } from '../../../data/static';
import { AI_HOLD_TURNS } from '../../ai';

export const phaseGround = (state: GameState, ctx: TurnContext): GameState => {
    let nextSystems = [...state.systems];
    let nextLogs = [...state.logs];
    let nextAiStates = state.aiStates;

    const aiFactionIds = new Set(state.factions.filter(faction => faction.aiProfile).map(faction => faction.id));
    const holdUpdates: Record<FactionId, string[]> = {};
    
    // Track armies to remove (destroyed)
    const armiesToDestroyIds = new Set<string>();
    
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
            if (aiFactionIds.has(result.winnerFactionId)) {
                if (!holdUpdates[result.winnerFactionId]) {
                    holdUpdates[result.winnerFactionId] = [];
                }
                holdUpdates[result.winnerFactionId].push(system.id);
            }

            return {
                ...system,
                ownerFactionId: result.winnerFactionId,
                color: result.winnerFactionId === 'blue' ? COLORS.blue : COLORS.red
            };
        }
        
        return system;
    });

    // 2. Filter Destroyed Armies
    let nextArmies = state.armies;
    if (armiesToDestroyIds.size > 0) {
        nextArmies = state.armies.filter(a => !armiesToDestroyIds.has(a.id));
    }

    if (Object.keys(holdUpdates).length > 0) {
        nextAiStates = { ...(state.aiStates || {}) };

        Object.entries(holdUpdates).forEach(([factionId, systemIds]) => {
            const existingState: AIState = nextAiStates?.[factionId] || state.aiState || {
                sightings: {},
                targetPriorities: {},
                systemLastSeen: {},
                lastOwnerBySystemId: {},
                holdUntilTurnBySystemId: {}
            };

            const updatedState: AIState = {
                ...existingState,
                holdUntilTurnBySystemId: {
                    ...existingState.holdUntilTurnBySystemId,
                    ...systemIds.reduce<Record<string, number>>((acc, systemId) => {
                        acc[systemId] = state.day + AI_HOLD_TURNS;
                        return acc;
                    }, {})
                }
            };

            nextAiStates![factionId] = updatedState;
        });
    }

    return {
        ...state,
        systems: nextSystems,
        armies: nextArmies,
        logs: nextLogs,
        aiStates: nextAiStates
    };
};
