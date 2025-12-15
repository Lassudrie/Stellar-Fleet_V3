
import { GameState, Fleet, FactionId, AIState, ArmyState, FleetState } from '../types';
import { GameCommand } from './commands';
import { calculateFleetPower, getSystemById } from './world';
import { RNG } from './rng';
import { aiDebugger } from './aiDebugger';
import { distSq, dist } from './math/vec3';
import { applyFogOfWar, getObservedSystemIds } from './fogOfWar';
import { CAPTURE_RANGE } from '../data/static';

// Configuration
const cfg = {
  defendBias: 1.5,
  attackRatio: 1.2,
  minMoveCommitTurns: 3,
  inertiaBonus: 50,
  scoutProb: 0.1,
  targetInertiaDecay: 0.9,
  targetInertiaMin: 50,
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
  const perceivedState = state.rules.fogOfWar ? applyFogOfWar(state, factionId) : state;

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

  const observedSystemIds = state.rules.fogOfWar
    ? getObservedSystemIds(perceivedState, factionId, perceivedState.fleets.filter(f => f.factionId === factionId))
    : new Set(state.systems.map(s => s.id));

  // Update memory with real observations through fog-of-war helpers
  const visibleEnemyFleets = perceivedState.fleets.filter(f => f.factionId !== factionId);

  visibleEnemyFleets.forEach(fleet => {
    const systemInRange = state.systems.find(sys => distSq(sys.position, fleet.position) <= (CAPTURE_RANGE * CAPTURE_RANGE));
    memory.sightings[fleet.id] = {
      fleetId: fleet.id,
      systemId: systemInRange ? systemInRange.id : null,
      position: { ...fleet.position },
      daySeen: state.day,
      estimatedPower: calculateFleetPower(fleet),
      confidence: 1.0
    };
  });

  observedSystemIds.forEach(id => {
    memory.systemLastSeen[id] = state.day;
    const observedSystem = perceivedState.systems.find(sys => sys.id === id);
    if (observedSystem) {
      memory.lastOwnerBySystemId[id] = observedSystem.ownerFactionId;
    }
  });

  // 2. STRATEGIC ANALYSIS (System Valuation)
  const analysisArray: { id: string, value: number, threat: number, isOwner: boolean, fogAge: number }[] = [];
  const totalMyPower = myFleets.reduce((sum, f) => sum + calculateFleetPower(f), 0);
  
  state.systems.forEach(sys => {
      let value = 10;
      if (sys.resourceType !== 'none') value += 50;
      if (sys.ownerFactionId === factionId) value += 20;

      const fogAge = Math.max(0, state.day - (memory.systemLastSeen[sys.id] || 0));

      // Estimate threat at system using current sightings only
      const sightingsHere = Object.values(memory.sightings).filter(s => s.systemId === sys.id);
      const threat = sightingsHere.reduce((sum, sighting) => sum + (sighting.estimatedPower * sighting.confidence), 0);

      const data = {
          id: sys.id,
          value,
          threat,
          isOwner: sys.ownerFactionId === factionId,
          fogAge
      };
      analysisArray.push(data);
  });

  const embarkedFriendlyArmies = new Set(
    state.armies
      .filter(a => a.factionId === factionId && a.state === ArmyState.EMBARKED)
      .map(a => a.id)
  );

  // 3. TASK GENERATION
  const tasks: Task[] = [];

  analysisArray.forEach(sysData => {
    const inertia = memory.targetPriorities[sysData.id] || 0;
    const fogFactor = 1 / (1 + sysData.fogAge * 0.1);

    const applyFog = (base: number) => base * fogFactor;

    // Priority 1: DEFEND (Owned + Threat)
    if (sysData.isOwner && sysData.threat > 0) {
      tasks.push({
        type: 'DEFEND',
        systemId: sysData.id,
        priority: applyFog((1000 + sysData.value) * cfg.defendBias) + inertia,
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

          const hasEmbarkedArmies = myFleets.some(f =>
              f.ships.some(s => s.carriedArmyId && embarkedFriendlyArmies.has(s.carriedArmyId))
          );
          
          let type: TaskType = 'ATTACK';
          let priority = applyFog(500 + sysData.value) + inertia;

          if (hasEmbarkedArmies) {
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

  // Optional SCOUT task generation
  if (rng.next() < cfg.scoutProb) {
    const scoutCandidates = analysisArray
      .filter(sysData => sysData.fogAge > 0)
      .sort((a, b) => {
        const fogDiff = b.fogAge - a.fogAge;
        if (fogDiff !== 0) return fogDiff;

        const valueDiff = b.value - a.value;
        if (valueDiff !== 0) return valueDiff;

        return a.id.localeCompare(b.id);
      });

    const target = scoutCandidates[0];

    if (target) {
      tasks.push({
        type: 'SCOUT',
        systemId: target.id,
        priority: 200 + target.value,
        requiredPower: 50,
        reason: 'Reconnaissance target'
      });
    }
  }

  // Sort Tasks
  tasks.sort((a, b) => {
    const priorityDiff = b.priority - a.priority;
    if (priorityDiff !== 0) return priorityDiff;

    const typeDiff = a.type.localeCompare(b.type);
    if (typeDiff !== 0) return typeDiff;

    return a.systemId.localeCompare(b.systemId);
  });

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
        
        let suitability = 10000 - d;

        if (task.type === 'SCOUT') {
            const sizePenalty = fObj.power * 0.5;
            const agilityBonus = Math.max(0, 300 - fObj.power);
            suitability += agilityBonus - sizePenalty;
        } else {
            suitability += fObj.power;
        }

        if (task.type === 'INVADE') {
            const embarkedCount = f.ships.filter(s => s.carriedArmyId && embarkedFriendlyArmies.has(s.carriedArmyId)).length;
            if (embarkedCount > 0) {
                suitability += 5000 + (embarkedCount * 1000);
            }
        }

        return { fObj, distSq: d, suitability };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    candidates.sort((a, b) => {
      const suitabilityDiff = b.suitability - a.suitability;
      if (suitabilityDiff !== 0) return suitabilityDiff;

      return a.fObj.fleet.id.localeCompare(b.fObj.fleet.id);
    });

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
      const embarkedCount = fleet.ships.filter(s => s.carriedArmyId && embarkedFriendlyArmies.has(s.carriedArmyId)).length;

      if (task.type === 'INVADE' && embarkedCount > 0) {
          commands.push({
              type: 'ORDER_INVASION_MOVE',
              fleetId: fleet.id,
              targetSystemId: task.systemId
          });
      } else {
          // Future improvement: introduce a LOAD phase to embark armies before invading.
          commands.push({
              type: 'MOVE_FLEET',
              fleetId: fleet.id,
              targetSystemId: task.systemId
          });
      }
  });

  // 6. INERTIA UPDATE
  const targetPriorities: Record<string, number> = {};

  // Decay existing inertia values
  Object.entries(memory.targetPriorities).forEach(([systemId, priority]) => {
      const decayedPriority = priority * cfg.targetInertiaDecay;
      if (decayedPriority >= cfg.targetInertiaMin) {
          targetPriorities[systemId] = decayedPriority;
      }
  });

  // Reinforce inertia for assigned targets with a discount
  assignments.forEach(({ task }) => {
      const discountedPriority = task.priority * cfg.targetInertiaDecay;
      const existing = targetPriorities[task.systemId] || 0;
      const updatedPriority = Math.max(existing, discountedPriority);

      if (updatedPriority >= cfg.targetInertiaMin) {
          targetPriorities[task.systemId] = updatedPriority;
      }
  });

  memory.targetPriorities = targetPriorities;

  commands.push({
      type: 'AI_UPDATE_STATE',
      factionId,
      newState: memory
  });

  return commands;
};
