
import { Fleet, FleetState, StarSystem, LogEntry, ArmyState, Army, ShipEntity, ShipType } from '../../types';
import { RNG } from '../../engine/rng';
import { getFleetSpeed } from './fleetSpeed';
import { shortId } from '../../engine/idUtils';
import { sub, len, normalize, scale, add, clone } from '../../engine/math/vec3';

export interface ArmyUpdate {
    id: string;
    changes: Partial<Army>;
}

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
  const armyUpdates: ArmyUpdate[] = [];
  
  // Default: Next fleet is current fleet (reference)
  // If we modify it, we will clone it.
  let nextFleet: Fleet = fleet;

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

          let nextShips = [...nextFleet.ships];
          let shipsChanged = false;
          const embarkedArmies = allArmies.filter(a =>
              a.containerId === fleet.id &&
              a.state === ArmyState.EMBARKED
          );

          // --- AUTO UNLOAD (ALLIED SYSTEMS) ---
          if (fleet.unloadTargetSystemId === arrivedSystemId && sys.ownerFactionId === fleet.factionId) {
              let unloadedCount = 0;

              embarkedArmies.forEach(army => {
                  const shipIndex = nextShips.findIndex(s => s.carriedArmyId === army.id);
                  if (shipIndex !== -1) {
                      nextShips[shipIndex] = { ...nextShips[shipIndex], carriedArmyId: null } as ShipEntity;
                      shipsChanged = true;
                      unloadedCount++;

                      armyUpdates.push({
                          id: army.id,
                          changes: {
                              state: ArmyState.DEPLOYED,
                              containerId: sys.id
                          }
                      });
                  }
              });

              if (unloadedCount > 0) {
                  generatedLogs.push({
                      id: rng.id('log'),
                      day,
                      text: `Fleet ${shortId(fleet.id)} unloaded ${unloadedCount} armies at ${sys.name}.`,
                      type: 'move'
                  });
              }
          }

          // --- AUTO LOAD (ALLY ARMIES) ---
          if (fleet.loadTargetSystemId === arrivedSystemId) {
              const availableArmies = allArmies.filter(a =>
                  a.containerId === sys.id &&
                  a.factionId === fleet.factionId &&
                  a.state === ArmyState.DEPLOYED
              );

              let loadedCount = 0;

              for (const army of availableArmies) {
                  const shipIndex = nextShips.findIndex(s =>
                      s.type === ShipType.TROOP_TRANSPORT &&
                      !s.carriedArmyId
                  );

                  if (shipIndex === -1) break;

                  nextShips[shipIndex] = { ...nextShips[shipIndex], carriedArmyId: army.id } as ShipEntity;
                  shipsChanged = true;
                  loadedCount++;

                  armyUpdates.push({
                      id: army.id,
                      changes: {
                          state: ArmyState.EMBARKED,
                          containerId: fleet.id
                      }
                  });
              }

              if (loadedCount > 0) {
                  generatedLogs.push({
                      id: rng.id('log'),
                      day,
                      text: `Fleet ${shortId(fleet.id)} loaded ${loadedCount} armies at ${sys.name}.`,
                      type: 'move'
                  });
              }
          }

          // --- AUTO INVASION LOGIC ---
          if (fleet.invasionTargetSystemId === arrivedSystemId) {
              let deployedCount = 0;

              embarkedArmies.forEach(army => {
                  // Find the ship carrying this army in the NEW ships array
                  const carrierShipIndex = nextShips.findIndex(s => s.carriedArmyId === army.id);
                  
                  if (carrierShipIndex !== -1) {
                      // EXECUTE DEPLOYMENT
                      
                      // 1. Update Army
                      armyUpdates.push({
                          id: army.id,
                          changes: {
                              state: ArmyState.DEPLOYED,
                              containerId: sys.id
                          }
                      });

                      // 2. Update Ship (Unload)
                      nextShips[carrierShipIndex] = {
                          ...nextShips[carrierShipIndex],
                          carriedArmyId: null
                      };
                      shipsChanged = true;
                      deployedCount++;
                  }
              });

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
              nextFleet = { ...nextFleet, ships: nextShips };
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
  
  return { nextFleet, logs: generatedLogs, armyUpdates };
};
