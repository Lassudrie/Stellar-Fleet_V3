import { BASE_FLEET_SPEED, SHIP_STATS } from '../content/data/static';
import { MS_PER_DAY, sorted } from '../shared/shared';
import type { Army, Fleet, GameState, LogEntry, StarSystem, SurfacePos } from '../shared/shared';
import { ArmyState, FleetState } from '../shared/shared';
import { computeLoadOps } from './armyOps';
import { shortId } from '../shared/shared';
import { add, clone, len, normalize, scale, sub } from './math/vec3';
import { isOrbitContested } from './orbit';
import { RNG } from './rng';
import { getDefaultSolidPlanet } from './planets';
import { generateSurfaceMapForState, pickLandingSurfacePosForArmy, resolveSurfaceTileId } from './planetSurface';
import { STACKING_CAP, tileKey } from './ground';

// -----------------------------------------
// Fleet speed (was: movement/fleetSpeed.ts)
// -----------------------------------------

/**
 * Calculates the movement speed of a fleet per day.
 * Rule: A fleet moves as fast as its slowest ship.
 * Formula: BASE_FLEET_SPEED * min(ship.speedModifier)
 */
export const getFleetSpeed = (fleet: Fleet): number => {
  if (!fleet.ships || fleet.ships.length === 0) return BASE_FLEET_SPEED;

  let minSpeedModifier = Infinity;

  for (const ship of fleet.ships) {
    if (!ship || !ship.type) continue; // Defensive check for undefined ships

    const stats = SHIP_STATS[ship.type];
    if (stats && stats.speed < minSpeedModifier) {
      minSpeedModifier = stats.speed;
    }
  }

  // Fallback to 1.0 modifier if logic fails (e.g. unknown ship type), though unlikely
  if (minSpeedModifier === Infinity) minSpeedModifier = 1.0;

  return BASE_FLEET_SPEED * minSpeedModifier;
};

// ---------------------------------------------
// Movement phase helpers (was: movementPhase.ts)
// ---------------------------------------------

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
    if (before.members !== army.members) changes.members = army.members;
    if (before.condition !== army.condition) changes.condition = army.condition;
    if (before.landingOrder !== army.landingOrder) changes.landingOrder = army.landingOrder;

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
  timeMs: number,
  deltaMs: number,
  rng: RNG
): MovementStepResult => {
  if (fleet.state !== FleetState.MOVING || !fleet.targetPosition) {
    return { fleet, logs: [] };
  }

  const dir = sub(fleet.targetPosition, fleet.position);
  const dist = len(dir);
  const moveDistance = getFleetSpeed(fleet) * (deltaMs / MS_PER_DAY);

  if (dist > moveDistance) {
    const moveVec = scale(normalize(dir), moveDistance);
    const newPos = add(fleet.position, moveVec);
    return { fleet: { ...fleet, position: newPos }, logs: [] };
  }

  const arrivalSystemId = fleet.targetSystemId ?? undefined;
  const arrivalSystem = arrivalSystemId ? systems.find(s => s.id === arrivalSystemId) : undefined;
  const arrivalLog: LogEntry[] = arrivalSystem
    ? [
        {
          id: rng.id('log'),
          timeMs,
          text: `Fleet ${shortId(fleet.id)} (${fleet.factionId}) arrived at ${arrivalSystem.name}.`,
          type: 'move' as const
        }
      ]
    : [];

  return {
    fleet: {
      ...fleet,
      position: clone(fleet.targetPosition),
      state: FleetState.ORBIT,
      stateStartTimeMs: timeMs,
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
  state: GameState,
  fleet: Fleet,
  system: StarSystem,
  armies: Army[],
  fleets: Fleet[],
  rng: RNG,
  timeMs: number
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
    if (defaultPlanet) {
      const map = generateSurfaceMapForState(state, defaultPlanet.id);
      const carriedArmyIds = new Set<string>(
        currentFleet.ships.map(ship => ship.carriedArmyId).filter((id): id is string => Boolean(id))
      );
      const embarkedArmies = sorted(
        armiesAfterOps.filter(army =>
          army.containerId === currentFleet.id &&
          army.state === ArmyState.EMBARKED &&
          army.factionId === currentFleet.factionId &&
          carriedArmyIds.has(army.id)
        ),
        (a, b) => a.id.localeCompare(b.id)
      );

      if (map && embarkedArmies.length > 0) {
        const occupancy = new Map<string, { enemy: boolean; friendlyCount: number }>();
        const toOccupancyKey = (pos: Army['surfacePos'] | null | undefined): string | null => {
          if (!pos) return null;
          const tileId = resolveSurfaceTileId(map.descriptor, pos);
          return tileId === null ? null : tileKey(tileId);
        };
        armiesAfterOps.forEach(other => {
          if (other.state !== ArmyState.DEPLOYED) return;
          if (other.containerId !== defaultPlanet.id) return;
          if (!other.surfacePos) return;
          const key = toOccupancyKey(other.surfacePos);
          if (!key) return;
          const current = occupancy.get(key) ?? { enemy: false, friendlyCount: 0 };
          if (other.factionId === currentFleet.factionId) {
            occupancy.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
          } else {
            occupancy.set(key, { enemy: true, friendlyCount: current.friendlyCount });
          }
        });
        armiesAfterOps.forEach(other => {
          if (other.state !== ArmyState.EMBARKED) return;
          if (!other.landingOrder || other.landingOrder.to.bodyId !== defaultPlanet.id) return;
          const key = toOccupancyKey(other.landingOrder.to);
          if (!key) return;
          const current = occupancy.get(key) ?? { enemy: false, friendlyCount: 0 };
          if (other.factionId === currentFleet.factionId) {
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

        const landingPosByArmyId = new Map<string, SurfacePos>();
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

        if (landingPosByArmyId.size > 0) {
          armiesAfterOps = armiesAfterOps.map(army => {
            const pos = landingPosByArmyId.get(army.id);
            if (!pos) return army;
            return { ...army, landingOrder: { type: 'land', to: pos } };
          });
          const suffix = contestedOrbit ? ' Orbit is contested, landing losses will increase.' : '';
          generatedLogs.push({
            id: rng.id('log'),
            timeMs,
            text: `Fleet ${shortId(fleet.id)} queued ${landingPosByArmyId.size} landings in ${system.name}.${suffix}`.trim(),
            type: 'move'
          });
        }
      }
    }
  }

  // --- AUTO LOAD (ALLY ARMIES) ---
  if (fleet.loadTargetSystemId === system.id) {
    const loadResult = computeLoadOps({
      fleet: currentFleet,
      system,
      armies: armiesAfterOps,
      timeMs,
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
        timeMs,
        text: `Invasion aborted: Fleet ${shortId(fleet.id)} reached ${system.name}, but the system has no solid bodies to land on. The invasion order has been cleared.`,
        type: 'combat'
      });
    } else {
      const embarkedArmies = sorted(
        armiesAfterOps.filter(army => army.containerId === currentFleet.id && army.state === ArmyState.EMBARKED),
        (a, b) => a.id.localeCompare(b.id)
      );

      const attackerHasGroundPresence = (planetId: string): boolean =>
        armiesAfterOps.some(
          army => army.containerId === planetId && army.state === ArmyState.DEPLOYED && army.factionId === currentFleet.factionId
        );

      const planetDefenseStrength = (planetId: string): number =>
        armiesAfterOps
          .filter(army => army.containerId === planetId && army.state === ArmyState.DEPLOYED && army.factionId !== currentFleet.factionId)
          .reduce((total, army) => total + army.members, 0);

      const eligibleTargets = system.planets.filter(
        planet => planet.isSolid && planet.ownerFactionId !== currentFleet.factionId && !attackerHasGroundPresence(planet.id)
      );

      const prioritizedTargets = sorted(
        eligibleTargets.map(planet => ({ planet, defense: planetDefenseStrength(planet.id) })).filter(entry => entry.defense > 0),
        (a, b) => b.defense - a.defense || a.planet.id.localeCompare(b.planet.id)
      ).map(entry => entry.planet);

      const fallbackTargets = prioritizedTargets.length === 0 ? sorted(eligibleTargets, (a, b) => a.id.localeCompare(b.id)) : [];

      const defaultTarget = invasionPlanet && !attackerHasGroundPresence(invasionPlanet.id) ? invasionPlanet : null;

      const targetQueue = (
        prioritizedTargets.length > 0
          ? prioritizedTargets
          : fallbackTargets.length > 0
            ? fallbackTargets
            : defaultTarget
              ? [defaultTarget]
              : []
      ).filter((planet, index, arr) => arr.findIndex(p => p.id === planet.id) === index);

      if (embarkedArmies.length > 0 && targetQueue.length > 0) {
        const targetPlanetsById = new Map(targetQueue.map(planet => [planet.id, planet]));
        const carriedArmyIds = new Set<string>(
          currentFleet.ships.map(ship => ship.carriedArmyId).filter((id): id is string => Boolean(id))
        );
        const carriedEmbarkedArmies = embarkedArmies.filter(army => carriedArmyIds.has(army.id));

        const mapByPlanetId = new Map<string, ReturnType<typeof generateSurfaceMapForState> | null>();
        const getMap = (planetId: string) => {
          if (mapByPlanetId.has(planetId)) return mapByPlanetId.get(planetId) ?? null;
          const map = generateSurfaceMapForState(state, planetId);
          mapByPlanetId.set(planetId, map ?? null);
          return map ?? null;
        };

        const occupancyByPlanetId = new Map<string, Map<string, { enemy: boolean; friendlyCount: number }>>();
        const getOccupancy = (planetId: string) => {
          const cached = occupancyByPlanetId.get(planetId);
          if (cached) return cached;
          const occ = new Map<string, { enemy: boolean; friendlyCount: number }>();
          const map = getMap(planetId);
          if (!map) {
            occupancyByPlanetId.set(planetId, occ);
            return occ;
          }
          const toOccupancyKey = (pos: Army['surfacePos'] | null | undefined): string | null => {
            if (!pos) return null;
            const tileId = resolveSurfaceTileId(map.descriptor, pos);
            return tileId === null ? null : tileKey(tileId);
          };
          armiesAfterOps.forEach(other => {
            if (other.state !== ArmyState.DEPLOYED) return;
            if (other.containerId !== planetId) return;
            if (!other.surfacePos) return;
            const key = toOccupancyKey(other.surfacePos);
            if (!key) return;
            const current = occ.get(key) ?? { enemy: false, friendlyCount: 0 };
            if (other.factionId === currentFleet.factionId) {
              occ.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
            } else {
              occ.set(key, { enemy: true, friendlyCount: current.friendlyCount });
            }
          });
          armiesAfterOps.forEach(other => {
            if (other.state !== ArmyState.EMBARKED) return;
            if (!other.landingOrder || other.landingOrder.to.bodyId !== planetId) return;
            const key = toOccupancyKey(other.landingOrder.to);
            if (!key) return;
            const current = occ.get(key) ?? { enemy: false, friendlyCount: 0 };
            if (other.factionId === currentFleet.factionId) {
              occ.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
            } else {
              occ.set(key, { enemy: true, friendlyCount: current.friendlyCount });
            }
          });
          occupancyByPlanetId.set(planetId, occ);
          return occ;
        };

        const landingPosByArmyId = new Map<string, SurfacePos>();
        carriedEmbarkedArmies.forEach((army, index) => {
          const targetPlanet = targetQueue[index % targetQueue.length];
          const map = getMap(targetPlanet.id);
          if (!map) return;
          const occ = getOccupancy(targetPlanet.id);
          const isOccupied = (tileId: number): boolean => {
            const entry = occ.get(tileKey(tileId));
            if (!entry) return false;
            if (entry.enemy) return true;
            return entry.friendlyCount >= STACKING_CAP;
          };
          const chosen =
            pickLandingSurfacePosForArmy({ state, map, army, isOccupied }) ??
            pickLandingSurfacePosForArmy({ state, map, army });
          if (!chosen) return;
          const chosenTileId = resolveSurfaceTileId(map.descriptor, chosen);
          if (chosenTileId === null) return;
          landingPosByArmyId.set(army.id, chosen);
          const key = tileKey(chosenTileId);
          const current = occ.get(key) ?? { enemy: false, friendlyCount: 0 };
          occ.set(key, { enemy: current.enemy, friendlyCount: current.friendlyCount + 1 });
        });

        if (landingPosByArmyId.size > 0) {
          armiesAfterOps = armiesAfterOps.map(army => {
            const pos = landingPosByArmyId.get(army.id);
            if (!pos) return army;
            return { ...army, landingOrder: { type: 'land', to: pos } };
          });

          const distinctPlanets = sorted(
            Array.from(new Set(Array.from(landingPosByArmyId.values()).map(pos => pos.bodyId))),
            (a, b) => a.localeCompare(b)
          );
          const planetLabels = distinctPlanets.map(id => targetPlanetsById.get(id)?.name ?? id);
          const suffix = contestedOrbit ? ' Orbit is contested, landing losses will increase.' : '';

          generatedLogs.push({
            id: rng.id('log'),
            timeMs,
            text: `INVASION STARTED: Fleet ${shortId(fleet.id)} queued ${landingPosByArmyId.size} landings onto ${planetLabels.join(', ')} in ${system.name}.${suffix}`.trim(),
            type: 'combat'
          });
        }
      } else if (embarkedArmies.length > 0) {
        generatedLogs.push({
          id: rng.id('log'),
          timeMs,
          text: `Invasion skipped: Fleet ${shortId(fleet.id)} found no eligible planets to target in ${system.name}.`,
          type: 'combat'
        });
      }
    }
  }

  const finalFleet = shipsChanged ? currentFleet : fleet;
  return { fleet: finalFleet, armies: armiesAfterOps, logs: generatedLogs };
};

// Pure function to resolve movement for a single fleet
export const resolveFleetMovement = (
  state: GameState,
  fleet: Fleet,
  systems: StarSystem[],
  allArmies: Army[],
  timeMs: number,
  deltaMs: number,
  rng: RNG,
  fleets: Fleet[]
): FleetMovementResult => {
  const invasionTargetSystemId = fleet.invasionTargetSystemId;
  const invasionTargetPlanetId = fleet.invasionTargetPlanetId;
  const loadTargetSystemId = fleet.loadTargetSystemId;
  const unloadTargetSystemId = fleet.unloadTargetSystemId;

  const moveResult = moveFleet(fleet, systems, timeMs, deltaMs, rng);
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

      const arrivalOutcome = executeArrivalOperations(state, arrivalFleet, system, armiesAfterOps, fleetContext, rng, timeMs);
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
