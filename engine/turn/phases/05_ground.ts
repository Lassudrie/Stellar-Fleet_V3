
import { GameState, FactionId, AIState, Army } from '../../../types';
import { TurnContext } from '../types';
import { resolveGroundConflict } from '../../conquest';
import { COLORS } from '../../../data/static';
import { AI_HOLD_TURNS, createEmptyAIState } from '../../ai';

export const phaseGround = (state: GameState, ctx: TurnContext): GameState => {
    let nextSystems = [...state.systems];
    let nextLogs = [...state.logs];
    let nextAiStates: Record<FactionId, AIState> = { ...(state.aiStates ?? {}) };

    const aiFactionIds = new Set(state.factions.filter(faction => faction.aiProfile).map(faction => faction.id));

    aiFactionIds.forEach(factionId => {
        if (!nextAiStates[factionId]) {
            const legacyState = factionId === 'red' ? state.aiState : undefined;
            nextAiStates[factionId] = legacyState ?? createEmptyAIState();
        }
    });

    const holdUpdates: Record<FactionId, string[]> = {};

    // Track armies to remove (destroyed)
    const armiesToDestroyIds = new Set<string>();

    // Track strength/morale updates for surviving armies
    const armyUpdatesMap = new Map<string, { strength: number; morale: number }>();
    
    // 1. Resolve Conflict per System
    nextSystems = nextSystems.map(system => {
        // Pure calculation based on current state
        const result = resolveGroundConflict(system, state);

        if (!result) return system;

        // Queue destroyed armies
        result.armiesDestroyed.forEach(id => armiesToDestroyIds.add(id));

        // Queue army stat updates
        result.armyUpdates.forEach(update => {
            armyUpdatesMap.set(update.armyId, { strength: update.strength, morale: update.morale });
        });
        
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
    const nextArmies: Army[] = state.armies.reduce<Army[]>((acc, army) => {
        if (armiesToDestroyIds.has(army.id)) {
            return acc;
        }

        const pending = armyUpdatesMap.get(army.id);
        if (pending) {
            acc.push({ ...army, strength: pending.strength, morale: pending.morale });
            return acc;
        }

        acc.push(army);
        return acc;
    }, []);

    if (Object.keys(holdUpdates).length > 0) {
        nextAiStates = { ...nextAiStates };

        Object.entries(holdUpdates).forEach(([factionId, systemIds]) => {
            const existingState: AIState = nextAiStates[factionId] ?? createEmptyAIState();

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

            nextAiStates[factionId] = updatedState;
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
