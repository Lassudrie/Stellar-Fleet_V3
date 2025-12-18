
import { Fleet, FleetState, StarSystem, LogEntry, ArmyState, Army, ShipEntity } from '../../types';
import { RNG } from '../../engine/rng';
import { getFleetSpeed } from './fleetSpeed';
import { shortId } from '../../engine/idUtils';
import { sub, len, normalize, scale, add, clone } from '../../engine/math/vec3';
import { computeLoadOps, computeUnloadOps } from '../../engine/armyOps';

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

// Pure function to resolve movement for a single fleet
export const resolveFleetMovement = (
  fleet: Fleet, 
  systems: StarSystem[],
  allArmies: Army[],
  day: number,
  rng: RNG
): FleetMovementResult => {

  const generatedLogs: LogEntry[] = [];
  let armiesAfterOps: Army[] = allArmies;

  // Default: Next fleet is current fleet (reference)
  // If we modify it, we will clone it.
  let nextFleet: Fleet = fleet;
  let currentFleet: Fleet = fleet;

  // 1. Handle MOVING state
  if (fleet.state === FleetState.MOVING && fleet.targetPosition) {
    const dir = sub(fleet.targetPosition, fleet.position);
    const dist = len(dir);
    
    // Dynamic speed based on fleet composition
    const moveDistance = getFleetSpeed(fleet);

    if (dist <= moveDistance) {
      // --- ARRIVAL ---
      
      // Clone fleet for mutation (Arrival State)
      nextFleet = {
          ...fleet,
          position: clone(fleet.targetPosition),
          state: FleetState.ORBIT,
          stateStartTurn: day,
          targetPosition: null,
          targetSystemId: null,
          retreating: false, // Clear retreat flag on arrival
          invasionTargetSystemId: null, // Clear order once executed/arrived
          loadTargetSystemId: null,
          unloadTargetSystemId: null
      };
      currentFleet = nextFleet;

      const arrivedSystemId = fleet.targetSystemId;

      if (arrivedSystemId) {
        const sys = systems.find(s => s.id === arrivedSystemId);
        if (sys) {
          generatedLogs.push({
            id: rng.id('log'),
            day,
            text: `Fleet ${shortId(fleet.id)} (${fleet.factionId}) arrived at ${sys.name}.`,
            type: 'move'
          });

          let shipsChanged = false;

          // --- AUTO UNLOAD (ALLIED SYSTEMS) ---
          if (fleet.unloadTargetSystemId === arrivedSystemId && sys.ownerFactionId === fleet.factionId) {
              const unloadResult = computeUnloadOps({
                  fleet: currentFleet,
                  system: sys,
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
          if (fleet.loadTargetSystemId === arrivedSystemId) {
              const loadResult = computeLoadOps({
                  fleet: currentFleet,
                  system: sys,
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
          if (fleet.invasionTargetSystemId === arrivedSystemId) {
              let deployedCount = 0;

              const shipIdByArmyId = currentFleet.ships.reduce<Record<string, string>>((map, ship) => {
                  if (ship.carriedArmyId) {
                      map[ship.carriedArmyId] = ship.id;
                  }
                  return map;
              }, {});

              const shipIndexById = currentFleet.ships.reduce<Record<string, number>>((map, ship, index) => {
                  map[ship.id] = index;
                  return map;
              }, {});

              let updatedShips: ShipEntity[] = currentFleet.ships.map(ship => ship as ShipEntity);

              const updatedArmies = armiesAfterOps.map(army => {
                  if (army.containerId !== fleet.id) return army;
                  if (army.state !== ArmyState.EMBARKED) return army;

                  const carrierShipId = shipIdByArmyId[army.id];
                  if (!carrierShipId) return army;

                  const carrierIndex = shipIndexById[carrierShipId];
                  if (carrierIndex === undefined) return army;

                  const carrierShip = updatedShips[carrierIndex];
                  if (!carrierShip || carrierShip.carriedArmyId !== army.id) return army;

                  updatedShips[carrierIndex] = { ...carrierShip, carriedArmyId: null } as ShipEntity;
                  shipsChanged = true;
                  deployedCount++;

                  return {
                      ...army,
                      state: ArmyState.DEPLOYED,
                      containerId: sys.id
                  };
              });

              armiesAfterOps = updatedArmies;
              currentFleet = { ...currentFleet, ships: updatedShips };

              if (deployedCount > 0) {
                  generatedLogs.push({
                      id: rng.id('log'),
                      day,
                      text: `INVASION STARTED: Fleet ${shortId(fleet.id)} deployed ${deployedCount} armies onto ${sys.name}.`,
                      type: 'combat'
                  });
              }
          }

          if (shipsChanged) {
              nextFleet = currentFleet;
          }
        }
      }

    } else {
      // --- IN TRANSIT ---
      const moveVec = scale(normalize(dir), moveDistance);
      const newPos = add(fleet.position, moveVec);
      
      // Clone fleet for mutation (Position Update)
      nextFleet = {
          ...fleet,
          position: newPos
      };
    }
  }
  
  return { nextFleet, logs: generatedLogs, armyUpdates: computeArmyUpdates(allArmies, armiesAfterOps) };
};
