
import { GameState, FleetState, AIState, FactionId, ArmyState, Army, LogEntry, Fleet, ShipType } from '../shared/types';
import { RNG } from './rng';
import { getSystemById } from './world';
import { clone } from './math/vec3';
import { deepFreezeDev } from './state/immutability';
import { applyContestedUnloadRisk, computeLoadOps, computeUnloadOps } from './armyOps';
import { areFleetsSharingOrbit, isFleetOrbitingSystem, isOrbitContested } from './orbit';
import { getDefaultSolidPlanet, getPlanetById } from './planets';
import { shortId } from './idUtils';
import { withUpdatedFleetDerived } from './fleetDerived';

export type GameCommand =
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'AI_UPDATE_STATE'; factionId: FactionId; newState: AIState; primaryAi?: boolean }
  | { type: 'ADD_LOG'; text: string; logType: 'info' | 'combat' | 'move' | 'ai' }
  | { type: 'LOAD_ARMIES'; fleetId: string; systemId: string; reason?: string }
  | { type: 'UNLOAD_ARMIES'; fleetId: string; systemId: string; targetPlanetId?: string; reason?: string }
  | { type: 'LOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; reason?: string }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; planetId: string; reason?: string }
  | { type: 'TRANSFER_ARMY_PLANET'; armyId: string; fromPlanetId: string; toPlanetId: string; systemId: string; reason?: string }
  | { type: 'SPLIT_FLEET'; originalFleetId: string; shipIds: string[] }
  | { type: 'MERGE_FLEETS'; sourceFleetId: string; targetFleetId: string }
  | { type: 'ORDER_INVASION_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_LOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_UNLOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number };

export interface CommandResult {
    ok: boolean;
    state: GameState;
    error?: string;
    events?: string[];
}

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

const isCombatLocked = (fleet: Fleet | undefined | null): boolean => fleet?.state === FleetState.COMBAT;

export const applyCommand = (state: GameState, command: GameCommand, rng: RNG): CommandResult => {
    // Enforce Immutability in Dev
    deepFreezeDev(state);

    const fail = (error: string): CommandResult => ({ ok: false, state, error });
    const ok = (nextState: GameState, events?: string[]): CommandResult => ({ ok: true, state: nextState, events });

    switch (command.type) {
        case 'MOVE_FLEET': {
            const system = getSystemById(state.systems, command.targetSystemId);

            const stateStartTurn = command.turn ?? state.day;

            // Validation
            if (!system) return fail('System not found');
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return fail('Fleet not found');
            // Combat-locked fleets must ignore movement orders to preserve engagement lock
            if (isCombatLocked(fleet)) return fail('Fleet is in combat and cannot receive commands.');
            if (fleet.retreating) return fail('Fleet is retreating and cannot receive commands.');

            // Structural Sharing Update
            return ok({
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
                        stateStartTurn,
                        invasionTargetSystemId: null, // Clear previous orders
                        loadTargetSystemId: null,
                        unloadTargetSystemId: null
                    };
                })
            });
        }

        case 'ORDER_INVASION_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);

            const stateStartTurn = command.turn ?? state.day;

            if (!system) return fail('System not found');
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return fail('Fleet not found');
            // Combat-locked fleets must ignore movement orders to preserve engagement lock
            if (isCombatLocked(fleet)) return fail('Fleet is in combat and cannot receive commands.');
            if (fleet.retreating) return fail('Fleet is retreating and cannot receive commands.');

            return ok({
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;

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
            });
        }

        case 'ORDER_LOAD_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);

            const stateStartTurn = command.turn ?? state.day;

            if (!system) return fail('System not found');
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return fail('Fleet not found');
            // Combat-locked fleets must ignore movement orders to preserve engagement lock
            if (isCombatLocked(fleet)) return fail('Fleet is in combat and cannot receive commands.');
            if (fleet.retreating) return fail('Fleet is retreating and cannot receive commands.');

            return ok({
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;

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
            });
        }

        case 'ORDER_UNLOAD_MOVE': {
            const system = getSystemById(state.systems, command.targetSystemId);

            const stateStartTurn = command.turn ?? state.day;

            if (!system) return fail('System not found');
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            if (!fleet) return fail('Fleet not found');
            // Combat-locked fleets must ignore movement orders to preserve engagement lock
            if (isCombatLocked(fleet)) return fail('Fleet is in combat and cannot receive commands.');
            if (fleet.retreating) return fail('Fleet is retreating and cannot receive commands.');

            return ok({
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;

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
            });
        }

        case 'AI_UPDATE_STATE': {
            const updatedAiStates = {
                ...(state.aiStates || {}),
                [command.factionId]: command.newState
            };

            return ok({
                ...state,
                aiStates: updatedAiStates,
                aiState: command.primaryAi ? command.newState : state.aiState
            });
        }

        case 'ADD_LOG': {
            return ok({
                ...state,
                logs: [...state.logs, {
                    id: rng.id('log'),
                    day: state.day,
                    text: command.text,
                    type: command.logType
                }]
            });
        }

        case 'LOAD_ARMIES': {
            const system = getSystemById(state.systems, command.systemId);
            const fleet = state.fleets.find(f => f.id === command.fleetId);

            if (!system || !fleet) return fail('Fleet or system not found');
            if (!isFleetOrbitingSystem(fleet, system)) return fail('Fleet must be in orbit to load armies.');

            const loadResult = computeLoadOps({
                fleet,
                system,
                armies: state.armies,
                day: state.day,
                rng,
                fleetLabel: fleet.id
            });

            if (loadResult.count === 0) return fail('No armies available to load.');

            return ok({
                ...state,
                fleets: state.fleets.map(f => (f.id === fleet.id ? loadResult.fleet : f)),
                armies: loadResult.armies,
                logs: [...state.logs, ...loadResult.logs]
            });
        }

        case 'UNLOAD_ARMIES': {
            const system = getSystemById(state.systems, command.systemId);
            const fleet = state.fleets.find(f => f.id === command.fleetId);

            if (!system || !fleet) return fail('Fleet or system not found');
            if (!isFleetOrbitingSystem(fleet, system)) return fail('Fleet must be in orbit to unload armies.');

            const unloadResult = computeUnloadOps({
                fleet,
                system,
                armies: state.armies,
                day: state.day,
                rng,
                fleetLabel: fleet.id,
                targetPlanetId: command.targetPlanetId
            });

            if (unloadResult.count === 0) return fail('No armies available to unload.');

            const contested = isOrbitContested(system, state);
            const targetPlanet = command.targetPlanetId
                ? system.planets.find(planet => planet.id === command.targetPlanetId && planet.isSolid)
                : getDefaultSolidPlanet(system);
            const riskOutcome = contested && unloadResult.unloadedArmyIds?.length
                ? applyContestedUnloadRisk(unloadResult.armies, unloadResult.unloadedArmyIds, system.name, targetPlanet?.name, state.day, rng)
                : { armies: unloadResult.armies, logs: [] };

            return ok({
                ...state,
                fleets: state.fleets.map(f => (f.id === fleet.id ? unloadResult.fleet : f)),
                armies: riskOutcome.armies,
                logs: [...state.logs, ...unloadResult.logs, ...riskOutcome.logs]
            });
        }

        case 'LOAD_ARMY': {
            const system = getSystemById(state.systems, command.systemId);
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            const army = state.armies.find(a => a.id === command.armyId);

            if (!system || !fleet || !army) return fail('Invalid load command.');

            if (!isFleetOrbitingSystem(fleet, system)) return fail('Fleet must be in orbit to load armies.');

            const ship = fleet.ships.find(s => s.id === command.shipId && !s.carriedArmyId);
            if (!ship) return fail('Transport ship not available.');

            const armyPlanet = getPlanetById(state.systems, army.containerId);
            const validArmy = (
                army.state === ArmyState.DEPLOYED &&
                army.factionId === fleet.factionId &&
                armyPlanet?.system.id === system.id &&
                armyPlanet.planet.isSolid
            );
            if (!validArmy) return fail('Army is not eligible for loading.');

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

            if (loadResult.count === 0) return fail('Unable to load the selected army.');

            return ok({
                ...state,
                fleets: state.fleets.map(f => (f.id === fleet.id ? loadResult.fleet : f)),
                armies: loadResult.armies,
                logs: [...state.logs, ...loadResult.logs]
            });
        }

        case 'UNLOAD_ARMY': {
            const system = getSystemById(state.systems, command.systemId);
            const fleet = state.fleets.find(f => f.id === command.fleetId);
            const army = state.armies.find(a => a.id === command.armyId);
            const targetPlanet = getPlanetById(state.systems, command.planetId);

            if (!system || !fleet || !army || !targetPlanet) return fail('Invalid unload command.');
            if (targetPlanet.system.id !== system.id || !targetPlanet.planet.isSolid) return fail('Invalid unload target.');

            if (!isFleetOrbitingSystem(fleet, system)) return fail('Fleet must be in orbit to unload armies.');

            const ship = fleet.ships.find(s => s.id === command.shipId && s.carriedArmyId === command.armyId);
            if (!ship) return fail('Selected ship is not carrying that army.');

            const validArmy = army.state === ArmyState.EMBARKED && army.containerId === fleet.id && army.factionId === fleet.factionId;
            if (!validArmy) return fail('Army is not eligible for unload.');

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

            if (unloadResult.count === 0) return fail('Unable to unload the selected army.');

            const riskOutcome = contested
                ? applyContestedUnloadRisk(unloadResult.armies, [command.armyId], system.name, targetPlanet.planet.name, state.day, rng)
                : { armies: unloadResult.armies, logs: [] };

            return ok({
                ...state,
                fleets: state.fleets.map(f => (f.id === fleet.id ? unloadResult.fleet : f)),
                armies: riskOutcome.armies,
                logs: [...state.logs, ...unloadResult.logs, ...riskOutcome.logs]
            });
        }

        case 'TRANSFER_ARMY_PLANET': {
            const army = state.armies.find(a => a.id === command.armyId);
            if (!army || army.state !== ArmyState.DEPLOYED) return fail('Army is not available for transfer.');

            if (army.containerId !== command.fromPlanetId) return fail('Army is not on the expected planet.');

            const fromMatch = getPlanetById(state.systems, command.fromPlanetId);
            const toMatch = getPlanetById(state.systems, command.toPlanetId);
            if (!fromMatch || !toMatch) return fail('Invalid transfer target.');
            if (!fromMatch.planet.isSolid || !toMatch.planet.isSolid) return fail('Transfer requires solid planets.');
            if (fromMatch.system.id !== toMatch.system.id || fromMatch.system.id !== command.systemId) return fail('Transfer requires both planets in the same system.');

            const availableTransports = getAvailableTransportsInOrbit(state, fromMatch.system.id, army.factionId);
            const carrier = availableTransports[0];
            if (!carrier) return fail('No available transports for transfer.');

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

            return ok({
                ...state,
                fleets: updatedFleets,
                armies: updatedArmies,
                logs: [...state.logs, transferLog]
            });
        }

        case 'SPLIT_FLEET': {
            const fleet = state.fleets.find(f => f.id === command.originalFleetId);
            if (!fleet) return fail('Fleet not found');
            if (isCombatLocked(fleet) || fleet.retreating) return fail('Fleet cannot split while in combat or retreat.');

            const shipIdSet = new Set(command.shipIds);
            const splitShips = fleet.ships.filter(ship => shipIdSet.has(ship.id));

            if (splitShips.length === 0) return fail('No ships selected.');
            if (splitShips.length !== shipIdSet.size) return fail('Some ships were not found in the fleet.');
            if (splitShips.length === fleet.ships.length) return fail('Cannot split entire fleet.');

            const remainingShips = fleet.ships.filter(ship => !shipIdSet.has(ship.id));

            const newFleet = withUpdatedFleetDerived({
                ...fleet,
                id: rng.id('fleet'),
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

            const updatedArmies = state.armies.map(army => {
                if (army.containerId !== fleet.id) return army;
                return splitShips.some(ship => ship.carriedArmyId === army.id)
                    ? { ...army, containerId: newFleet.id }
                    : army;
            });

            const splitLog: LogEntry = {
                id: rng.id('log'),
                day: state.day,
                text: `Fleet ${fleet.id} split into ${updatedOriginalFleet.id} and ${newFleet.id}. ${newFleet.id} received ${splitShips.length} ships.`,
                type: 'info'
            };

            return ok({
                ...state,
                fleets: state.fleets
                    .map(f => (f.id === fleet.id ? updatedOriginalFleet : f))
                    .concat(newFleet),
                armies: updatedArmies,
                logs: [...state.logs, splitLog],
                selectedFleetId: newFleet.id
            });
        }

        case 'MERGE_FLEETS': {
            const sourceFleet = state.fleets.find(f => f.id === command.sourceFleetId);
            const targetFleet = state.fleets.find(f => f.id === command.targetFleetId);

            if (!sourceFleet || !targetFleet) return fail('Fleet not found');
            if (sourceFleet.id === targetFleet.id) return fail('Cannot merge a fleet into itself.');
            if (isCombatLocked(sourceFleet) || isCombatLocked(targetFleet)) return fail('Fleets cannot merge while in combat.');
            if (sourceFleet.retreating || targetFleet.retreating) return fail('Fleets cannot merge while retreating.');
            if (sourceFleet.factionId !== targetFleet.factionId) return fail('Fleets belong to different factions.');
            if (sourceFleet.state !== FleetState.ORBIT || targetFleet.state !== FleetState.ORBIT) return fail('Fleets must be in orbit to merge.');
            if (!areFleetsSharingOrbit(sourceFleet, targetFleet)) return fail('Fleets are too far apart to merge.');

            const mergedTarget = withUpdatedFleetDerived({
                ...targetFleet,
                ships: [...targetFleet.ships, ...sourceFleet.ships]
            });

            const updatedArmies = state.armies.map(army => {
                if (army.containerId !== sourceFleet.id) return army;
                return { ...army, containerId: targetFleet.id };
            });

            const mergeLog: LogEntry = {
                id: rng.id('log'),
                day: state.day,
                text: `Fleet ${sourceFleet.id} merged into ${targetFleet.id}, transferring ${sourceFleet.ships.length} ships.`,
                type: 'info'
            };

            return ok({
                ...state,
                fleets: state.fleets
                    .filter(f => f.id !== sourceFleet.id)
                    .map(f => (f.id === targetFleet.id ? mergedTarget : f)),
                armies: updatedArmies,
                logs: [...state.logs, mergeLog],
                selectedFleetId: mergedTarget.id
            });
        }

        default:
            return fail('Unknown command');
    }
};
