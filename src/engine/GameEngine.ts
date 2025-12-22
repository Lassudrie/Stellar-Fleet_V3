
import { ArmyState, Fleet, FleetState, GameMessage, GameState, StarSystem } from '../shared/types';
import { RNG } from './rng';
import { applyCommand, GameCommand, CommandResult } from './commands';
import { runTurn } from './runTurn';
import { isFleetWithinOrbitProximity } from './orbit';
import { getDefaultSolidPlanet } from './planets';
import { canonicalizeMessages, canonicalizeState } from './state/canonicalize';

type PlayerCommand =
    | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string }
    | { type: 'SPLIT_FLEET'; originalFleetId: string; shipIds: string[] }
    | { type: 'MERGE_FLEETS'; sourceFleetId: string; targetFleetId: string }
    | { type: 'ORDER_INVASION'; fleetId: string; targetSystemId: string }
    | { type: 'ORDER_LOAD'; fleetId: string; targetSystemId: string }
    | { type: 'ORDER_UNLOAD'; fleetId: string; targetSystemId: string }
    | { type: 'LOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string }
    | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; planetId: string }
    | { type: 'TRANSFER_ARMY_PLANET'; armyId: string; fromPlanetId: string; toPlanetId: string; systemId: string };

export class GameEngine {
    state: GameState;
    rng: RNG;
    private listeners: Set<() => void> = new Set();

    constructor(initialState: GameState) {
        const canonicalState = canonicalizeState(initialState);
        this.state = canonicalState;
        this.rng = new RNG(canonicalState.seed);
        
        // Fix: Restore RNG state to ensure determinism and prevent ID collisions
        if (canonicalState.rngState !== undefined) {
            this.rng.setState(canonicalState.rngState);
        }
    }

    private commitState(nextState: GameState) {
        this.state = this.withSyncedRngState(canonicalizeState(nextState));
        this.notify();
    }

    private withSyncedRngState(state: GameState): GameState {
        // Persist current RNG cursor to state so next save/load continues correctly
        const syncedState: GameState = {
            ...state,
            rngState: this.rng.getState()
        };

        // DEV Assertion: Check for duplicate Log IDs
        if ((import.meta as any).env && (import.meta as any).env.DEV) {
            const seen = new Set<string>();
            let duplicates = 0;
            for (const log of syncedState.logs) {
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

        return syncedState;
    }

    notify() {
        this.listeners.forEach(l => l());
    }

    subscribe(fn: () => void) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    advanceTurn() {
        this.commitState(runTurn(this.state, this.rng));
    }

    dispatchCommand(cmd: GameCommand): CommandResult {
        const result = applyCommand(this.state, cmd, this.rng);
        if (result.ok) {
            this.commitState(result.state);
            return { ...result, state: this.state };
        }
        return result;
    }

    private updateMessages(updater: (messages: GameMessage[]) => GameMessage[]) {
        this.commitState({
            ...this.state,
            messages: canonicalizeMessages(updater(this.state.messages))
        });
    }

    markMessageRead(messageId: string, read: boolean) {
        this.updateMessages(messages => messages.map(message =>
            message.id === messageId ? { ...message, read } : message
        ));
    }

    dismissMessage(messageId: string) {
        this.updateMessages(messages => messages.map(message =>
            message.id === messageId ? { ...message, read: true, dismissed: true } : message
        ));
    }

    markAllMessagesRead() {
        this.updateMessages(messages => messages.map(message => ({
            ...message,
            read: true
        })));
    }

    dismissReadMessages() {
        this.updateMessages(messages => messages.map(message =>
            message.read ? { ...message, dismissed: true } : message
        ));
    }

    private isFleetAtSystem(fleet: Fleet, system: StarSystem): boolean {
        return isFleetWithinOrbitProximity(fleet, system);
    }

    private isFleetInOrbit(fleet: Fleet, system: StarSystem): boolean {
        return fleet.state === FleetState.ORBIT && this.isFleetAtSystem(fleet, system);
    }

    dispatchPlayerCommand(command: PlayerCommand): CommandResult & { deployedArmies?: number } {
        const playerFactionId = this.state.playerFactionId;
        const fail = (error: string): CommandResult => ({ ok: false, state: this.state, error });

        const getPlayerFleet = (fleetId: string) => {
            const fleet = this.state.fleets.find(f => f.id === fleetId);
            if (!fleet) return { error: 'Fleet not found' as const };
            if (fleet.factionId !== playerFactionId) return { error: 'Not your fleet' as const };
            return { fleet };
        };

        if (command.type === 'MOVE_FLEET') {
            const { fleet, error } = getPlayerFleet(command.fleetId);
            if (!fleet) return fail(error);

            const system = this.state.systems.find(s => s.id === command.targetSystemId);
            if (!system) return fail('System not found');

            return this.dispatchCommand({
                type: 'MOVE_FLEET',
                fleetId: command.fleetId,
                targetSystemId: command.targetSystemId
            });
        }

        if (command.type === 'ORDER_INVASION') {
            const { fleet, error } = getPlayerFleet(command.fleetId);
            if (!fleet) return fail(error);

            const embarkedArmies = this.state.armies.filter(army =>
                army.containerId === fleet.id &&
                army.state === ArmyState.EMBARKED
            ).length;

            const result = this.dispatchCommand({
                type: 'ORDER_INVASION_MOVE',
                fleetId: command.fleetId,
                targetSystemId: command.targetSystemId
            });

            return result.ok ? { ...result, deployedArmies: embarkedArmies } : result;
        }

        if (command.type === 'ORDER_LOAD') {
            const { fleet, error } = getPlayerFleet(command.fleetId);
            if (!fleet) return fail(error);

            const system = this.state.systems.find(s => s.id === command.targetSystemId);
            if (!system) return fail('System not found');

            const systemPlanetIds = new Set(system.planets.map(planet => planet.id));
            const hasAlliedArmies = this.state.armies.some(a =>
                a.factionId === playerFactionId &&
                a.state === ArmyState.DEPLOYED &&
                systemPlanetIds.has(a.containerId)
            );

            if (!hasAlliedArmies) return fail('No allied armies to load');

            if (this.isFleetInOrbit(fleet, system)) {
                return this.dispatchCommand({
                    type: 'LOAD_ARMIES',
                    fleetId: command.fleetId,
                    systemId: command.targetSystemId
                });
            }

            return this.dispatchCommand({
                type: 'ORDER_LOAD_MOVE',
                fleetId: command.fleetId,
                targetSystemId: command.targetSystemId
            });
        }

        if (command.type === 'ORDER_UNLOAD') {
            const { fleet, error } = getPlayerFleet(command.fleetId);
            if (!fleet) return fail(error);

            const system = this.state.systems.find(s => s.id === command.targetSystemId);
            if (!system) return fail('System not found');

            if (system.ownerFactionId !== playerFactionId) return fail('System is not allied');
            if (!getDefaultSolidPlanet(system)) return fail('No viable landing zone');

            if (this.isFleetInOrbit(fleet, system)) {
                return this.dispatchCommand({
                    type: 'UNLOAD_ARMIES',
                    fleetId: command.fleetId,
                    systemId: command.targetSystemId
                });
            }

            return this.dispatchCommand({
                type: 'ORDER_UNLOAD_MOVE',
                fleetId: command.fleetId,
                targetSystemId: command.targetSystemId
            });
        }

        if (command.type === 'SPLIT_FLEET') {
            const { fleet, error } = getPlayerFleet(command.originalFleetId);
            if (!fleet) return fail(error);

            return this.dispatchCommand({
                type: 'SPLIT_FLEET',
                originalFleetId: command.originalFleetId,
                shipIds: command.shipIds
            });
        }

        if (command.type === 'MERGE_FLEETS') {
            const { fleet: sourceFleet, error } = getPlayerFleet(command.sourceFleetId);
            if (!sourceFleet) return fail(error);

            const targetFleet = this.state.fleets.find(f => f.id === command.targetFleetId);
            if (!targetFleet) return fail('Fleet not found');
            if (targetFleet.factionId !== playerFactionId) return fail('Target fleet not controlled by player');

            return this.dispatchCommand({
                type: 'MERGE_FLEETS',
                sourceFleetId: command.sourceFleetId,
                targetFleetId: command.targetFleetId
            });
        }

        if (command.type === 'LOAD_ARMY') {
            const { fleet, error } = getPlayerFleet(command.fleetId);
            if (!fleet) return fail(error);

            const army = this.state.armies.find(a => a.id === command.armyId);
            if (!army) return fail('Army not found');
            if (army.factionId !== playerFactionId) return fail('Not your army');

            return this.dispatchCommand({
                type: 'LOAD_ARMY',
                fleetId: command.fleetId,
                shipId: command.shipId,
                armyId: command.armyId,
                systemId: command.systemId
            });
        }

        if (command.type === 'UNLOAD_ARMY') {
            const { fleet, error } = getPlayerFleet(command.fleetId);
            if (!fleet) return fail(error);

            const army = this.state.armies.find(a => a.id === command.armyId);
            if (!army) return fail('Army not found');
            if (army.factionId !== playerFactionId) return fail('Not your army');

            return this.dispatchCommand({
                type: 'UNLOAD_ARMY',
                fleetId: command.fleetId,
                shipId: command.shipId,
                armyId: command.armyId,
                systemId: command.systemId,
                planetId: command.planetId
            });
        }

        if (command.type === 'TRANSFER_ARMY_PLANET') {
            const army = this.state.armies.find(a => a.id === command.armyId);
            if (!army) return fail('Army not found');
            if (army.factionId !== playerFactionId) return fail('Not your army');

            return this.dispatchCommand({
                type: 'TRANSFER_ARMY_PLANET',
                armyId: command.armyId,
                fromPlanetId: command.fromPlanetId,
                toPlanetId: command.toPlanetId,
                systemId: command.systemId
            });
        }

        return fail('Unknown command');
    }
}
