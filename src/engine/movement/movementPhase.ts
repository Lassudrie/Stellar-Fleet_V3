
import { Fleet, FleetState, StarSystem, LogEntry, ArmyState, Army, ShipEntity } from '../../shared/types';
import { RNG } from '../rng';
import { getFleetSpeed } from './fleetSpeed';
import { shortId } from '../idUtils';
import { sub, len, normalize, scale, add, clone } from '../math/vec3';
import { applyContestedLandingRisk, computeLoadOps, computeUnloadOps } from '../armyOps';
import { isOrbitContested } from '../orbit';
import { getDefaultSolidPlanet } from '../planets';

export interface ArmyUpdate {
    id: string;
    changes: Partial<Army>;
}

const computeArmyUpdates = (previous: Army[], next: Army[]): ArmyUpdate[] => {
    const beforeById = previous.reduce<Record<string, Army>>((map, army) => {
        map[army.id] = army;
        return map;
    }, {});

    return next.reduce<ArmyUpdate[]>((updates, army) => {
        const before = beforeById[army.id];
        if (!before || before === army) return updates;

        const changes: Partial<Army> = {};
        if (before.state !== army.state) changes.state = army.state;
        if (before.containerId !== army.containerId) changes.containerId = army.containerId;
        if (before.strength !== army.strength) changes.strength = army.strength;
        if (before.morale !== army.morale) changes.morale = army.morale;

        if (Object.keys(changes).length === 0) return updates;
        updates.push({ id: army.id, changes });
        return updates;
    }, []);
};

export interface FleetMovementResult {
    nextFleet: Fleet;
    logs: LogEntry[];
    armyUpdates: ArmyUpdate[];
}

export interface MovementStepResult {
    fleet: Fleet;
    arrivalSystemId?: string;
    logs: LogEntry[];
}

export const moveFleet = (
    fleet: Fleet,
    systems: StarSystem[],
    day: number,
    rng: RNG
): MovementStepResult => {
    if (fleet.state !== FleetState.MOVING || !fleet.targetPosition) {
        return { fleet, logs: [] };
    }

    const dir = sub(fleet.targetPosition, fleet.position);
    const dist = len(dir);
    const moveDistance = getFleetSpeed(fleet);

    if (dist > moveDistance) {
        const moveVec = scale(normalize(dir), moveDistance);
        const newPos = add(fleet.position, moveVec);
        return { fleet: { ...fleet, position: newPos }, logs: [] };
    }

    const arrivalSystemId = fleet.targetSystemId ?? undefined;
    const arrivalSystem = arrivalSystemId ? systems.find(s => s.id === arrivalSystemId) : undefined;
    const arrivalLog: LogEntry[] = arrivalSystem
        ? [{
              id: rng.id('log'),
              day,
              text: `Fleet ${shortId(fleet.id)} (${fleet.factionId}) arrived at ${arrivalSystem.name}.`,
              type: 'move' as const
          }]
        : [];

    return {
        fleet: {
            ...fleet,
            position: clone(fleet.targetPosition),
            state: FleetState.ORBIT,
            stateStartTurn: day,
            targetPosition: null,
            targetSystemId: null,
            retreating: false,
            invasionTargetSystemId: null,
            invasionTargetPlanetId: null,
            loadTargetSystemId: null,
            unloadTargetSystemId: null
        },
        arrivalSystemId,
        logs: arrivalLog
    };
};

export const executeArrivalOperations = (
    fleet: Fleet,
    system: StarSystem,
    armies: Army[],
    fleets: Fleet[],
    rng: RNG,
    day: number
): { fleet: Fleet; armies: Army[]; logs: LogEntry[] } => {
    const generatedLogs: LogEntry[] = [];
    let currentFleet = fleet;
    let armiesAfterOps = armies;
    let shipsChanged = false;
    const contestedOrbit = isOrbitContested(system, fleets);
    const defaultPlanet = getDefaultSolidPlanet(system);
    const preferredInvasionPlanet = fleet.invasionTargetPlanetId
        ? system.planets.find(planet => planet.id === fleet.invasionTargetPlanetId && planet.isSolid)
        : null;
    const invasionPlanet = preferredInvasionPlanet ?? defaultPlanet;

    // --- AUTO UNLOAD (ALLIED SYSTEMS) ---
    if (fleet.unloadTargetSystemId === system.id && system.ownerFactionId === fleet.factionId) {
        const unloadResult = computeUnloadOps({
            fleet: currentFleet,
            system,
            armies: armiesAfterOps,
            day,
            rng,
            targetPlanetId: defaultPlanet?.id,
            fleetLabel: shortId(fleet.id)
        });

        if (unloadResult.count > 0) {
            generatedLogs.push(...unloadResult.logs);
            currentFleet = unloadResult.fleet;
            armiesAfterOps = unloadResult.armies;
            shipsChanged = true;

            if (contestedOrbit && unloadResult.unloadedArmyIds && unloadResult.unloadedArmyIds.length > 0) {
                const riskOutcome = applyContestedLandingRisk({
                    mode: 'always_land',
                    armies: armiesAfterOps,
                    targetArmyIds: unloadResult.unloadedArmyIds,
                    systemName: system.name,
                    planetName: defaultPlanet?.name,
                    targetPlanetId: defaultPlanet?.id,
                    day,
                    rng
                });
                armiesAfterOps = riskOutcome.armies;
                generatedLogs.push(...riskOutcome.logs);
            }
        }
    }

    // --- AUTO LOAD (ALLY ARMIES) ---
    if (fleet.loadTargetSystemId === system.id) {
        const loadResult = computeLoadOps({
            fleet: currentFleet,
            system,
            armies: armiesAfterOps,
            day,
            rng,
            fleetLabel: shortId(fleet.id)
        });

        if (loadResult.count > 0) {
            generatedLogs.push(...loadResult.logs);
            currentFleet = loadResult.fleet;
            armiesAfterOps = loadResult.armies;
            shipsChanged = true;
        }
    }

    // --- AUTO INVASION LOGIC ---
    if (fleet.invasionTargetSystemId === system.id) {
        if (!invasionPlanet) {
            generatedLogs.push({
                id: rng.id('log'),
                day,
                text: `Invasion aborted: Fleet ${shortId(fleet.id)} reached ${system.name}, but the system has no solid bodies to land on. The invasion order has been cleared.`,
                type: 'combat'
            });
        } else {
            const embarkedArmies = armiesAfterOps.filter(
                army => army.containerId === currentFleet.id && army.state === ArmyState.EMBARKED
            );

            if (embarkedArmies.length > 0) {
                let landingOutcome: { armies: Army[]; logs: LogEntry[]; succeeded: string[]; failed: string[] };

                if (contestedOrbit) {
                    landingOutcome = applyContestedLandingRisk({
                        mode: 'abort',
                        armies: armiesAfterOps,
                        targetArmyIds: embarkedArmies.map(army => army.id),
                        systemName: system.name,
                        planetName: invasionPlanet.name,
                        targetPlanetId: invasionPlanet.id,
                        day,
                        rng
                    });
                } else {
                    const landedArmyIds = new Set(embarkedArmies.map(army => army.id));
                    const updatedArmies = armiesAfterOps.map(army => landedArmyIds.has(army.id)
                        ? { ...army, state: ArmyState.DEPLOYED, containerId: invasionPlanet.id }
                        : army);
                    landingOutcome = { armies: updatedArmies, logs: [], succeeded: [...landedArmyIds], failed: [] };
                }

                armiesAfterOps = landingOutcome.armies;
                generatedLogs.push(...landingOutcome.logs);

                if (landingOutcome.succeeded.length > 0) {
                    const succeededSet = new Set(landingOutcome.succeeded);
                    const updatedShips = currentFleet.ships.map(ship => {
                        if (ship.carriedArmyId && succeededSet.has(ship.carriedArmyId)) {
                            shipsChanged = true;
                            return { ...ship, carriedArmyId: null };
                        }
                        return ship;
                    }) as ShipEntity[];
                    currentFleet = shipsChanged ? { ...currentFleet, ships: updatedShips } : currentFleet;
                }

                const deployedCount = landingOutcome.succeeded.length;
                const failedCount = landingOutcome.failed.length;

                if (deployedCount > 0) {
                    const baseText = `INVASION STARTED: Fleet ${shortId(fleet.id)} deployed ${deployedCount} armies onto ${invasionPlanet.name} (${system.name}).`;
                    const suffix = contestedOrbit && failedCount > 0 ? ' Orbit is contested, expect resistance.' : '';

                    generatedLogs.push({
                        id: rng.id('log'),
                        day,
                        text: `${baseText}${suffix}`.trim(),
                        type: 'combat'
                    });
                } else if (failedCount > 0) {
                    generatedLogs.push({
                        id: rng.id('log'),
                        day,
                        text: `Deployment aborted: ${failedCount} armies could not land on ${invasionPlanet.name} (${system.name}) due to contested orbit.`,
                        type: 'combat'
                    });
                }
            }
        }
    }

    const finalFleet = shipsChanged ? currentFleet : fleet;
    return { fleet: finalFleet, armies: armiesAfterOps, logs: generatedLogs };
};

// Pure function to resolve movement for a single fleet
export const resolveFleetMovement = (
  fleet: Fleet,
  systems: StarSystem[],
  allArmies: Army[],
  day: number,
  rng: RNG,
  fleets: Fleet[]
): FleetMovementResult => {
  const invasionTargetSystemId = fleet.invasionTargetSystemId;
  const invasionTargetPlanetId = fleet.invasionTargetPlanetId;
  const loadTargetSystemId = fleet.loadTargetSystemId;
  const unloadTargetSystemId = fleet.unloadTargetSystemId;

  const moveResult = moveFleet(fleet, systems, day, rng);
  let armiesAfterOps: Army[] = allArmies;
  let nextFleet: Fleet = moveResult.fleet;
  const generatedLogs: LogEntry[] = [...moveResult.logs];
  const fleetContext = fleets.map(existing => (existing.id === fleet.id ? moveResult.fleet : existing));

  if (moveResult.arrivalSystemId) {
      const system = systems.find(s => s.id === moveResult.arrivalSystemId);
      if (system) {
          const arrivalFleet: Fleet = {
              ...moveResult.fleet,
              invasionTargetSystemId,
              invasionTargetPlanetId,
              loadTargetSystemId,
              unloadTargetSystemId
          };

          const arrivalOutcome = executeArrivalOperations(arrivalFleet, system, armiesAfterOps, fleetContext, rng, day);
          armiesAfterOps = arrivalOutcome.armies;
          nextFleet = {
              ...arrivalOutcome.fleet,
              invasionTargetSystemId: null,
              invasionTargetPlanetId: null,
              loadTargetSystemId: null,
              unloadTargetSystemId: null
          };
          generatedLogs.push(...arrivalOutcome.logs);
      }
  }

  return { nextFleet, logs: generatedLogs, armyUpdates: computeArmyUpdates(allArmies, armiesAfterOps) };
};
