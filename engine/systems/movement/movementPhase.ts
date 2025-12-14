
import { Fleet, FleetState, StarSystem, LogEntry, ArmyState, Army, ShipEntity } from '../../../types';
import { RNG } from '../../rng';
import { getFleetSpeed } from './fleetSpeed';
import { shortId } from '../../idUtils';
import { sub, len, normalize, scale, add, clone } from '../../math/vec3';

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
          invasionTargetSystemId: null // Clear order once executed/arrived
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

          // --- AUTO INVASION LOGIC ---
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
                  generatedLogs.push({
                      id: rng.id('log'),
                      day,
                      text: `INVASION STARTED: Fleet ${shortId(fleet.id)} deployed ${deployedCount} armies onto ${sys.name}.`,
                      type: 'combat'
                  });
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
