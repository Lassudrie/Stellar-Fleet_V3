
import {
    GameState,
    FleetState,
    AIState,
    FactionId,
    ArmyState,
    LogEntry,
    Fleet,
    ShipType,
    GroundBuildingType,
    PlanetSurfaceDescriptor,
    SurfacePos
} from '../shared/shared';
import type { Army } from '../shared/shared';
import { RNG } from './rng';
import { getSystemById } from './world';
import { clone } from './math/vec3';
import { deepFreezeDev } from './state';
import { computeLoadOps } from './armyOps';
import { areFleetsSharingOrbit, isFleetOrbitingSystem } from './orbit';
import { getDefaultSolidPlanet, getPlanetById } from './planets';
import { shortId } from '../shared/shared';
import { withUpdatedFleetDerived } from './fleetDerived';
import { FuelShortageError, validateAndDebitJumpOrFail } from './logistics/fuel';
import { sorted } from '../shared/shared';
import {
    generateSurfaceMapForState,
    getSurfaceTileCoordFromId,
    getTileAt,
    isBuildable,
    isPassable,
    normalizeSurfacePositions,
    pickLandingSurfacePosForArmy,
    resolveSurfaceTileId
} from './planetSurface';
import { GROUND_UNIT_STATS } from '../content/data/groundUnits';
import { STACKING_CAP, tileKey } from './ground';

export type GameCommand =
  | { type: 'MOVE_FLEET'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'AI_UPDATE_STATE'; factionId: FactionId; newState: AIState; primaryAi?: boolean }
  | { type: 'ADD_LOG'; text: string; logType: 'info' | 'combat' | 'move' | 'ai' }
  | { type: 'LOAD_ARMIES'; fleetId: string; systemId: string; reason?: string }
  | { type: 'UNLOAD_ARMIES'; fleetId: string; systemId: string; targetPlanetId?: string; reason?: string }
  | { type: 'LOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; reason?: string }
  | { type: 'UNLOAD_ARMY'; fleetId: string; shipId: string; armyId: string; systemId: string; planetId: string; reason?: string }
  | { type: 'TRANSFER_ARMY_PLANET'; armyId: string; fromPlanetId: string; toPlanetId: string; systemId: string; reason?: string }
  | { type: 'MOVE_ARMY_ON_SURFACE'; armyId: string; to: SurfacePos }
  | { type: 'ORDER_GROUND_MOVE'; armyId: string; to: SurfacePos }
  | { type: 'ORDER_GROUND_ATTACK'; attackerId: string; targetArmyId: string }
  | { type: 'ORDER_GROUND_LAND'; armyId: string; to: SurfacePos }
  | { type: 'SET_GROUND_POSTURE'; armyId: string; posture: 'normal' | 'prepared_defense' }
  | { type: 'CANCEL_GROUND_ORDER'; armyId: string }
  | { type: 'BUILD_AT'; factionId: FactionId; buildingType: GroundBuildingType; at: SurfacePos; name?: string }
  | { type: 'SPLIT_FLEET'; originalFleetId: string; shipIds: string[] }
  | { type: 'MERGE_FLEETS'; sourceFleetId: string; targetFleetId: string }
  | { type: 'ORDER_INVASION_MOVE'; fleetId: string; targetSystemId: string; targetPlanetId?: string | null; reason?: string; turn?: number }
  | { type: 'ORDER_LOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number }
  | { type: 'ORDER_UNLOAD_MOVE'; fleetId: string; targetSystemId: string; reason?: string; turn?: number };

export interface CommandResult {
    ok: boolean;
    state: GameState;
    error?: string | FuelShortageError;
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
            if (ship.type !== ShipType.TRANSPORTER) return;
            if (ship.carriedArmyId) return;
            if ((ship.transferBusyUntilDay ?? -Infinity) >= state.day) return;
            candidates.push({ fleet, shipIndex: index });
        });
    });

    return sorted(candidates, (a, b) => {
        const fleetDiff = a.fleet.id.localeCompare(b.fleet.id);
        if (fleetDiff !== 0) return fleetDiff;
        return a.fleet.ships[a.shipIndex].id.localeCompare(b.fleet.ships[b.shipIndex].id);
    });
};

const isCombatLocked = (fleet: Fleet | undefined | null): boolean => fleet?.state === FleetState.COMBAT;

const toSurfacePos = (descriptor: PlanetSurfaceDescriptor, bodyId: string, tileId: number): SurfacePos => {
    const coord = getSurfaceTileCoordFromId(descriptor, tileId);
    return coord ? { bodyId, tileId, q: coord.q, r: coord.r } : { bodyId, tileId };
};

export const applyCommand = (state: GameState, command: GameCommand, rng: RNG, executionTurn?: number): CommandResult => {
    // Enforce Immutability in Dev
    deepFreezeDev(state);

    const fail = (error: string | FuelShortageError): CommandResult => ({ ok: false, state, error });
    const ok = (nextState: GameState, events?: string[]): CommandResult => ({ ok: true, state: nextState, events });

    switch (command.type) {
        case 'ORDER_GROUND_MOVE': {
            const army = state.armies.find(a => a.id === command.armyId);
            if (!army) return fail('Army not found');
            if (army.factionId !== state.playerFactionId) return fail('Not your army');
            if (army.state !== ArmyState.DEPLOYED) return fail('Army is not deployed on a planet surface.');

            const bodyId = command.to.bodyId;
            if (army.containerId !== bodyId) return fail('Army is not on the target body.');

            const descriptor = state.planetSurfaceDescriptorsByBodyId?.[bodyId];
            if (!descriptor) return fail('Missing surface descriptor for body.');

            const tileId = resolveSurfaceTileId(descriptor, command.to);
            if (tileId === null) return fail('Target is outside grid.');

            const tileResult = getTileAt(state, bodyId, tileId);
            if (!tileResult) return fail('Unable to resolve target tile.');
            if (!isPassable(tileResult.tile.biome)) return fail('Target tile is not passable.');

            const targetPos = toSurfacePos(tileResult.descriptor, bodyId, tileId);

            return ok({
                ...state,
                armies: state.armies.map(a => a.id === army.id
                    ? ({ ...a, groundOrders: { ...(a.groundOrders ?? {}), move: { type: 'move', to: targetPos } } })
                    : a)
            });
        }

        case 'ORDER_GROUND_ATTACK': {
            const attacker = state.armies.find(a => a.id === command.attackerId);
            const defender = state.armies.find(a => a.id === command.targetArmyId);
            if (!attacker) return fail('Attacker army not found');
            if (!defender) return fail('Target army not found');
            if (attacker.factionId !== state.playerFactionId) return fail('Not your army');
            if (attacker.id === defender.id) return fail('Invalid target');
            if (attacker.factionId === defender.factionId) return fail('Cannot attack friendly army.');
            if (attacker.state !== ArmyState.DEPLOYED || defender.state !== ArmyState.DEPLOYED) {
                return fail('Both armies must be deployed on a planet surface.');
            }
            if (attacker.containerId !== defender.containerId) return fail('Armies are not on the same body.');

            return ok({
                ...state,
                armies: state.armies.map(a => a.id === attacker.id
                    ? ({ ...a, groundOrders: { ...(a.groundOrders ?? {}), attack: { type: 'attack', targetArmyId: defender.id } } })
                    : a)
            });
        }

        case 'ORDER_GROUND_LAND': {
            const army = state.armies.find(a => a.id === command.armyId);
            if (!army) return fail('Army not found');
            if (army.state !== ArmyState.EMBARKED) return fail('Army is not embarked.');
            const carrierFleet = state.fleets.find(f => f.id === army.containerId);
            if (!carrierFleet) return fail('Carrier fleet not found.');

            const bodyId = command.to.bodyId;
            const planetMatch = getPlanetById(state.systems, bodyId);
            if (!planetMatch || !planetMatch.planet.isSolid) return fail('Invalid landing target.');
            if (!isFleetOrbitingSystem(carrierFleet, planetMatch.system)) return fail('Carrier fleet must be in orbit.');

            const descriptor = state.planetSurfaceDescriptorsByBodyId?.[bodyId];
            if (!descriptor) return fail('Missing surface descriptor for body.');

            const tileId = resolveSurfaceTileId(descriptor, command.to);
            if (tileId === null) return fail('Target is outside grid.');

            const tileResult = getTileAt(state, bodyId, tileId);
            if (!tileResult) return fail('Unable to resolve target tile.');

            const isAmphibious = GROUND_UNIT_STATS[army.unitType].tags?.includes('amphibious') ?? false;
            if (!isPassable(tileResult.tile.biome) && !isAmphibious) return fail('Target tile is not passable.');

            const deployedOnTile = state.armies.filter(a => {
                if (a.state !== ArmyState.DEPLOYED) return false;
                if (a.containerId !== bodyId) return false;
                if (!a.surfacePos) return false;
                const posTileId = resolveSurfaceTileId(descriptor, a.surfacePos);
                return posTileId === tileId;
            });
            const enemyOnTile = deployedOnTile.some(a => a.factionId !== army.factionId);
            if (enemyOnTile) return fail('Landing on enemy-occupied tile is not allowed.');
            const friendlyCount = deployedOnTile.filter(a => a.factionId === army.factionId).length;
            if (friendlyCount >= STACKING_CAP) return fail('Landing tile is at stacking capacity.');

            const targetPos = toSurfacePos(tileResult.descriptor, bodyId, tileId);

            return ok({
                ...state,
                armies: state.armies.map(a => a.id === army.id
                    ? ({ ...a, landingOrder: { type: 'land', to: targetPos } })
                    : a)
            });
        }

        case 'SET_GROUND_POSTURE': {
            const army = state.armies.find(a => a.id === command.armyId);
            if (!army) return fail('Army not found');
            if (army.factionId !== state.playerFactionId) return fail('Not your army');
            const postureSetTurn = Number.isFinite(executionTurn) ? executionTurn : state.day;
            return ok({
                ...state,
                armies: state.armies.map(a =>
                  a.id === army.id
                    ? (command.posture === 'prepared_defense'
                        ? ({ ...a, posture: command.posture, postureSetTurn })
                        : ({ ...a, posture: command.posture, postureSetTurn: undefined }))
                    : a
                )
            });
        }

        case 'CANCEL_GROUND_ORDER': {
            const army = state.armies.find(a => a.id === command.armyId);
            if (!army) return fail('Army not found');
            if (army.factionId !== state.playerFactionId) return fail('Not your army');
            return ok({
                ...state,
                armies: state.armies.map(a =>
                  a.id === army.id
                    ? ({ ...a, groundOrders: undefined, landingOrder: undefined })
                    : a
                )
            });
        }

        case 'MOVE_ARMY_ON_SURFACE': {
            const army = state.armies.find(a => a.id === command.armyId);
            if (!army) return fail('Army not found');
            if (army.state !== ArmyState.DEPLOYED) return fail('Army is not deployed on a planet surface.');

            const bodyId = command.to.bodyId;
            if (army.containerId !== bodyId) return fail('Army is not on the target body.');

            const descriptor = state.planetSurfaceDescriptorsByBodyId?.[bodyId];
            if (!descriptor) return fail('Missing surface descriptor for body.');

            const tileId = resolveSurfaceTileId(descriptor, command.to);
            if (tileId === null) return fail('Target is outside grid.');

            const tileResult = getTileAt(state, bodyId, tileId);
            if (!tileResult) return fail('Unable to resolve target tile.');
            if (!isPassable(tileResult.tile.biome)) return fail('Target tile is not passable.');

            const targetPos = toSurfacePos(tileResult.descriptor, bodyId, tileId);

            const nextState: GameState = {
                ...state,
                armies: state.armies.map(a => a.id === army.id ? ({
                  ...a,
                  surfacePos: targetPos
                }) : a)
            };

            return ok(nextState);
        }

        case 'BUILD_AT': {
            const { bodyId } = command.at;
            const descriptor = state.planetSurfaceDescriptorsByBodyId?.[bodyId];
            if (!descriptor) return fail('Missing surface descriptor for body.');

            if (!state.factions.some(f => f.id === command.factionId)) return fail('Unknown faction.');

            const tileId = resolveSurfaceTileId(descriptor, command.at);
            if (tileId === null) return fail('Target is outside grid.');

            const tileResult = getTileAt(state, bodyId, tileId);
            if (!tileResult) return fail('Unable to resolve target tile.');
            if (!isBuildable(tileResult.tile.biome)) return fail('Target tile is not buildable.');

            const buildings = state.groundBuildings ?? [];
            const occupied = buildings.some(b => {
                if (b.surfacePos.bodyId !== bodyId) return false;
                const bTileId = resolveSurfaceTileId(descriptor, b.surfacePos);
                return bTileId === tileId;
            });
            if (occupied) return fail('Tile already contains a building.');

            const targetPos = toSurfacePos(tileResult.descriptor, bodyId, tileId);
            const building = {
                id: rng.id('building'),
                factionId: command.factionId,
                type: command.buildingType,
                name: command.name,
                surfacePos: targetPos
            };

            return ok({
                ...state,
                groundBuildings: [...buildings, building]
            });
        }

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

            const validation = validateAndDebitJumpOrFail(fleet, system, state.systems, state.rules);
            if ('error' in validation) return fail(validation.error);

            // Structural Sharing Update
            return ok({
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    
                    // Locked fleets cannot move
                    if (fleet.retreating) return fleet;

                    const debitedFleet = validation.alreadyEnRoute ? fleet : validation.updatedFleet;
                    const nextStateStartTurn = validation.alreadyEnRoute ? fleet.stateStartTurn : stateStartTurn;

                    return {
                        ...debitedFleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        stateStartTurn: nextStateStartTurn,
                        invasionTargetSystemId: null, // Clear previous orders
                        invasionTargetPlanetId: null,
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

            const validation = validateAndDebitJumpOrFail(fleet, system, state.systems, state.rules);
            if ('error' in validation) return fail(validation.error);

            return ok({
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;

                    const debitedFleet = validation.alreadyEnRoute ? fleet : validation.updatedFleet;
                    const nextStateStartTurn = validation.alreadyEnRoute ? fleet.stateStartTurn : stateStartTurn;

                    return {
                        ...debitedFleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        stateStartTurn: nextStateStartTurn,
                        invasionTargetSystemId: system.id, // Set invasion order
                        invasionTargetPlanetId: command.targetPlanetId ?? null,
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

            const validation = validateAndDebitJumpOrFail(fleet, system, state.systems, state.rules);
            if ('error' in validation) return fail(validation.error);

            return ok({
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;

                    const debitedFleet = validation.alreadyEnRoute ? fleet : validation.updatedFleet;
                    const nextStateStartTurn = validation.alreadyEnRoute ? fleet.stateStartTurn : stateStartTurn;

                    return {
                        ...debitedFleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        stateStartTurn: nextStateStartTurn,
                        invasionTargetSystemId: null,
                        invasionTargetPlanetId: null,
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

            const validation = validateAndDebitJumpOrFail(fleet, system, state.systems, state.rules);
            if ('error' in validation) return fail(validation.error);

            return ok({
                ...state,
                fleets: state.fleets.map(fleet => {
                    if (fleet.id !== command.fleetId) return fleet;
                    if (fleet.retreating) return fleet;

                    const debitedFleet = validation.alreadyEnRoute ? fleet : validation.updatedFleet;
                    const nextStateStartTurn = validation.alreadyEnRoute ? fleet.stateStartTurn : stateStartTurn;

                    return {
                        ...debitedFleet,
                        state: FleetState.MOVING,
                        targetSystemId: system.id,
                        targetPosition: clone(system.position),
                        stateStartTurn: nextStateStartTurn,
                        invasionTargetSystemId: null,
                        invasionTargetPlanetId: null,
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

            const targetPlanet = command.targetPlanetId
              ? system.planets.find(planet => planet.id === command.targetPlanetId && planet.isSolid) ?? null
              : getDefaultSolidPlanet(system);
            if (!targetPlanet) return fail('No solid bodies available for landing.');

            const carriedArmyIds = new Set<string>(fleet.ships.map(ship => ship.carriedArmyId).filter((id): id is string => Boolean(id)));
            const embarkedArmies = sorted(
              state.armies.filter(army =>
                army.containerId === fleet.id &&
                army.factionId === fleet.factionId &&
                army.state === ArmyState.EMBARKED &&
                carriedArmyIds.has(army.id)
              ),
              (a, b) => a.id.localeCompare(b.id)
            );
            if (embarkedArmies.length === 0) return fail('No armies available to unload.');

            const map = generateSurfaceMapForState(state, targetPlanet.id);
            if (!map) return fail('Missing surface descriptor for body.');

            const occupancy = new Map<string, { enemy: boolean; friendlyCount: number }>();
            const toOccupancyKey = (pos: SurfacePos | null | undefined): string | null => {
              if (!pos) return null;
              const tileId = resolveSurfaceTileId(map.descriptor, pos);
              return tileId === null ? null : tileKey(tileId);
            };
            state.armies.forEach(army => {
              if (army.state !== ArmyState.DEPLOYED) return;
              if (army.containerId !== targetPlanet.id) return;
              if (!army.surfacePos) return;
              const key = toOccupancyKey(army.surfacePos);
              if (!key) return;
              const current = occupancy.get(key) ?? { enemy: false, friendlyCount: 0 };
              if (army.factionId === fleet.factionId) {
                occupancy.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
              } else {
                occupancy.set(key, { enemy: true, friendlyCount: current.friendlyCount });
              }
            });
            state.armies.forEach(army => {
              if (army.state !== ArmyState.EMBARKED) return;
              if (!army.landingOrder || army.landingOrder.to.bodyId !== targetPlanet.id) return;
              const key = toOccupancyKey(army.landingOrder.to);
              if (!key) return;
              const current = occupancy.get(key) ?? { enemy: false, friendlyCount: 0 };
              if (army.factionId === fleet.factionId) {
                occupancy.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
              } else {
                occupancy.set(key, { enemy: true, friendlyCount: current.friendlyCount });
              }
            });

            const embarkedIds = new Set(embarkedArmies.map(army => army.id));
            const landingPosByArmyId = new Map<string, SurfacePos>();

            const isOccupied = (tileId: number): boolean => {
              const entry = occupancy.get(tileKey(tileId));
              if (!entry) return false;
              if (entry.enemy) return true;
              return entry.friendlyCount >= STACKING_CAP;
            };

            embarkedArmies.forEach(army => {
              const chosen =
                pickLandingSurfacePosForArmy({ state, map, army, isOccupied }) ??
                pickLandingSurfacePosForArmy({ state, map, army });
              if (!chosen) return;
              const chosenTileId = resolveSurfaceTileId(map.descriptor, chosen);
              if (chosenTileId === null) return;
              landingPosByArmyId.set(army.id, chosen);
              const key = tileKey(chosenTileId);
              const current = occupancy.get(key) ?? { enemy: false, friendlyCount: 0 };
              occupancy.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
            });

            if (landingPosByArmyId.size === 0) return fail('Unable to choose landing position.');

            const nextArmies: Army[] = state.armies.map(army => {
              if (!embarkedIds.has(army.id)) return army;
              const chosen = landingPosByArmyId.get(army.id);
              if (!chosen) return army;
              return { ...army, landingOrder: { type: 'land', to: chosen } };
            });

            return ok({
              ...state,
              armies: nextArmies
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

            const bodyId = targetPlanet.planet.id;
            const map = generateSurfaceMapForState(state, bodyId);
            if (!map) return fail('Missing surface descriptor for body.');

            const occupancy = new Map<string, { enemy: boolean; friendlyCount: number }>();
            const toOccupancyKey = (pos: SurfacePos | null | undefined): string | null => {
              if (!pos) return null;
              const tileId = resolveSurfaceTileId(map.descriptor, pos);
              return tileId === null ? null : tileKey(tileId);
            };
            state.armies.forEach(other => {
              if (other.state !== ArmyState.DEPLOYED) return;
              if (other.containerId !== bodyId) return;
              if (!other.surfacePos) return;
              const key = toOccupancyKey(other.surfacePos);
              if (!key) return;
              const current = occupancy.get(key) ?? { enemy: false, friendlyCount: 0 };
              if (other.factionId === fleet.factionId) {
                occupancy.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
              } else {
                occupancy.set(key, { enemy: true, friendlyCount: current.friendlyCount });
              }
            });
            state.armies.forEach(other => {
              if (other.state !== ArmyState.EMBARKED) return;
              if (!other.landingOrder || other.landingOrder.to.bodyId !== bodyId) return;
              const key = toOccupancyKey(other.landingOrder.to);
              if (!key) return;
              const current = occupancy.get(key) ?? { enemy: false, friendlyCount: 0 };
              if (other.factionId === fleet.factionId) {
                occupancy.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
              } else {
                occupancy.set(key, { enemy: true, friendlyCount: current.friendlyCount });
              }
            });

            const isOccupied = (tileId: number): boolean => {
              const entry = occupancy.get(tileKey(tileId));
              if (!entry) return false;
              if (entry.enemy) return true;
              return entry.friendlyCount >= STACKING_CAP;
            };
            const chosen =
              pickLandingSurfacePosForArmy({ state, map, army, isOccupied }) ??
              pickLandingSurfacePosForArmy({ state, map, army });
            if (!chosen) return fail('Unable to choose landing position.');

            const chosenTileId = resolveSurfaceTileId(map.descriptor, chosen);
            if (chosenTileId === null) return fail('Unable to choose landing position.');
            const key = tileKey(chosenTileId);
            const current = occupancy.get(key) ?? { enemy: false, friendlyCount: 0 };
            occupancy.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });

            return ok({
              ...state,
              armies: state.armies.map(a => a.id === army.id ? ({ ...a, landingOrder: { type: 'land', to: chosen } }) : a)
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

            const nextState = {
                ...state,
                fleets: updatedFleets,
                armies: updatedArmies,
                logs: [...state.logs, transferLog]
            };

            return ok(normalizeSurfacePositions(nextState));
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
                invasionTargetPlanetId: fleet.invasionTargetPlanetId ?? null,
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
