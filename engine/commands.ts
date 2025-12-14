
import { GameState, FleetState, AIState, FactionId, ArmyState, ShipType, Fleet, Army, ShipEntity, StarSystem } from '../types';
import { RNG } from './rng';
import { getSystemById } from './world';
import { clone, distSq } from './math/vec3';
import { deepFreezeDev } from './state/immutability';
import { CAPTURE_RANGE } from '../data/static';

export type GameCommand = 
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string }
  | { type: 'AI_UPDATE_STATE'; newState: AIState }
  | { type: 'ADD_LOG'; text: string; logType: 'info' | 'combat' | 'move' | 'ai' }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string }
  | { type: 'ORDER_INVASION_MOVE'; fleetId: string; targetSystemId: string }
  | { type: 'LOAD_ARMY'; armyId: string; fleetId: string; shipId: string; systemId: string }
  | { type: 'DEPLOY_ARMY'; armyId: string; fleetId: string; shipId: string; systemId: string };

// Validation helpers
const isFleetInOrbitOfSystem = (fleet: Fleet, system: StarSystem): boolean => {
    if (fleet.state !== FleetState.ORBIT) return false;
    const captureSq = CAPTURE_RANGE * CAPTURE_RANGE;
    return distSq(fleet.position, system.position) <= captureSq;
};

const findShipInFleet = (fleet: Fleet, shipId: string): ShipEntity | undefined => {
    return fleet.ships.find(s => s.id === shipId);
};

const findArmyById = (armies: Army[], armyId: string): Army | undefined => {
    return armies.find(a => a.id === armyId);
};

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

            // Structural Sharing Update (Copy-on-write)
            // We strictly return a new State and new Fleets array to ensure UI updates.
            return {
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    
                    // Locked fleets cannot move
                    if (fleet.retreating) return fleet;

                    return {
                        ...fleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        invasionTargetSystemId: null // Clear previous orders
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

                    return {
                        ...fleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        invasionTargetSystemId: system.id // Set invasion order
                    };
                })
            };
        }

        case 'AI_UPDATE_STATE': {
            return {
                ...state,
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
            // Placeholder: No-op for now as manual unload is not fully implemented
            // logic is usually handled by movement phase auto-invasion or specific handlers
            return state;
        }

        case 'LOAD_ARMY': {
            // Validate system exists
            const system = getSystemById(state.systems, command.systemId);
            if (!system) return state;

            // Validate fleet exists
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return state;

            // Validate fleet is in orbit of the system
            if (!isFleetInOrbitOfSystem(fleet, system)) return state;

            // Validate ship belongs to fleet and is valid transport
            const ship = findShipInFleet(fleet, command.shipId);
            if (!ship) return state;
            if (ship.type !== ShipType.TROOP_TRANSPORT) return state;
            if (ship.carriedArmyId) return state; // Already carrying an army

            // Validate army exists and is deployed on the same system
            const army = findArmyById(state.armies, command.armyId);
            if (!army) return state;
            if (army.state !== ArmyState.DEPLOYED) return state;
            if (army.containerId !== command.systemId) return state;
            
            // Validate faction match
            if (army.factionId !== fleet.factionId) return state;

            // All validations passed - Apply immutable updates
            return {
                ...state,
                fleets: state.fleets.map(f => {
                    if (f.id !== command.fleetId) return f;
                    return {
                        ...f,
                        ships: f.ships.map(s => {
                            if (s.id !== command.shipId) return s;
                            return {
                                ...s,
                                carriedArmyId: command.armyId
                            };
                        })
                    };
                }),
                armies: state.armies.map(a => {
                    if (a.id !== command.armyId) return a;
                    return {
                        ...a,
                        state: ArmyState.EMBARKED,
                        containerId: command.fleetId
                    };
                })
            };
        }

        case 'DEPLOY_ARMY': {
            // Validate system exists
            const system = getSystemById(state.systems, command.systemId);
            if (!system) return state;

            // Validate fleet exists
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return state;

            // Validate fleet is in orbit of the system
            if (!isFleetInOrbitOfSystem(fleet, system)) return state;

            // Validate ship belongs to fleet and carries the army
            const ship = findShipInFleet(fleet, command.shipId);
            if (!ship) return state;
            if (ship.carriedArmyId !== command.armyId) return state;

            // Validate army exists and is embarked on this fleet
            const army = findArmyById(state.armies, command.armyId);
            if (!army) return state;
            if (army.state !== ArmyState.EMBARKED) return state;
            if (army.containerId !== command.fleetId) return state;

            // All validations passed - Apply immutable updates
            return {
                ...state,
                fleets: state.fleets.map(f => {
                    if (f.id !== command.fleetId) return f;
                    return {
                        ...f,
                        ships: f.ships.map(s => {
                            if (s.id !== command.shipId) return s;
                            return {
                                ...s,
                                carriedArmyId: null
                            };
                        })
                    };
                }),
                armies: state.armies.map(a => {
                    if (a.id !== command.armyId) return a;
                    return {
                        ...a,
                        state: ArmyState.DEPLOYED,
                        containerId: command.systemId
                    };
                })
            };
        }

        default:
            return state;
    }
};
