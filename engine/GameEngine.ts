import { GameState, FactionId } from '../types';
import { RNG } from './rng';
import { applyCommand, GameCommand } from './commands';
import { runTurn } from './runTurn';
import { withTurnReportLogs } from './turnReport/computeTurnReport';

export class GameEngine {
    state: GameState;
    rng: RNG;
    listeners: Set<() => void>;

    constructor(initialState: GameState) {
        this.state = initialState;
        this.rng = new RNG(initialState.seed, initialState.rngState);
        this.listeners = new Set();
        this.syncRngState();
    }

    // Ensure rng state in game state matches engine
    syncRngState() {
        this.state.rngState = this.rng.getState();

        // DEV: Validate no duplicate IDs. This catches RNG desync issues early.
        if ((import.meta as any).env?.MODE !== 'production') {
            const ids = [
                ...this.state.systems.map(s => s.id),
                ...this.state.fleets.map(f => f.id),
                ...this.state.battles.map(b => b.id),
                ...Object.keys(this.state.armies ?? {}),
            ];
            const set = new Set(ids);
            if (set.size !== ids.length) {
                // eslint-disable-next-line no-console
                console.error('Duplicate IDs detected!', ids);
                throw new Error('Duplicate IDs detected (possible RNG desync)');
            }
        }
    }

    subscribe(fn: () => void) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /**
     * Read-only convenience accessor (used by UI code).
     * Kept as a method to avoid leaking implementation details.
     */
    getState(): GameState {
        return this.state;
    }

    notify() {
        for (const fn of this.listeners) fn();
    }

    dispatch(command: GameCommand) {
        // Check faction permission (only allow player to command their own faction)
        if (command.factionId && command.factionId !== this.state.playerFactionId) {
            console.warn(`Command rejected: faction ${command.factionId} != player faction ${this.state.playerFactionId}`);
            return;
        }

        this.state = applyCommand(this.state, command, this.rng);
        this.syncRngState();
        this.notify();
    }

    advanceTurn() {
        const prevState = this.state;
        const rawNextState = runTurn(prevState, this.rng);

        // Attach end-of-turn report logs (SITREP) without consuming RNG.
        const nextState = withTurnReportLogs(prevState, rawNextState);

        this.state = nextState;
        this.syncRngState();
        this.notify();
    }

    // Helper methods for convenience
    getSystem(systemId: string) {
        return this.state.systems.find(s => s.id === systemId);
    }

    getFleet(fleetId: string) {
        return this.state.fleets.find(f => f.id === fleetId);
    }

    // Get player faction
    getPlayerFaction(): FactionId {
        return this.state.playerFactionId;
    }

    // Get all fleets for a faction
    getFactionFleets(factionId: FactionId) {
        return this.state.fleets.filter(f => f.factionId === factionId);
    }

    // Get fleets in a system
    getFleetsInSystem(systemId: string) {
        return this.state.fleets.filter(f => f.location.systemId === systemId);
    }

    // Get systems owned by a faction
    getFactionSystems(factionId: FactionId) {
        return this.state.systems.filter(s => s.ownerFactionId === factionId);
    }

    // Execute a command as the player
    dispatchPlayerCommand(command: Omit<GameCommand, 'factionId'>) {
        this.dispatch({ ...command, factionId: this.state.playerFactionId } as GameCommand);
    }
}
