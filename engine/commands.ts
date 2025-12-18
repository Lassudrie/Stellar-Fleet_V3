
import { GameState, FleetState, AIState, FactionId, ArmyState, Army, LogEntry } from '../types';
import { RNG } from './rng';
import { getSystemById } from './world';
import { clone, distSq } from './math/vec3';
import { deepFreezeDev } from './state/immutability';
import { applyContestedUnloadRisk, computeLoadOps, computeUnloadOps } from './armyOps';
import { isOrbitContested } from './conquest';
import { ORBIT_PROXIMITY_RANGE_SQ } from '../data/static';

export type GameCommand =
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'AI_UPDATE_STATE'; factionId: FactionId; newState: AIState; primaryAi?: boolean }
  | { type: 'ADD_LOG'; text: string; logType: 'info' | 'combat' | 'move' | 'ai' }
  | { type: 'LOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; reason?: string }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; reason?: string }
  | { type: 'ORDER_INVASION_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_LOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_UNLOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number };

export const applyCommand = (state: GameState, command: GameCommand, rng: RNG): GameState => {
    // Enforce Immutability in Dev
    deepFreezeDev(state);

    switch (command.type) {
        case 'MOVE_FLEET': {
            const system = getSystemById(state.systems, command.targetSystemId);

            const stateStartTurn = command.turn ?? state.day;

            // Validation
            if (!system) return state;
            const fleetExists = state.fleets.some(f => f.id === command.fleetId);
            if (!fleetExists) return state;

            // Structural Sharing Update
            return {
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    
                    // Locked fleets cannot move
                    if (fleet.retreating) return fleet;
                    // Combat-locked fleets must ignore movement orders to preserve engagement lock
                    if (fleet.state === FleetState.COMBAT) return fleet;

                    return {
                        ...fleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        stateStartTurn,
                        invasionTargetSystemId: null, // Clear previous orders
                        loadTargetSystemId: null,
                        unloadTargetSystemId: null
                    };
                })
            };
        }

        case 'ORDER_INVASION_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);

            const stateStartTurn = command.turn ?? state.day;

            if (!system) return state;
            const fleetExists = state.fleets.some(f => f.id === command.fleetId);
            if (!fleetExists) return state;

            return {
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;
                    // Combat-locked fleets must ignore movement orders to preserve engagement lock
                    if (fleet.state === FleetState.COMBAT) return fleet;

                    return {
                        ...fleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        stateStartTurn,
                        invasionTargetSystemId: system.id, // Set invasion order
                        loadTargetSystemId: null,
                        unloadTargetSystemId: null
                    };
                })
            };
        }

        case 'ORDER_LOAD_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);

            const stateStartTurn = command.turn ?? state.day;

            if (!system) return state;
            const fleetExists = state.fleets.some(f => f.id === command.fleetId);
            if (!fleetExists) return state;

            return {
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;
                    // Combat-locked fleets must ignore movement orders to preserve engagement lock
                    if (fleet.state === FleetState.COMBAT) return fleet;

                    return {
                        ...fleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        stateStartTurn,
                        invasionTargetSystemId: null,
                        loadTargetSystemId: system.id,
                        unloadTargetSystemId: null
                    };
                })
            };
        }

        case 'ORDER_UNLOAD_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);

            const stateStartTurn = command.turn ?? state.day;

            if (!system) return state;
            const fleetExists = state.fleets.some(f => f.id === command.fleetId);
            if (!fleetExists) return state;

            return {
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;
                    // Combat-locked fleets must ignore movement orders to preserve engagement lock
                    if (fleet.state === FleetState.COMBAT) return fleet;

                    return {
                        ...fleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        stateStartTurn,
                        invasionTargetSystemId: null,
                        loadTargetSystemId: null,
                        unloadTargetSystemId: system.id
                    };
                })
            };
        }

        case 'AI_UPDATE_STATE': {
            const updatedAiStates = {
                ...(state.aiStates || {}),
                [command.factionId]: command.newState
            };

            return {
                ...state,
                aiStates: updatedAiStates,
                aiState: command.primaryAi ? command.newState : state.aiState
            };
        }

        case 'ADD_LOG': {
            return {
                ...state,
                logs: [...state.logs, {
                    id: rng.id('log'),
                    day: state.day,
                    text: command.text,
                    type: command.logType
                }]
            };
        }

        case 'LOAD_ARMY': {
            const system = getSystemById(state.systems, command.systemId);
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            const army = state.armies.find(a => a.id === command.armyId);

            if (!system || !fleet || !army) return state;

            const inOrbit =
                fleet.state === FleetState.ORBIT && distSq(fleet.position, system.position) <= ORBIT_PROXIMITY_RANGE_SQ;
            if (!inOrbit) return state;

            const ship = fleet.ships.find(s => s.id === command.shipId && !s.carriedArmyId);
            if (!ship) return state;

            const validArmy = army.state === ArmyState.DEPLOYED && army.containerId === system.id && army.factionId === fleet.factionId;
            if (!validArmy) return state;

            const loadResult = computeLoadOps({
                fleet,
                system,
                armies: state.armies,
                day: state.day,
                rng,
                fleetLabel: fleet.id,
                allowedArmyIds: new Set([command.armyId]),
                allowedShipIds: new Set([command.shipId]),
                logText: `Fleet ${fleet.id} loaded army ${command.armyId} at ${system.name}.`
            });

            if (loadResult.count === 0) return state;

            return {
                ...state,
                fleets: state.fleets.map(f => (f.id === fleet.id ? loadResult.fleet : f)),
                armies: loadResult.armies,
                logs: [...state.logs, ...loadResult.logs]
            };
        }

        case 'UNLOAD_ARMY': {
            const system = getSystemById(state.systems, command.systemId);
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            const army = state.armies.find(a => a.id === command.armyId);

            if (!system || !fleet || !army) return state;

            const inOrbit =
                fleet.state === FleetState.ORBIT && distSq(fleet.position, system.position) <= ORBIT_PROXIMITY_RANGE_SQ;
            if (!inOrbit) return state;

            const ship = fleet.ships.find(s => s.id === command.shipId && s.carriedArmyId === command.armyId);
            if (!ship) return state;

            const validArmy = army.state === ArmyState.EMBARKED && army.containerId === fleet.id && army.factionId === fleet.factionId;
            if (!validArmy) return state;

            const contested = isOrbitContested(system, state);

            const unloadResult = computeUnloadOps({
                fleet,
                system,
                armies: state.armies,
                day: state.day,
                rng,
                fleetLabel: fleet.id,
                allowedArmyIds: new Set([command.armyId]),
                allowedShipIds: new Set([command.shipId]),
                logText: `Fleet ${fleet.id} unloaded army ${command.armyId} at ${system.name}.`
            });

            if (unloadResult.count === 0) return state;

            const riskOutcome = contested
                ? applyContestedUnloadRisk(unloadResult.armies, [command.armyId], system.name, state.day, rng)
                : { armies: unloadResult.armies, logs: [] };

            return {
                ...state,
                fleets: state.fleets.map(f => (f.id === fleet.id ? unloadResult.fleet : f)),
                armies: riskOutcome.armies,
                logs: [...state.logs, ...unloadResult.logs, ...riskOutcome.logs]
            };
        }

        default:
            return state;
    }
};
