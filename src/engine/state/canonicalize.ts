/**
 * State Canonicalization Utility
 * 
 * Ensures consistent ordering of entity arrays in GameState.
 * Critical for determinism when iterating over collections that will consume RNG.
 * 
 * Canonical order is always by ID (lexicographic) for all entity types.
 */

import { GameState, Fleet, Army, Battle, StarSystem, LogEntry, GameMessage } from '../../shared/types';
import { sorted } from '../../shared/sorting';

const compareIds = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });

const isSortedByDayThenId = (entries: Array<{ day: number; id: string }>): boolean => {
    for (let i = 1; i < entries.length; i++) {
        const prev = entries[i - 1];
        const curr = entries[i];
        if (curr.day < prev.day) return false;
        if (curr.day === prev.day && compareIds(curr.id, prev.id) < 0) return false;
    }
    return true;
};

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
    return sorted(systems, (a, b) => compareIds(a.id, b.id));
};

/**
 * Canonicalize fleets array - sorted by ID
 * Also canonicalizes ships within each fleet
 */
export const canonicalizeFleets = (fleets: Fleet[]): Fleet[] => {
    return sorted(
        fleets.map(fleet => ({
            ...fleet,
            ships: sorted(fleet.ships, (a, b) => compareIds(a.id, b.id))
        })),
        (a, b) => compareIds(a.id, b.id)
    );
};

/**
 * Canonicalize armies array - sorted by ID
 */
export const canonicalizeArmies = (armies: Army[]): Army[] => {
    return sorted(armies, (a, b) => compareIds(a.id, b.id));
};

/**
 * Canonicalize battles array - sorted by ID
 */
export const canonicalizeBattles = (battles: Battle[]): Battle[] => {
    return sorted(battles, (a, b) => compareIds(a.id, b.id));
};

/**
 * Canonicalize logs array - sorted by day (ascending), then by ID
 * Preserves chronological order while ensuring determinism within a day
 */
export const canonicalizeLogs = (logs: LogEntry[]): LogEntry[] => {
    if (isSortedByDayThenId(logs)) return logs;
    return sorted(logs, (a, b) => {
        const dayDiff = a.day - b.day;
        if (dayDiff !== 0) return dayDiff;
        return compareIds(a.id, b.id);
    });
};

export const canonicalizeMessages = (messages: GameMessage[]): GameMessage[] => {
    if (isSortedByDayThenId(messages)) return messages;
    return sorted(messages, (a, b) => {
        const dayDiff = a.day - b.day;
        if (dayDiff !== 0) return dayDiff;
        return compareIds(a.id, b.id);
    });
};

/**
 * Checks if a state is already in canonical order.
 * Useful for debug assertions without the cost of re-sorting.
 */
export const isCanonical = (state: GameState): boolean => {
    // Check fleets order
    for (let i = 1; i < state.fleets.length; i++) {
        if (compareIds(state.fleets[i].id, state.fleets[i - 1].id) < 0) {
            return false;
        }
    }

    // Check armies order
    for (let i = 1; i < state.armies.length; i++) {
        if (compareIds(state.armies[i].id, state.armies[i - 1].id) < 0) {
            return false;
        }
    }

    // Check battles order
    for (let i = 1; i < state.battles.length; i++) {
        if (compareIds(state.battles[i].id, state.battles[i - 1].id) < 0) {
            return false;
        }
    }

    // Check systems order
    for (let i = 1; i < state.systems.length; i++) {
        if (compareIds(state.systems[i].id, state.systems[i - 1].id) < 0) {
            return false;
        }
    }

    // Check logs order
    if (!isSortedByDayThenId(state.logs)) {
        return false;
    }

    // Check messages order
    if (!isSortedByDayThenId(state.messages)) {
        return false;
    }

    return true;
};
