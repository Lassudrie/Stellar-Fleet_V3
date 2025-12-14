
import { GameState, FleetState, AIState, FactionId } from '../types';
import { RNG } from './rng';
import { getSystemById } from './world';
import { clone } from './math/vec3';
import { deepFreezeDev } from './state/immutability';

export type GameCommand = 
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string }
  | { type: 'AI_UPDATE_STATE'; newState: AIState }
  | { type: 'ADD_LOG'; text: string; logType: 'info' | 'combat' | 'move' | 'ai' }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string }
  | { type: 'ORDER_INVASION_MOVE'; fleetId: string; targetSystemId: string };

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

        default:
            return state;
    }
};
