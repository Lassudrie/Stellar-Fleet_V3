
import { GameState, FleetState, AIState, FactionId, ArmyState, Army, LogEntry, Fleet, ShipType } from '../types';
import { RNG } from './rng';
import { getSystemById } from './world';
import { clone } from './math/vec3';
import { deepFreezeDev } from './state/immutability';
import { applyContestedUnloadRisk, computeLoadOps, computeUnloadOps } from './armyOps';
import { isFleetOrbitingSystem, isOrbitContested } from './orbit';
import { getDefaultSolidPlanet, getPlanetById } from './planets';
import { shortId } from './idUtils';

export type GameCommand =
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'AI_UPDATE_STATE'; factionId: FactionId; newState: AIState; primaryAi?: boolean }
  | { type: 'ADD_LOG'; text: string; logType: 'info' | 'combat' | 'move' | 'ai' }
  | { type: 'LOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; reason?: string }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; planetId: string; reason?: string }
  | { type: 'TRANSFER_ARMY_PLANET'; armyId: string; fromPlanetId: string; toPlanetId: string; systemId: string; reason?: string }
  | { type: 'ORDER_INVASION_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_LOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_UNLOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number };

const getAvailableTransportsInOrbit = (
    state: GameState,
    systemId: string,
    factionId: FactionId
): Array<{ fleet: Fleet; shipIndex: number }> => {
    const system = getSystemById(state.systems, systemId);
    if (!system) return [];

    const inOrbit = state.fleets.filter(
        fleet => fleet.factionId === factionId && isFleetOrbitingSystem(fleet, system)
    );

    const candidates: Array<{ fleet: Fleet; shipIndex: number }> = [];

    inOrbit.forEach(fleet => {
        fleet.ships.forEach((ship, index) => {
            if (ship.type !== ShipType.TROOP_TRANSPORT) return;
            if (ship.carriedArmyId) return;
            if ((ship.transferBusyUntilDay ?? -Infinity) >= state.day) return;
            candidates.push({ fleet, shipIndex: index });
        });
    });

    return candidates.sort((a, b) => {
        const fleetDiff = a.fleet.id.localeCompare(b.fleet.id);
        if (fleetDiff !== 0) return fleetDiff;
        return a.fleet.ships[a.shipIndex].id.localeCompare(b.fleet.ships[b.shipIndex].id);
    });
};

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

            if (!isFleetOrbitingSystem(fleet, system)) return state;

            const ship = fleet.ships.find(s => s.id === command.shipId && !s.carriedArmyId);
            if (!ship) return state;

            const armyPlanet = getPlanetById(state.systems, army.containerId);
            const validArmy = (
                army.state === ArmyState.DEPLOYED &&
                army.factionId === fleet.factionId &&
                armyPlanet?.system.id === system.id &&
                armyPlanet.planet.isSolid
            );
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
            const targetPlanet = getPlanetById(state.systems, command.planetId);

            if (!system || !fleet || !army || !targetPlanet) return state;
            if (targetPlanet.system.id !== system.id || !targetPlanet.planet.isSolid) return state;

            if (!isFleetOrbitingSystem(fleet, system)) return state;

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
                targetPlanetId: targetPlanet.planet.id,
                allowedArmyIds: new Set([command.armyId]),
                allowedShipIds: new Set([command.shipId]),
                logText: `Fleet ${fleet.id} unloaded army ${command.armyId} at ${targetPlanet.planet.name}.`
            });

            if (unloadResult.count === 0) return state;

            const riskOutcome = contested
                ? applyContestedUnloadRisk(unloadResult.armies, [command.armyId], system.name, targetPlanet.planet.name, state.day, rng)
                : { armies: unloadResult.armies, logs: [] };

            return {
                ...state,
                fleets: state.fleets.map(f => (f.id === fleet.id ? unloadResult.fleet : f)),
                armies: riskOutcome.armies,
                logs: [...state.logs, ...unloadResult.logs, ...riskOutcome.logs]
            };
        }

        case 'TRANSFER_ARMY_PLANET': {
            const army = state.armies.find(a => a.id === command.armyId);
            if (!army || army.state !== ArmyState.DEPLOYED) return state;

            if (army.containerId !== command.fromPlanetId) return state;

            const fromMatch = getPlanetById(state.systems, command.fromPlanetId);
            const toMatch = getPlanetById(state.systems, command.toPlanetId);
            if (!fromMatch || !toMatch) return state;
            if (!fromMatch.planet.isSolid || !toMatch.planet.isSolid) return state;
            if (fromMatch.system.id !== toMatch.system.id || fromMatch.system.id !== command.systemId) return state;

            const availableTransports = getAvailableTransportsInOrbit(state, fromMatch.system.id, army.factionId);
            const carrier = availableTransports[0];
            if (!carrier) return state;

            const updatedFleets = state.fleets.map(fleet => {
                if (fleet.id !== carrier.fleet.id) return fleet;
                const ships = fleet.ships.map((ship, index) => {
                    if (index !== carrier.shipIndex) return ship;
                    return { ...ship, transferBusyUntilDay: state.day };
                });
                return { ...fleet, ships };
            });

            const updatedArmies = state.armies.map(existing => {
                if (existing.id !== army.id) return existing;
                return { ...existing, containerId: toMatch.planet.id };
            });

            const carrierShip = carrier.fleet.ships[carrier.shipIndex];
            const logText = command.reason ?? `Army ${shortId(army.id)} transferred from ${fromMatch.planet.name} to ${toMatch.planet.name} using ${shortId(carrierShip.id)}.`;

            const transferLog: LogEntry = {
                id: rng.id('log'),
                day: state.day,
                text: logText,
                type: 'move'
            };

            return {
                ...state,
                fleets: updatedFleets,
                armies: updatedArmies,
                logs: [...state.logs, transferLog]
            };
        }

        default:
            return state;
    }
};
