
import { GameState, FactionId } from '../types';
import { RNG } from './rng';
import { applyCommand, GameCommand } from './commands';
import { runTurn } from './runTurn';

type PlayerCommand = 
    | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string }
    | { type: 'SPLIT_FLEET'; originalFleetId: string; shipIds: string[] }
    | { type: 'MERGE_FLEETS'; sourceFleetId: string; targetFleetId: string }
    | { type: 'ORDER_INVASION'; fleetId: string; targetSystemId: string }
    | { type: 'LOAD_ARMY'; armyId: string; fleetId: string; shipId: string; systemId: string }
    | { type: 'DEPLOY_ARMY'; armyId: string; fleetId: string; shipId: string; systemId: string };

export class GameEngine {
    state: GameState;
    rng: RNG;
    private listeners: Set<() => void> = new Set();

    constructor(initialState: GameState) {
        this.state = initialState;
        this.rng = new RNG(initialState.seed);
        
        // Fix: Restore RNG state to ensure determinism and prevent ID collisions
        if (initialState.rngState !== undefined) {
            this.rng.setState(initialState.rngState);
        }
    }

    private syncRngState() {
        // Persist current RNG cursor to state so next save/load continues correctly
        this.state.rngState = this.rng.getState();

        // DEV Assertion: Check for duplicate Log IDs
        if ((import.meta as any).env && (import.meta as any).env.DEV) {
            const seen = new Set<string>();
            let duplicates = 0;
            for (const log of this.state.logs) {
                if (seen.has(log.id)) {
                    console.error(`[GameEngine] CRITICAL: Duplicate Log ID detected: ${log.id}`);
                    duplicates++;
                }
                seen.add(log.id);
            }
            if (duplicates > 0) {
                console.error(`[GameEngine] Found ${duplicates} duplicate IDs in logs. RNG Determinism broken.`);
            }
        }
    }

    notify() {
        this.listeners.forEach(l => l());
    }

    subscribe(fn: () => void) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    advanceTurn() {
        this.state = runTurn(this.state, this.rng);
        this.syncRngState();
        this.notify();
    }

    dispatchCommand(cmd: GameCommand) {
        this.state = applyCommand(this.state, cmd, this.rng);
        this.syncRngState();
        this.notify();
    }

    dispatchPlayerCommand(command: PlayerCommand): { ok: boolean; error?: string } {
        if (command.type === 'MOVE_FLEET') {
            const fleet = this.state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return { ok: false, error: 'Fleet not found' };
            if (fleet.factionId !== 'blue') return { ok: false, error: 'Not your fleet' };
            if (fleet.retreating) return { ok: false, error: 'Fleet is retreating and cannot receive commands.' };

            const system = this.state.systems.find(s => s.id === command.targetSystemId);
            if (!system) return { ok: false, error: 'System not found' };

            this.state = applyCommand(this.state, {
                type: 'MOVE_FLEET',
                fleetId: command.fleetId,
                targetSystemId: command.targetSystemId
            }, this.rng);
            
            this.syncRngState();
            this.notify();
            return { ok: true };
        }

        if (command.type === 'ORDER_INVASION') {
            const fleet = this.state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return { ok: false, error: 'Fleet not found' };
            if (fleet.factionId !== 'blue') return { ok: false, error: 'Not your fleet' };
            if (fleet.retreating) return { ok: false, error: 'Fleet is retreating.' };

            this.state = applyCommand(this.state, {
                type: 'ORDER_INVASION_MOVE',
                fleetId: command.fleetId,
                targetSystemId: command.targetSystemId
            }, this.rng);

            this.syncRngState();
            this.notify();
            return { ok: true };
        }

        if (command.type === 'SPLIT_FLEET') {
            // Placeholder logic
            return { ok: true };
        }

        if (command.type === 'MERGE_FLEETS') {
            // Placeholder logic
            return { ok: true };
        }

        if (command.type === 'LOAD_ARMY') {
            const fleet = this.state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return { ok: false, error: 'Fleet not found' };
            if (fleet.factionId !== this.state.playerFactionId) return { ok: false, error: 'Not your fleet' };

            const ship = fleet.ships.find(s => s.id === command.shipId);
            if (!ship) return { ok: false, error: 'Ship not found in fleet' };

            const army = this.state.armies.find(a => a.id === command.armyId);
            if (!army) return { ok: false, error: 'Army not found' };
            if (army.factionId !== this.state.playerFactionId) return { ok: false, error: 'Not your army' };

            const prevState = this.state;
            this.state = applyCommand(this.state, {
                type: 'LOAD_ARMY',
                armyId: command.armyId,
                fleetId: command.fleetId,
                shipId: command.shipId,
                systemId: command.systemId
            }, this.rng);

            // If state unchanged, validation failed inside applyCommand
            if (this.state === prevState) {
                return { ok: false, error: 'Load failed: check fleet orbit, ship capacity, or army state' };
            }

            this.syncRngState();
            this.notify();
            return { ok: true };
        }

        if (command.type === 'DEPLOY_ARMY') {
            const fleet = this.state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return { ok: false, error: 'Fleet not found' };
            if (fleet.factionId !== this.state.playerFactionId) return { ok: false, error: 'Not your fleet' };

            const ship = fleet.ships.find(s => s.id === command.shipId);
            if (!ship) return { ok: false, error: 'Ship not found in fleet' };
            if (ship.carriedArmyId !== command.armyId) return { ok: false, error: 'Ship does not carry this army' };

            const prevState = this.state;
            this.state = applyCommand(this.state, {
                type: 'DEPLOY_ARMY',
                armyId: command.armyId,
                fleetId: command.fleetId,
                shipId: command.shipId,
                systemId: command.systemId
            }, this.rng);

            // If state unchanged, validation failed inside applyCommand
            if (this.state === prevState) {
                return { ok: false, error: 'Deploy failed: check fleet orbit or army state' };
            }

            this.syncRngState();
            this.notify();
            return { ok: true };
        }

        return { ok: false, error: 'Unknown command' };
    }
}
