
import { Fleet, FleetState, StarSystem, LogEntry, ArmyState, Army, ShipEntity } from '../../types';
import { RNG } from '../../engine/rng';
import { getFleetSpeed } from './fleetSpeed';
import { shortId } from '../../engine/idUtils';
import { sub, len, normalize, scale, add, clone, distSq } from '../../engine/math/vec3';
import { computeLoadOps, computeUnloadOps } from '../../engine/armyOps';
import { CAPTURE_RANGE } from '../../data/static';

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

export const isOrbitContested = (system: StarSystem, fleets: Fleet[]): boolean => {
    const captureSq = CAPTURE_RANGE * CAPTURE_RANGE;
    const factionsInRange = new Set(
        fleets
            .filter(fleet => fleet.ships.length > 0 && distSq(fleet.position, system.position) <= captureSq)
            .map(fleet => fleet.factionId)
    );

    return factionsInRange.size >= 2;
};

interface MovementStepResult {
    fleet: Fleet;
    arrivalSystemId?: string;
    logs: LogEntry[];
}

const moveFleet = (
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
            loadTargetSystemId: null,
            unloadTargetSystemId: null
        },
        arrivalSystemId,
        logs: arrivalLog
    };
};

const applyContestedDeploymentRisk = (
    fleet: Fleet,
    system: StarSystem,
    armies: Army[],
    rng: RNG,
    day: number,
    contested: boolean
): { fleet: Fleet; armies: Army[]; deployed: number; failed: number; logs: LogEntry[] } => {
    let deployedCount = 0;
    let failedCount = 0;
    const logs: LogEntry[] = [];

    const shipIdByArmyId = fleet.ships.reduce<Record<string, string>>((map, ship) => {
        if (ship.carriedArmyId) {
            map[ship.carriedArmyId] = ship.id;
        }
        return map;
    }, {});

    const shipIndexById = fleet.ships.reduce<Record<string, number>>((map, ship, index) => {
        map[ship.id] = index;
        return map;
    }, {});

    let shipsChanged = false;
    const updatedShips: ShipEntity[] = fleet.ships.map(ship => ship as ShipEntity);

    const updatedArmies = armies.map(army => {
        if (army.containerId !== fleet.id || army.state !== ArmyState.EMBARKED) return army;

        const carrierShipId = shipIdByArmyId[army.id];
        if (!carrierShipId) return army;

        const carrierIndex = shipIndexById[carrierShipId];
        if (carrierIndex === undefined) return army;

        const carrierShip = updatedShips[carrierIndex];
        if (!carrierShip || carrierShip.carriedArmyId !== army.id) return army;

        const dropRoll = contested ? rng.next() : 1;
        const dropFailed = contested && dropRoll < 0.35;

        if (dropFailed) {
            failedCount++;
            const strengthLoss = Math.max(1, Math.floor(army.strength * 0.35));
            const remainingStrength = Math.max(0, army.strength - strengthLoss);

            logs.push({
                id: rng.id('log'),
                day,
                text: `Dropships took fire while deploying army ${army.id} at ${system.name}, losing ${strengthLoss} strength and aborting landing.`,
                type: 'combat'
            });

            return { ...army, strength: remainingStrength };
        }

        updatedShips[carrierIndex] = { ...carrierShip, carriedArmyId: null } as ShipEntity;
        shipsChanged = true;
        deployedCount++;

        return {
            ...army,
            state: ArmyState.DEPLOYED,
            containerId: system.id
        };
    });

    const fleetAfterDrop = shipsChanged ? { ...fleet, ships: updatedShips } : fleet;
    return { fleet: fleetAfterDrop, armies: updatedArmies, deployed: deployedCount, failed: failedCount, logs };
};

const executeArrivalOperations = (
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

    // --- AUTO UNLOAD (ALLIED SYSTEMS) ---
    if (fleet.unloadTargetSystemId === system.id && system.ownerFactionId === fleet.factionId) {
        const unloadResult = computeUnloadOps({
            fleet: currentFleet,
            system,
            armies: armiesAfterOps,
            day,
            rng,
            fleetLabel: shortId(fleet.id)
        });

        if (unloadResult.count > 0) {
            generatedLogs.push(...unloadResult.logs);
            currentFleet = unloadResult.fleet;
            armiesAfterOps = unloadResult.armies;
            shipsChanged = true;
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
        const contested = isOrbitContested(system, fleets);
        const deploymentOutcome = applyContestedDeploymentRisk(currentFleet, system, armiesAfterOps, rng, day, contested);

        armiesAfterOps = deploymentOutcome.armies;
        currentFleet = deploymentOutcome.fleet;
        shipsChanged = shipsChanged || deploymentOutcome.deployed > 0;
        generatedLogs.push(...deploymentOutcome.logs);

        if (deploymentOutcome.deployed > 0) {
            const baseText = `INVASION STARTED: Fleet ${shortId(fleet.id)} deployed ${deploymentOutcome.deployed} armies onto ${system.name}.`;
            const suffix = contested && deploymentOutcome.failed > 0 ? ' Orbit is contested, expect resistance.' : '';

            generatedLogs.push({
                id: rng.id('log'),
                day,
                text: `${baseText}${suffix}`.trim(),
                type: 'combat'
            });
        } else if (deploymentOutcome.failed > 0) {
            generatedLogs.push({
                id: rng.id('log'),
                day,
                text: `Deployment aborted: ${deploymentOutcome.failed} armies could not land on ${system.name} due to contested orbit.`,
                type: 'combat'
            });
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

  const moveResult = moveFleet(fleet, systems, day, rng);
  let armiesAfterOps: Army[] = allArmies;
  let nextFleet: Fleet = moveResult.fleet;
  const generatedLogs: LogEntry[] = [...moveResult.logs];
  const fleetContext = fleets.map(existing => (existing.id === fleet.id ? moveResult.fleet : existing));

  if (moveResult.arrivalSystemId) {
      const system = systems.find(s => s.id === moveResult.arrivalSystemId);
      if (system) {
          const arrivalOutcome = executeArrivalOperations(moveResult.fleet, system, armiesAfterOps, fleetContext, rng, day);
          armiesAfterOps = arrivalOutcome.armies;
          nextFleet = arrivalOutcome.fleet;
          generatedLogs.push(...arrivalOutcome.logs);
      }
  }

  return { nextFleet, logs: generatedLogs, armyUpdates: computeArmyUpdates(allArmies, armiesAfterOps) };
};
