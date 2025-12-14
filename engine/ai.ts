
import { GameState, Fleet, FactionId, AIState, ArmyState, FleetState } from '../types';
import { GameCommand } from './commands';
import { calculateFleetPower, getSystemById } from './world';
import { RNG } from './rng';
import { aiDebugger } from './aiDebugger';
import { distSq, dist } from './math/vec3';

// Configuration
const cfg = {
  defendBias: 1.5,
  attackRatio: 1.2,
  minMoveCommitTurns: 3,
  inertiaBonus: 50,
  scoutProb: 0.1,
};

type TaskType = 'DEFEND' | 'ATTACK' | 'SCOUT' | 'HOLD' | 'INVADE';

interface Task {
  type: TaskType;
  systemId: string;
  priority: number;
  requiredPower: number;
  reason?: string;
}

interface FleetAssignment {
  fleet: Fleet;
  task: Task;
}

export const planAiTurn = (
  state: GameState,
  factionId: FactionId,
  existingState: AIState | undefined,
  rng: RNG
): GameCommand[] => {
  const commands: GameCommand[] = [];
  
  // 1. MEMORY & PERCEPTION UPDATE
  const myFleets = state.fleets.filter(f => f.factionId === factionId);
  const mySystems = state.systems.filter(s => s.ownerFactionId === factionId);
  
  // Initialize or clone memory
  // Note: For now we share one AIState object in GameState, 
  // but strictly speaking each AI faction should have its own.
  // Assuming single AI ('red') for now in V1 compatibility, or shared memory if multi-AI.
  const memory: AIState = existingState ? JSON.parse(JSON.stringify(existingState)) : {
    sightings: {},
    targetPriorities: {},
    systemLastSeen: {},
    lastOwnerBySystemId: {},
    holdUntilTurnBySystemId: {}
  };

  // 2. STRATEGIC ANALYSIS (System Valuation)
  const analysisArray: { id: string, value: number, threat: number, isOwner: boolean }[] = [];
  const totalMyPower = myFleets.reduce((sum, f) => sum + calculateFleetPower(f), 0);
  
  state.systems.forEach(sys => {
      let value = 10; 
      if (sys.resourceType !== 'none') value += 50;
      if (sys.ownerFactionId === factionId) value += 20;

      // Estimate threat at system (Known enemies from memory)
      const enemiesHere = state.fleets.filter(f => 
          f.factionId !== factionId && 
          distSq(f.position, sys.position) < 100 // nearby
      );
      const threat = enemiesHere.reduce((sum, f) => sum + calculateFleetPower(f), 0);

      const data = {
          id: sys.id,
          value,
          threat,
          isOwner: sys.ownerFactionId === factionId
      };
      analysisArray.push(data);
  });

  // 3. TASK GENERATION
  const tasks: Task[] = [];

  analysisArray.forEach(sysData => {
    const inertia = memory.targetPriorities[sysData.id] || 0;

    // Priority 1: DEFEND (Owned + Threat)
    if (sysData.isOwner && sysData.threat > 0) {
      tasks.push({
        type: 'DEFEND',
        systemId: sysData.id,
        priority: ((1000 + sysData.value) * cfg.defendBias) + inertia, 
        requiredPower: sysData.threat * 1.1,
        reason: 'Hostiles in sector'
      });
    }
    // Priority 2: ATTACK or INVADE (Expansion)
    else if (!sysData.isOwner && sysData.value > 20) {
      if (sysData.threat < totalMyPower * 0.8) {
          const defenders = state.armies.filter(a => 
              a.containerId === sysData.id && 
              a.state === ArmyState.DEPLOYED && 
              a.factionId !== factionId
          ).length;
          
          const hasTransports = myFleets.some(f => f.ships.some(s => s.carriedArmyId));
          
          let type: TaskType = 'ATTACK';
          let priority = (500 + sysData.value) + inertia;
          
          if (hasTransports) {
               type = 'INVADE';
               priority += 200;
          }

          tasks.push({
            type,
            systemId: sysData.id,
            priority,
            requiredPower: Math.max(50, sysData.threat * cfg.attackRatio),
            reason: 'Expansion opportunity'
          });
      }
    }
  });

  // Sort Tasks
  tasks.sort((a, b) => b.priority - a.priority);

  // 4. FLEET ASSIGNMENT
  const availableFleetObjs = myFleets.map(f => ({
      fleet: f,
      power: calculateFleetPower(f),
      assigned: false
  }));

  const assignments: FleetAssignment[] = [];
  const operationalLogs: string[] = [];

  if (aiDebugger.getEnabled()) {
      aiDebugger.startTurn(state.day, factionId, { totalFleets: myFleets.length, ownedSystems: mySystems.length });
  }

  for (const task of tasks) {
    const candidates = availableFleetObjs
      .filter(fObj => !fObj.assigned)
      .map(fObj => {
        const f = fObj.fleet;
        const moveAge = f.stateStartTurn ? (state.day - f.stateStartTurn) : 999;
        const isLocked = f.state === FleetState.MOVING && 
                         f.targetSystemId !== task.systemId && 
                         moveAge < cfg.minMoveCommitTurns && 
                         task.type !== 'DEFEND';
        
        if (isLocked) return null;

        const targetSys = getSystemById(state.systems, task.systemId);
        if (!targetSys) return null;

        let d = distSq(f.position, targetSys.position);
        
        if (f.state === FleetState.MOVING && f.targetSystemId === task.systemId) {
            d = Math.max(0, d - (cfg.inertiaBonus * cfg.inertiaBonus));
        }
        
        let suitability = 10000 - d + fObj.power; 

        if (task.type === 'INVADE') {
            const embarkedCount = f.ships.filter(s => s.carriedArmyId).length;
            if (embarkedCount > 0) {
                suitability += 5000 + (embarkedCount * 1000);
            }
        }

        return { fObj, distSq: d, suitability };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    candidates.sort((a, b) => b.suitability - a.suitability);

    let assignedPower = 0;
    const assigned: typeof candidates = [];

    for (const cand of candidates) {
        if (assignedPower >= task.requiredPower) break;
        assigned.push(cand);
        assignedPower += cand.fObj.power;
    }

    const taskAssigned = assignedPower >= task.requiredPower || (assignedPower > 0 && task.type === 'DEFEND');

    if (taskAssigned) {
        assigned.forEach(c => {
            c.fObj.assigned = true;
            assignments.push({ fleet: c.fObj.fleet, task });
        });
    }

    if (aiDebugger.getEnabled()) {
      aiDebugger.logTask({
          type: task.type,
          targetSystemId: task.systemId,
          priority: task.priority,
          requiredPower: task.requiredPower,
          assignedPower: assignedPower,
          executed: taskAssigned,
          assignedFleetId: assigned[0]?.fObj.fleet.id || null,
          status: taskAssigned ? 'ASSIGNED' : 'SKIPPED_POWER_MISMATCH',
          reason: task.reason
      });
    }
  }
  
  if (aiDebugger.getEnabled()) {
      aiDebugger.commitTurn();
  }

  // 5. COMMAND GENERATION
  assignments.forEach(assign => {
      const { fleet, task } = assign;
      
      // Check if fleet is already at destination
      if (fleet.state === FleetState.ORBIT && 
          state.systems.find(s => dist(s.position, fleet.position) < 5)?.id === task.systemId) {
          // Already at target, no movement needed
          // Note: Invasion auto-deployment is handled by movementPhase when fleet arrives
          // with invasionTargetSystemId set. If already in orbit, armies should already be deployed.
          return;
      }

      // Check if already moving to target
      if (fleet.state === FleetState.MOVING && fleet.targetSystemId === task.systemId) {
          // Already heading there - check if invasion order needs to be set
          if (task.type === 'INVADE' && fleet.invasionTargetSystemId !== task.systemId) {
              // Re-issue as invasion move to set the flag
              commands.push({
                  type: 'ORDER_INVASION_MOVE',
                  fleetId: fleet.id,
                  targetSystemId: task.systemId
              });
          }
          return;
      }

      // Issue movement command
      // Use ORDER_INVASION_MOVE for INVADE tasks to auto-deploy armies on arrival
      if (task.type === 'INVADE') {
          commands.push({
              type: 'ORDER_INVASION_MOVE',
              fleetId: fleet.id,
              targetSystemId: task.systemId
          });
      } else {
          commands.push({
              type: 'MOVE_FLEET',
              fleetId: fleet.id,
              targetSystemId: task.systemId
          });
      }
  });

  commands.push({
      type: 'AI_UPDATE_STATE',
      newState: memory
  });

  return commands;
};
