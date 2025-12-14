import { GameState, Fleet, FleetState, ArmyState } from '../types';
import { RNG } from './rng';
import { applyCommand, GameCommand } from './commands';
import { runTurn } from './runTurn';
import { withUpdatedFleetDerived } from './fleetDerived';
import { clone, dist } from './math/vec3';

export type PlayerCommand =
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string }
  | { type: 'ORDER_INVASION'; fleetId: string; targetSystemId: string }
  | { type: 'SPLIT_FLEET'; fleetId: string; shipIds: string[] }
  | { type: 'MERGE_FLEETS'; sourceFleetId: string; targetFleetId: string }
  | { type: 'DEPLOY_ARMY'; shipId: string; armyId: string; fleetId: string; systemId: string }
  | { type: 'LOAD_ARMY'; shipId: string; armyId: string; fleetId: string; systemId: string };

export interface CommandResult {
  ok: boolean;
  message?: string;
}

const MERGE_DISTANCE = 8;

export class GameEngine {
  public state: GameState;
  private rng: RNG;
  private listeners: (() => void)[] = [];

  constructor(initialState: GameState) {
    this.state = initialState;

    // Robust init: if rngState is missing, fall back to seed.
    const seed = typeof initialState.rngState === 'number' ? initialState.rngState : initialState.seed;
    this.rng = new RNG(seed);

    this.syncRngState();
  }

  public getState(): GameState {
    return this.state;
  }

  public replaceState(nextState: GameState): void {
    this.state = nextState;
    this.syncRngState();
    this.notify();
  }

  private syncRngState() {
    const next = typeof this.state.rngState === 'number' ? this.state.rngState : this.state.seed;
    this.rng.setState(next);
  }

  subscribe(listener: () => void) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  notify() {
    this.listeners.forEach(listener => listener());
  }

  dispatchCommand(command: GameCommand): CommandResult {
    // Apply command (may consume RNG for log IDs, etc.)
    const nextState = applyCommand(this.state, command, this.rng);

    // Persist RNG state so IDs are not re-used and determinism is preserved
    this.state = { ...nextState, rngState: this.rng.getState() };

    // Keep RNG aligned with state snapshot
    this.syncRngState();

    this.notify();
    return { ok: true };
  }

  dispatchPlayerCommand(command: PlayerCommand): CommandResult {
    const playerFactionId = this.state.playerFactionId;

    switch (command.type) {
      case 'MOVE_FLEET': {
        const fleet = this.state.fleets.find(f => f.id === command.fleetId);
        if (!fleet) return { ok: false, message: 'Fleet not found' };
        if (fleet.factionId !== playerFactionId) return { ok: false, message: 'Cannot control this fleet' };

        return this.dispatchCommand({
          type: 'MOVE_FLEET',
          fleetId: command.fleetId,
          targetSystemId: command.targetSystemId
        });
      }

      case 'ORDER_INVASION': {
        const fleet = this.state.fleets.find(f => f.id === command.fleetId);
        if (!fleet) return { ok: false, message: 'Fleet not found' };
        if (fleet.factionId !== playerFactionId) return { ok: false, message: 'Cannot control this fleet' };

        return this.dispatchCommand({
          type: 'ORDER_INVASION_MOVE',
          fleetId: command.fleetId,
          targetSystemId: command.targetSystemId
        });
      }

      case 'LOAD_ARMY': {
        const fleet = this.state.fleets.find(f => f.id === command.fleetId);
        const army = this.state.armies.find(a => a.id === command.armyId);
        if (!fleet || !army) return { ok: false, message: 'Fleet or Army not found' };
        if (fleet.factionId !== playerFactionId || army.factionId !== playerFactionId) {
          return { ok: false, message: 'Cannot control this fleet or army' };
        }

        return this.dispatchCommand({
          type: 'LOAD_ARMY',
          shipId: command.shipId,
          armyId: command.armyId,
          fleetId: command.fleetId,
          systemId: command.systemId
        });
      }

      case 'DEPLOY_ARMY': {
        const fleet = this.state.fleets.find(f => f.id === command.fleetId);
        const army = this.state.armies.find(a => a.id === command.armyId);
        if (!fleet || !army) return { ok: false, message: 'Fleet or Army not found' };
        if (fleet.factionId !== playerFactionId || army.factionId !== playerFactionId) {
          return { ok: false, message: 'Cannot control this fleet or army' };
        }

        return this.dispatchCommand({
          type: 'DEPLOY_ARMY',
          shipId: command.shipId,
          armyId: command.armyId,
          fleetId: command.fleetId,
          systemId: command.systemId
        });
      }

      case 'SPLIT_FLEET': {
        const fleet = this.state.fleets.find(f => f.id === command.fleetId);
        if (!fleet) return { ok: false, message: 'Fleet not found' };
        if (fleet.factionId !== playerFactionId) return { ok: false, message: 'Cannot control this fleet' };
        if (fleet.retreating) return { ok: false, message: 'Cannot split while retreating' };
        if (fleet.state !== FleetState.ORBIT) return { ok: false, message: 'Can only split while in orbit' };

        const requestedIds = new Set(command.shipIds);
        const shipsToMove = fleet.ships.filter(s => requestedIds.has(s.id));

        if (shipsToMove.length === 0) return { ok: false, message: 'No valid ships selected for split' };
        if (shipsToMove.length >= fleet.ships.length) return { ok: false, message: 'Cannot split all ships into a new fleet' };

        const remainingShips = fleet.ships.filter(s => !requestedIds.has(s.id));
        const newFleetId = this.rng.id('fleet');

        const updatedOriginalFleet: Fleet = withUpdatedFleetDerived({
          ...fleet,
          ships: remainingShips,
          // Force stable state after split
          state: FleetState.ORBIT,
          targetSystemId: null,
          targetPosition: null,
          invasionTargetSystemId: null,
          retreating: false,
          stateStartTurn: this.state.day
        });

        const newFleet: Fleet = withUpdatedFleetDerived({
          ...fleet,
          id: newFleetId,
          ships: shipsToMove,
          position: clone(fleet.position),
          state: FleetState.ORBIT,
          targetSystemId: null,
          targetPosition: null,
          invasionTargetSystemId: null,
          retreating: false,
          stateStartTurn: this.state.day
        });

        // Any armies carried by moved ships must follow the new fleet (containerId update)
        const movedArmyIds = new Set<string>();
        for (const ship of shipsToMove) {
          if (ship.carriedArmyId) movedArmyIds.add(ship.carriedArmyId);
        }

        const updatedArmies = movedArmyIds.size === 0
          ? this.state.armies
          : this.state.armies.map(a => {
              if (movedArmyIds.has(a.id) && a.containerId === fleet.id && (a.state === ArmyState.EMBARKED || a.state === ArmyState.IN_TRANSIT)) {
                return { ...a, containerId: newFleetId };
              }
              return a;
            });

        const nextFleets: Fleet[] = [];
        for (const f of this.state.fleets) {
          if (f.id === fleet.id) {
            nextFleets.push(updatedOriginalFleet);
            nextFleets.push(newFleet);
          } else {
            nextFleets.push(f);
          }
        }

        const nextSelectedFleetId =
          this.state.selectedFleetId === fleet.id ? newFleetId : this.state.selectedFleetId;

        const nextState: GameState = {
          ...this.state,
          fleets: nextFleets,
          armies: updatedArmies,
          selectedFleetId: nextSelectedFleetId
        };

        // Persist RNG usage (fleet id generation)
        this.state = { ...nextState, rngState: this.rng.getState() };
        this.syncRngState();
        this.notify();

        return { ok: true };
      }

      case 'MERGE_FLEETS': {
        const sourceFleet = this.state.fleets.find(f => f.id === command.sourceFleetId);
        const targetFleet = this.state.fleets.find(f => f.id === command.targetFleetId);

        if (!sourceFleet || !targetFleet) return { ok: false, message: 'Fleet(s) not found' };
        if (sourceFleet.id === targetFleet.id) return { ok: false, message: 'Cannot merge a fleet with itself' };
        if (sourceFleet.factionId !== playerFactionId || targetFleet.factionId !== playerFactionId) {
          return { ok: false, message: 'Cannot control one of the fleets' };
        }
        if (sourceFleet.retreating || targetFleet.retreating) return { ok: false, message: 'Cannot merge while retreating' };
        if (sourceFleet.state !== FleetState.ORBIT || targetFleet.state !== FleetState.ORBIT) {
          return { ok: false, message: 'Can only merge fleets while in orbit' };
        }
        if (dist(sourceFleet.position, targetFleet.position) > MERGE_DISTANCE) {
          return { ok: false, message: 'Fleets are too far apart to merge' };
        }

        const mergedShips = [...targetFleet.ships, ...sourceFleet.ships].sort((a, b) => a.id.localeCompare(b.id));

        const mergedFleet: Fleet = withUpdatedFleetDerived({
          ...targetFleet,
          ships: mergedShips,
          state: FleetState.ORBIT,
          targetSystemId: null,
          targetPosition: null,
          invasionTargetSystemId: null,
          retreating: false,
          stateStartTurn: this.state.day
        });

        // Move embarked/in-transit armies from source container to target container
        const updatedArmies = this.state.armies.map(a => {
          if (
            a.containerId === sourceFleet.id &&
            (a.state === ArmyState.EMBARKED || a.state === ArmyState.IN_TRANSIT)
          ) {
            return { ...a, containerId: targetFleet.id };
          }
          return a;
        });

        const nextFleets = this.state.fleets
          .filter(f => f.id !== sourceFleet.id)
          .map(f => (f.id === targetFleet.id ? mergedFleet : f));

        const nextSelectedFleetId =
          this.state.selectedFleetId === sourceFleet.id ? targetFleet.id : this.state.selectedFleetId;

        const nextState: GameState = {
          ...this.state,
          fleets: nextFleets,
          armies: updatedArmies,
          selectedFleetId: nextSelectedFleetId
        };

        this.state = { ...nextState, rngState: this.rng.getState() };
        this.syncRngState();
        this.notify();

        return { ok: true };
      }

      default:
        return { ok: false, message: 'Not implemented' };
    }
  }

  nextTurn() {
    this.state = runTurn(this.state, this.rng);
    this.syncRngState();
    this.notify();
  }
}
