
import { ArmyState, FactionId, Fleet, GameState, ShipType, StarSystem } from '../types';
import { RNG } from './rng';
import { applyCommand, GameCommand } from './commands';
import { runTurn } from './runTurn';
import { distSq } from './math/vec3';

type PlayerCommand =
    | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string }
    | { type: 'SPLIT_FLEET'; originalFleetId: string; shipIds: string[] }
    | { type: 'MERGE_FLEETS'; sourceFleetId: string; targetFleetId: string }
    | { type: 'ORDER_INVASION'; fleetId: string; targetSystemId: string }
    | { type: 'ORDER_LOAD'; fleetId: string; targetSystemId: string }
    | { type: 'ORDER_UNLOAD'; fleetId: string; targetSystemId: string };

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

    private isFleetAtSystem(fleet: Fleet, system: StarSystem): boolean {
        // Allow a small epsilon to guard against floating point drift
        return distSq(fleet.position, system.position) < 0.0001;
    }

    private tryImmediateLoad(fleet: Fleet, system: StarSystem): boolean {
        if (!this.isFleetAtSystem(fleet, system)) return false;

        const availableArmies = this.state.armies.filter(a =>
            a.containerId === system.id &&
            a.factionId === fleet.factionId &&
            a.state === ArmyState.DEPLOYED
        );

        const transports = fleet.ships.filter(s => !s.carriedArmyId && s.type === ShipType.TROOP_TRANSPORT);
        const loadableArmies = Math.min(availableArmies.length, transports.length);

        if (loadableArmies === 0) return false;

        const updatedArmies = this.state.armies.map(army => {
            const shouldLoad =
                army.containerId === system.id &&
                army.factionId === fleet.factionId &&
                army.state === ArmyState.DEPLOYED &&
                availableArmies.findIndex(a => a.id === army.id) < loadableArmies;

            if (!shouldLoad) return army;

            return {
                ...army,
                state: ArmyState.EMBARKED,
                containerId: fleet.id
            };
        });

        let loadedCount = 0;
        const updatedFleet: Fleet = {
            ...fleet,
            ships: fleet.ships.map(ship => {
                if (ship.type !== ShipType.TROOP_TRANSPORT || ship.carriedArmyId) return ship;
                const army = availableArmies[loadedCount];
                if (!army || loadedCount >= loadableArmies) return ship;
                loadedCount++;
                return { ...ship, carriedArmyId: army.id };
            })
        };

        const newLog = {
            id: this.rng.id('log'),
            day: this.state.day,
            text: `Fleet ${fleet.id} loaded ${loadableArmies} armies at ${system.name}.`,
            type: 'move' as const
        };

        this.state = {
            ...this.state,
            fleets: this.state.fleets.map(f => (f.id === fleet.id ? updatedFleet : f)),
            armies: updatedArmies,
            logs: [...this.state.logs, newLog]
        };

        return true;
    }

    private tryImmediateUnload(fleet: Fleet, system: StarSystem): boolean {
        if (!this.isFleetAtSystem(fleet, system)) return false;

        const embarkedArmies = this.state.armies.filter(a =>
            a.containerId === fleet.id &&
            a.factionId === fleet.factionId &&
            a.state === ArmyState.EMBARKED
        );

        if (embarkedArmies.length === 0) return false;

        let unloadedCount = 0;

        const updatedFleet: Fleet = {
            ...fleet,
            ships: fleet.ships.map(ship => {
                if (!ship.carriedArmyId) return ship;
                const carryingArmy = embarkedArmies.find(a => a.id === ship.carriedArmyId);
                if (!carryingArmy) return ship;
                unloadedCount++;
                return { ...ship, carriedArmyId: null };
            })
        };

        if (unloadedCount === 0) return false;

        const updatedArmies = this.state.armies.map(army => {
            if (!embarkedArmies.some(a => a.id === army.id)) return army;

            return {
                ...army,
                state: ArmyState.DEPLOYED,
                containerId: system.id
            };
        });

        const newLog = {
            id: this.rng.id('log'),
            day: this.state.day,
            text: `Fleet ${fleet.id} unloaded ${unloadedCount} armies at ${system.name}.`,
            type: 'move' as const
        };

        this.state = {
            ...this.state,
            fleets: this.state.fleets.map(f => (f.id === fleet.id ? updatedFleet : f)),
            armies: updatedArmies,
            logs: [...this.state.logs, newLog]
        };

        return true;
    }

    dispatchPlayerCommand(command: PlayerCommand): { ok: boolean; error?: string } {
        const playerFactionId = this.state.playerFactionId;

        if (command.type === 'MOVE_FLEET') {
            const fleet = this.state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return { ok: false, error: 'Fleet not found' };
            if (fleet.factionId !== playerFactionId) return { ok: false, error: 'Not your fleet' };
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
            if (fleet.factionId !== playerFactionId) return { ok: false, error: 'Not your fleet' };
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

        if (command.type === 'ORDER_LOAD') {
            const fleet = this.state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return { ok: false, error: 'Fleet not found' };
            if (fleet.factionId !== playerFactionId) return { ok: false, error: 'Not your fleet' };
            if (fleet.retreating) return { ok: false, error: 'Fleet is retreating.' };

            const system = this.state.systems.find(s => s.id === command.targetSystemId);
            if (!system) return { ok: false, error: 'System not found' };

            const hasAlliedArmies = this.state.armies.some(a =>
                a.containerId === system.id &&
                a.factionId === playerFactionId
            );

            if (!hasAlliedArmies) return { ok: false, error: 'No allied armies to load' };

            const loadedImmediately = this.tryImmediateLoad(fleet, system);
            if (loadedImmediately) {
                this.syncRngState();
                this.notify();
                return { ok: true };
            }

            this.state = applyCommand(this.state, {
                type: 'ORDER_LOAD_MOVE',
                fleetId: command.fleetId,
                targetSystemId: command.targetSystemId
            }, this.rng);

            this.syncRngState();
            this.notify();
            return { ok: true };
        }

        if (command.type === 'ORDER_UNLOAD') {
            const fleet = this.state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return { ok: false, error: 'Fleet not found' };
            if (fleet.factionId !== playerFactionId) return { ok: false, error: 'Not your fleet' };
            if (fleet.retreating) return { ok: false, error: 'Fleet is retreating.' };

            const system = this.state.systems.find(s => s.id === command.targetSystemId);
            if (!system) return { ok: false, error: 'System not found' };

            if (system.ownerFactionId !== playerFactionId) return { ok: false, error: 'System is not allied' };

            const unloadedImmediately = this.tryImmediateUnload(fleet, system);
            if (unloadedImmediately) {
                this.syncRngState();
                this.notify();
                return { ok: true };
            }

            this.state = applyCommand(this.state, {
                type: 'ORDER_UNLOAD_MOVE',
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

        return { ok: false, error: 'Unknown command' };
    }
}
