/**
 * State Canonicalization Utility
 * 
 * Ensures consistent ordering of entity arrays in GameState.
 * Critical for determinism when iterating over collections that will consume RNG.
 * 
 * Canonical order is always by ID (lexicographic) for all entity types.
 */

import { GameState, Fleet, Army, Battle, StarSystem, LogEntry, GameMessage } from '../../types';

/**
 * Returns a new GameState with all entity arrays sorted in canonical order.
 * 
 * This ensures that:
 * 1. Iteration order is consistent regardless of insertion order
 * 2. RNG consumption patterns are reproducible
 * 3. State comparisons are meaningful
 * 
 * Note: This creates shallow copies of arrays, not deep copies of entities.
 */
export const canonicalizeState = (state: GameState): GameState => {
    return {
        ...state,
        systems: canonicalizeSystems(state.systems),
        fleets: canonicalizeFleets(state.fleets),
        armies: canonicalizeArmies(state.armies),
        battles: canonicalizeBattles(state.battles),
        logs: canonicalizeLogs(state.logs),
        messages: canonicalizeMessages(state.messages)
    };
};

/**
 * Canonicalize systems array - sorted by ID
 */
export const canonicalizeSystems = (systems: StarSystem[]): StarSystem[] => {
    return [...systems].sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Canonicalize fleets array - sorted by ID
 * Also canonicalizes ships within each fleet
 */
export const canonicalizeFleets = (fleets: Fleet[]): Fleet[] => {
    return [...fleets]
        .map(fleet => ({
            ...fleet,
            ships: [...fleet.ships].sort((a, b) => a.id.localeCompare(b.id))
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Canonicalize armies array - sorted by ID
 */
export const canonicalizeArmies = (armies: Army[]): Army[] => {
    return [...armies].sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Canonicalize battles array - sorted by ID
 */
export const canonicalizeBattles = (battles: Battle[]): Battle[] => {
    return [...battles].sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Canonicalize logs array - sorted by day (ascending), then by ID
 * Preserves chronological order while ensuring determinism within a day
 */
export const canonicalizeLogs = (logs: LogEntry[]): LogEntry[] => {
    return [...logs].sort((a, b) => {
        const dayDiff = a.day - b.day;
        if (dayDiff !== 0) return dayDiff;
        return a.id.localeCompare(b.id);
    });
};

export const canonicalizeMessages = (messages: GameMessage[]): GameMessage[] => {
    return [...messages].sort((a, b) => {
        const dayDiff = a.day - b.day;
        if (dayDiff !== 0) return dayDiff;
        return a.id.localeCompare(b.id);
    });
};

/**
 * Checks if a state is already in canonical order.
 * Useful for debug assertions without the cost of re-sorting.
 */
export const isCanonical = (state: GameState): boolean => {
    // Check fleets order
    for (let i = 1; i < state.fleets.length; i++) {
        if (state.fleets[i].id.localeCompare(state.fleets[i - 1].id) < 0) {
            return false;
        }
    }

    // Check armies order
    for (let i = 1; i < state.armies.length; i++) {
        if (state.armies[i].id.localeCompare(state.armies[i - 1].id) < 0) {
            return false;
        }
    }

    // Check battles order
    for (let i = 1; i < state.battles.length; i++) {
        if (state.battles[i].id.localeCompare(state.battles[i - 1].id) < 0) {
            return false;
        }
    }

    // Check systems order
    for (let i = 1; i < state.systems.length; i++) {
        if (state.systems[i].id.localeCompare(state.systems[i - 1].id) < 0) {
            return false;
        }
    }

    return true;
};
