
import { ArmyState, FactionId, Fleet, GameState, StarSystem } from '../types';
import { RNG } from './rng';
import { applyCommand, GameCommand } from './commands';
import { runTurn } from './runTurn';
import { clone, distSq } from './math/vec3';
import { computeLoadOps, computeUnloadOps } from './armyOps';
import { withUpdatedFleetDerived } from './fleetDerived';
import { ORBIT_RADIUS } from '../data/static';

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

        const loadResult = computeLoadOps({
            fleet,
            system,
            armies: this.state.armies,
            day: this.state.day,
            rng: this.rng,
            fleetLabel: fleet.id
        });

        if (loadResult.count === 0) return false;

        this.state = {
            ...this.state,
            fleets: this.state.fleets.map(f => (f.id === fleet.id ? loadResult.fleet : f)),
            armies: loadResult.armies,
            logs: [...this.state.logs, ...loadResult.logs]
        };

        return true;
    }

    private tryImmediateUnload(fleet: Fleet, system: StarSystem): boolean {
        if (!this.isFleetAtSystem(fleet, system)) return false;

        const unloadResult = computeUnloadOps({
            fleet,
            system,
            armies: this.state.armies,
            day: this.state.day,
            rng: this.rng,
            fleetLabel: fleet.id
        });

        if (unloadResult.count === 0) return false;

        this.state = {
            ...this.state,
            fleets: this.state.fleets.map(f => (f.id === fleet.id ? unloadResult.fleet : f)),
            armies: unloadResult.armies,
            logs: [...this.state.logs, ...unloadResult.logs]
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
            const fleet = this.state.fleets.find(f => f.id === command.originalFleetId);
            if (!fleet) return { ok: false, error: 'Fleet not found' };
            if (fleet.factionId !== playerFactionId) return { ok: false, error: 'Not your fleet' };
            if (fleet.retreating) return { ok: false, error: 'Fleet is retreating and cannot split.' };

            const shipIdSet = new Set(command.shipIds);
            const splitShips = fleet.ships.filter(ship => shipIdSet.has(ship.id));

            if (splitShips.length === 0) return { ok: false, error: 'No ships selected' };
            if (splitShips.length !== shipIdSet.size) return { ok: false, error: 'Some ships not found in fleet' };
            if (splitShips.length === fleet.ships.length) return { ok: false, error: 'Cannot split entire fleet' };

            const remainingShips = fleet.ships.filter(ship => !shipIdSet.has(ship.id));

            const newFleet: Fleet = withUpdatedFleetDerived({
                ...fleet,
                id: this.rng.id('fleet'),
                ships: splitShips,
                position: clone(fleet.position),
                targetPosition: fleet.targetPosition ? clone(fleet.targetPosition) : null,
                invasionTargetSystemId: fleet.invasionTargetSystemId ?? null,
                loadTargetSystemId: fleet.loadTargetSystemId ?? null,
                unloadTargetSystemId: fleet.unloadTargetSystemId ?? null
            });

            const updatedOriginalFleet = withUpdatedFleetDerived({
                ...fleet,
                ships: remainingShips
            });

            const updatedArmies = this.state.armies.map(army => {
                if (army.containerId !== fleet.id) return army;
                const carriedByMovedShip = splitShips.some(ship => ship.carriedArmyId === army.id);
                if (!carriedByMovedShip) return army;
                return { ...army, containerId: newFleet.id };
            });

            const splitLog = {
                id: this.rng.id('log'),
                day: this.state.day,
                text: `Fleet ${fleet.id} split into ${updatedOriginalFleet.id} and ${newFleet.id}. ${newFleet.id} received ${splitShips.length} ships.`,
                type: 'info' as const
            };

            this.state = {
                ...this.state,
                fleets: this.state.fleets
                    .map(f => (f.id === fleet.id ? updatedOriginalFleet : f))
                    .concat(newFleet),
                armies: updatedArmies,
                logs: [...this.state.logs, splitLog],
                selectedFleetId: newFleet.id
            };

            this.syncRngState();
            this.notify();
            return { ok: true };
        }

        if (command.type === 'MERGE_FLEETS') {
            const sourceFleet = this.state.fleets.find(f => f.id === command.sourceFleetId);
            const targetFleet = this.state.fleets.find(f => f.id === command.targetFleetId);

            if (!sourceFleet || !targetFleet) return { ok: false, error: 'Fleet not found' };
            if (sourceFleet.id === targetFleet.id) return { ok: false, error: 'Cannot merge a fleet into itself' };
            if (sourceFleet.factionId !== playerFactionId) return { ok: false, error: 'Not your fleet' };
            if (targetFleet.factionId !== playerFactionId) return { ok: false, error: 'Target fleet not controlled by player' };
            if (sourceFleet.factionId !== targetFleet.factionId) return { ok: false, error: 'Fleets belong to different factions' };
            if (sourceFleet.retreating || targetFleet.retreating) return { ok: false, error: 'Retreating fleets cannot merge' };
            if (sourceFleet.state !== FleetState.ORBIT || targetFleet.state !== FleetState.ORBIT)
                return { ok: false, error: 'Fleets must be in orbit to merge' };

            const mergeRangeSq = (ORBIT_RADIUS * 3) ** 2;
            if (distSq(sourceFleet.position, targetFleet.position) > mergeRangeSq)
                return { ok: false, error: 'Fleets are too far apart to merge' };

            const mergedTarget = withUpdatedFleetDerived({
                ...targetFleet,
                ships: [...targetFleet.ships, ...sourceFleet.ships]
            });

            const updatedArmies = this.state.armies.map(army => {
                if (army.containerId !== sourceFleet.id) return army;
                return { ...army, containerId: targetFleet.id };
            });

            const mergeLog = {
                id: this.rng.id('log'),
                day: this.state.day,
                text: `Fleet ${sourceFleet.id} merged into ${targetFleet.id}, transferring ${sourceFleet.ships.length} ships.`,
                type: 'info' as const
            };

            this.state = {
                ...this.state,
                fleets: this.state.fleets
                    .filter(f => f.id !== sourceFleet.id)
                    .map(f => (f.id === targetFleet.id ? mergedTarget : f)),
                armies: updatedArmies,
                logs: [...this.state.logs, mergeLog],
                selectedFleetId: mergedTarget.id
            };

            this.syncRngState();
            this.notify();
            return { ok: true };
        }

        return { ok: false, error: 'Unknown command' };
    }
}
