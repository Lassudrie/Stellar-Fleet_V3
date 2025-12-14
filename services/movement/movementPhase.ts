
import { Fleet, FleetState, StarSystem, LogEntry, ArmyState, Army, ShipEntity } from '../../types';
import { RNG } from '../../engine/rng';
import { getFleetSpeed } from './fleetSpeed';
import { shortId } from '../../engine/idUtils';
import { sub, len, normalize, scale, add, clone } from '../../engine/math/vec3';
import { canLoadArmy } from '../../engine/army';

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
          loadingTargetSystemId: null
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

          // --- AUTO INVASION / UNLOAD LOGIC ---
          if (fleet.invasionTargetSystemId === arrivedSystemId) {
              let deployedCount = 0;
              
              // Find embarked armies on this fleet
              const embarkedArmies = allArmies.filter(a => 
                  a.containerId === fleet.id && 
                  a.state === ArmyState.EMBARKED
              );

              // Clone ships array to update carriedArmyId
              let nextShips = [...nextFleet.ships];
              let shipsChanged = false;

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

              if (shipsChanged) {
                  nextFleet = { ...nextFleet, ships: nextShips };
              }

              if (deployedCount > 0) {
                  // Differentiate message based on hostility
                  const isHostile = sys.ownerFactionId && sys.ownerFactionId !== fleet.factionId;
                  const logText = isHostile
                      ? `INVASION STARTED: Fleet ${shortId(fleet.id)} deployed ${deployedCount} armies onto ${sys.name}.`
                      : `Fleet ${shortId(fleet.id)} unloaded ${deployedCount} armies onto ${sys.name}.`;

                  generatedLogs.push({
                      id: rng.id('log'),
                      day,
                      text: logText,
                      type: isHostile ? 'combat' : 'move'
                  });
              }
          }

          // --- AUTO LOAD LOGIC ---
          if (fleet.loadingTargetSystemId === arrivedSystemId) {
              let loadedCount = 0;

              // Find deployed armies on this system belonging to the fleet's faction
              // Must be DEPLOYED and owned by same faction
              const availableArmies = allArmies.filter(a =>
                a.containerId === sys.id &&
                a.state === ArmyState.DEPLOYED &&
                a.factionId === fleet.factionId
              );

              if (availableArmies.length > 0) {
                  let nextShips = [...nextFleet.ships];
                  let shipsChanged = false;

                  // Iterate ships to find empty transports
                  for (let i = 0; i < nextShips.length; i++) {
                      // Stop if no more armies to load
                      if (loadedCount >= availableArmies.length) break;

                      const ship = nextShips[i];

                      // Check if valid transport and empty using engine helper or direct check
                      // Direct check is faster here since we are inside the loop
                      if (canLoadArmy(ship)) {
                          const armyToLoad = availableArmies[loadedCount];

                          // 1. Update Army
                          armyUpdates.push({
                              id: armyToLoad.id,
                              changes: {
                                  state: ArmyState.EMBARKED,
                                  containerId: fleet.id
                              }
                          });

                          // 2. Update Ship
                          nextShips[i] = {
                              ...ship,
                              carriedArmyId: armyToLoad.id
                          };

                          shipsChanged = true;
                          loadedCount++;
                      }
                  }

                  if (shipsChanged) {
                      nextFleet = { ...nextFleet, ships: nextShips };
                  }

                  if (loadedCount > 0) {
                      generatedLogs.push({
                          id: rng.id('log'),
                          day,
                          text: `Fleet ${shortId(fleet.id)} loaded ${loadedCount} armies from ${sys.name}.`,
                          type: 'move'
                      });
                  }
              }
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
