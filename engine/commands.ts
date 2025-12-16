
import { GameState, FleetState, AIState, FactionId, ArmyState } from '../types';
import { RNG } from './rng';
import { getSystemById } from './world';
import { clone, distSq } from './math/vec3';
import { deepFreezeDev } from './state/immutability';
import { computeUnloadOps } from './armyOps';

export type GameCommand =
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string; reason?: string }
  | { type: 'AI_UPDATE_STATE'; factionId: FactionId; newState: AIState }
  | { type: 'ADD_LOG'; text: string; logType: 'info' | 'combat' | 'move' | 'ai' }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; reason?: string }
  | { type: 'ORDER_INVASION_MOVE'; fleetId: string; targetSystemId: string; reason?: string }
  | { type: 'ORDER_LOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string }
  | { type: 'ORDER_UNLOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string };

export const applyCommand = (state: GameState, command: GameCommand, rng: RNG): GameState => {
    // Enforce Immutability in Dev
    deepFreezeDev(state);

    switch (command.type) {
        case 'MOVE_FLEET': {
            const system = getSystemById(state.systems, command.targetSystemId);
            
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
                        invasionTargetSystemId: null, // Clear previous orders
                        loadTargetSystemId: null,
                        unloadTargetSystemId: null
                    };
                })
            };
        }

        case 'ORDER_INVASION_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);
            
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
                        invasionTargetSystemId: system.id, // Set invasion order
                        loadTargetSystemId: null,
                        unloadTargetSystemId: null
                    };
                })
            };
        }

        case 'ORDER_LOAD_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);

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
                        invasionTargetSystemId: null,
                        loadTargetSystemId: system.id,
                        unloadTargetSystemId: null
                    };
                })
            };
        }

        case 'ORDER_UNLOAD_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);

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
                aiState: command.newState
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

        case 'UNLOAD_ARMY': {
            const system = getSystemById(state.systems, command.systemId);
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            const army = state.armies.find(a => a.id === command.armyId);

            if (!system || !fleet || !army) return state;

            const inOrbit = fleet.state === FleetState.ORBIT && distSq(fleet.position, system.position) < 0.0001;
            if (!inOrbit) return state;

            const ship = fleet.ships.find(s => s.id === command.shipId && s.carriedArmyId === command.armyId);
            if (!ship) return state;

            const validArmy = army.state === ArmyState.EMBARKED && army.containerId === fleet.id && army.factionId === fleet.factionId;
            if (!validArmy) return state;

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

            return {
                ...state,
                fleets: state.fleets.map(f => (f.id === fleet.id ? unloadResult.fleet : f)),
                armies: unloadResult.armies,
                logs: [...state.logs, ...unloadResult.logs]
            };
        }

        default:
            return state;
    }
};
