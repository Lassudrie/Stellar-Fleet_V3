/**
 * Deterministic State Hash Utility
 * 
 * Provides a fast, deterministic hash of GameState for debugging and 
 * detecting state divergence in replay/multiplayer scenarios.
 * 
 * Uses a simple djb2-style hash algorithm for speed.
 */

import { GameState } from '../../types';

/**
 * Simple string hash function (djb2 variant)
 * Deterministic and fast for debugging purposes
 */
const hashString = (str: string): number => {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        // hash * 33 + charCode
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
        // Keep within 32-bit integer range
        hash = hash >>> 0;
    }
    return hash;
};

/**
 * Converts a number to a fixed-precision string for consistent hashing
 */
const fixedNumber = (n: number, precision: number = 6): string => {
    if (!Number.isFinite(n)) return String(n);
    return n.toFixed(precision);
};

/**
 * Generates a deterministic hash of critical GameState fields.
 * 
 * Focuses on simulation-critical data:
 * - Day/turn counter
 * - RNG state
 * - Fleet positions, states, composition
 * - Army states and locations
 * - System ownership
 * - Battle states
 * 
 * Does NOT hash:
 * - Visual-only data (lasers, colors)
 * - Logs (informational)
 * - UI state (selectedFleetId)
 */
export const computeStateHash = (state: GameState): string => {
    const parts: string[] = [];

    // Core simulation state
    parts.push(`d:${state.day}`);
    parts.push(`rng:${state.rngState}`);
    parts.push(`seed:${state.seed}`);

    // Systems (sorted by ID for determinism)
    const sortedSystems = [...state.systems].sort((a, b) => a.id.localeCompare(b.id));
    sortedSystems.forEach(sys => {
        parts.push(`S:${sys.id}:${sys.ownerFactionId || 'null'}`);
    });

    // Fleets (sorted by ID)
    const sortedFleets = [...state.fleets].sort((a, b) => a.id.localeCompare(b.id));
    sortedFleets.forEach(fleet => {
        const pos = `${fixedNumber(fleet.position.x, 2)},${fixedNumber(fleet.position.y, 2)},${fixedNumber(fleet.position.z, 2)}`;
        const shipIds = fleet.ships.map(s => s.id).sort().join(',');
        const shipHps = fleet.ships.map(s => s.hp).sort((a, b) => a - b).join(',');
        parts.push(`F:${fleet.id}:${fleet.factionId}:${fleet.state}:${pos}:${fleet.targetSystemId || 'null'}:[${shipIds}]:[${shipHps}]`);
    });

    // Armies (sorted by ID)
    const sortedArmies = [...state.armies].sort((a, b) => a.id.localeCompare(b.id));
    sortedArmies.forEach(army => {
        parts.push(`A:${army.id}:${army.factionId}:${army.state}:${army.containerId}:${army.strength}`);
    });

    // Battles (sorted by ID)
    const sortedBattles = [...state.battles].sort((a, b) => a.id.localeCompare(b.id));
    sortedBattles.forEach(battle => {
        parts.push(`B:${battle.id}:${battle.status}:${battle.systemId}:${battle.winnerFactionId || 'null'}`);
    });

    // Winner state
    parts.push(`W:${state.winnerFactionId || 'null'}`);

    // Combine and hash
    const combined = parts.join('|');
    const hash = hashString(combined);

    // Return as hex string for readability
    return hash.toString(16).padStart(8, '0');
};

/**
 * Computes a quick hash of just the essential simulation counters.
 * Useful for fast divergence detection.
 */
export const computeQuickHash = (state: GameState): string => {
    const parts = [
        state.day,
        state.rngState,
        state.fleets.length,
        state.armies.length,
        state.systems.filter(s => s.ownerFactionId === 'blue').length,
        state.systems.filter(s => s.ownerFactionId === 'red').length,
        state.battles.filter(b => b.status === 'scheduled').length
    ];
    
    return hashString(parts.join(':')).toString(16).padStart(8, '0');
};

/**
 * Logs state hash to console for debugging.
 * Call this at the end of each turn to track simulation state.
 */
export const logStateHash = (state: GameState, label?: string): void => {
    const hash = computeStateHash(state);
    const quickHash = computeQuickHash(state);
    console.log(`[StateHash] ${label || `Day ${state.day}`}: ${hash} (quick: ${quickHash})`);
};
