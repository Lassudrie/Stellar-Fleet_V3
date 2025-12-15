
import { GameState, Fleet, FactionId, AIState, ArmyState, FleetState } from '../types';
import { GameCommand } from './commands';
import { calculateFleetPower, getSystemById } from './world';
import { RNG } from './rng';
import { aiDebugger, SystemEvalLog } from './aiDebugger';
import { distSq, dist } from './math/vec3';
import { applyFogOfWar, getObservedSystemIds } from './fogOfWar';
import { CAPTURE_RANGE } from '../data/static';

type AiProfile = 'aggressive' | 'defensive' | 'balanced';

interface AiTaskTargets {
  attack: number;
  defense: number;
  scout: number;
}

interface AiConfig {
  defendBias: number;
  attackRatio: number;
  minMoveCommitTurns: number;
  inertiaBonus: number;
  scoutProb: number;
  targetInertiaDecay: number;
  targetInertiaMin: number;
  holdTurns: number;
  sightingForgetAfterTurns: number;
  sightingConfidenceDecayPerTurn: number;
  sightingMinConfidence: number;
  taskTargets: AiTaskTargets;
}

const BASE_AI_CONFIG: AiConfig = {
  defendBias: 1.5,
  attackRatio: 1.2,
  minMoveCommitTurns: 3,
  inertiaBonus: 50,
  scoutProb: 0.1,
  targetInertiaDecay: 0.9,
  targetInertiaMin: 50,
  holdTurns: 3,
  sightingForgetAfterTurns: 12,
  sightingConfidenceDecayPerTurn: 0.1,
  sightingMinConfidence: 0.05,
  taskTargets: {
    attack: 1,
    defense: 1,
    scout: 1,
  },
};

const withOverrides = (overrides: Partial<AiConfig>): AiConfig => ({
  ...BASE_AI_CONFIG,
  ...overrides,
  taskTargets: {
    ...BASE_AI_CONFIG.taskTargets,
    ...overrides.taskTargets,
  },
});

const AI_PROFILE_CONFIGS: Record<AiProfile, AiConfig> = {
  aggressive: withOverrides({
    defendBias: 1.2,
    attackRatio: 1.0,
    scoutProb: 0.12,
    taskTargets: { attack: 1.2, defense: 0.9, scout: 1.1 },
  }),
  defensive: withOverrides({
    defendBias: 1.8,
    attackRatio: 1.3,
    scoutProb: 0.08,
    taskTargets: { attack: 0.9, defense: 1.2, scout: 0.9 },
  }),
  balanced: BASE_AI_CONFIG,
};

const getAiConfig = (profile?: string): AiConfig => {
  const key = (profile as AiProfile) || 'balanced';
  return AI_PROFILE_CONFIGS[key] ?? BASE_AI_CONFIG;
};

export const AI_HOLD_TURNS = BASE_AI_CONFIG.holdTurns;

export const createEmptyAIState = (): AIState => ({
  sightings: {},
  targetPriorities: {},
  systemLastSeen: {},
  lastOwnerBySystemId: {},
  holdUntilTurnBySystemId: {},
});

type TaskType = 'DEFEND' | 'ATTACK' | 'SCOUT' | 'HOLD' | 'INVADE';

interface Task {
  type: TaskType;
  systemId: string;
  priority: number;
  requiredPower: number;
  distanceToClosestFleet: number;
  reason: string;
}

interface FleetAssignment {
  fleet: Fleet;
  task: Task;
}

const updateMemory = (
  state: GameState,
  factionId: FactionId,
  existingState: AIState | undefined,
  cfg: AiConfig
) => {
  const perceivedState = state.rules.fogOfWar ? applyFogOfWar(state, factionId) : state;
  const myFleets = state.fleets.filter(f => f.factionId === factionId);
  const mySystems = state.systems.filter(s => s.ownerFactionId === factionId);

  const minDistanceBySystemId: Record<string, number> = {};
  state.systems.forEach(system => {
    const minDistance = myFleets.reduce((currentMin, fleet) => {
      const distance = dist(fleet.position, system.position);
      return Math.min(currentMin, distance);
    }, Infinity);

    minDistanceBySystemId[system.id] = minDistance;
  });

  const activeHoldSystems: Record<string, number> = {};

  const memory: AIState = existingState
    ? JSON.parse(JSON.stringify(existingState))
    : createEmptyAIState();

  Object.entries(memory.holdUntilTurnBySystemId).forEach(([systemId, holdUntil]) => {
    const system = state.systems.find(s => s.id === systemId);

    if (!system || system.ownerFactionId !== factionId || holdUntil <= state.day) {
      delete memory.holdUntilTurnBySystemId[systemId];
      return;
    }

    activeHoldSystems[systemId] = holdUntil;
  });

  const observedSystemIds = state.rules.fogOfWar
    ? getObservedSystemIds(perceivedState, factionId, perceivedState.fleets.filter(f => f.factionId === factionId))
    : new Set(state.systems.map(s => s.id));

  const visibleEnemyFleets = perceivedState.fleets.filter(f => f.factionId !== factionId);
  const refreshedSightings = new Set<string>();

  visibleEnemyFleets.forEach(fleet => {
    const systemInRange = state.systems.find(sys => distSq(sys.position, fleet.position) <= (CAPTURE_RANGE * CAPTURE_RANGE));
    memory.sightings[fleet.id] = {
      fleetId: fleet.id,
      systemId: systemInRange ? systemInRange.id : null,
      position: { ...fleet.position },
      daySeen: state.day,
      estimatedPower: calculateFleetPower(fleet),
      confidence: 1.0,
      lastUpdateDay: state.day
    };
    refreshedSightings.add(fleet.id);
  });

  Object.entries(memory.sightings).forEach(([fleetId, sighting]) => {
    if (refreshedSightings.has(fleetId)) {
      return;
    }

    const fleetExists = state.fleets.some(f => f.id === fleetId);
    const turnsSinceSeen = state.day - sighting.daySeen;
    const lastUpdateDay = sighting.lastUpdateDay ?? sighting.daySeen;
    const turnsSinceUpdate = Math.max(0, state.day - lastUpdateDay);

    if (!fleetExists || turnsSinceSeen > cfg.sightingForgetAfterTurns) {
      delete memory.sightings[fleetId];
      return;
    }

    if (turnsSinceUpdate > 0) {
      const decayFactor = Math.pow(1 - cfg.sightingConfidenceDecayPerTurn, turnsSinceUpdate);
      sighting.confidence *= decayFactor;
      sighting.lastUpdateDay = state.day;
    }

    if (sighting.confidence < cfg.sightingMinConfidence) {
      delete memory.sightings[fleetId];
    }
  });

  observedSystemIds.forEach(id => {
    memory.systemLastSeen[id] = state.day;
    const observedSystem = perceivedState.systems.find(sys => sys.id === id);
    if (observedSystem) {
      memory.lastOwnerBySystemId[id] = observedSystem.ownerFactionId;
    }
  });

  return { perceivedState, myFleets, mySystems, minDistanceBySystemId, activeHoldSystems, memory };
};

const evaluateSystems = (
  state: GameState,
  factionId: FactionId,
  perceivedState: GameState,
  memory: AIState,
  minDistanceBySystemId: Record<string, number>,
  cfg: AiConfig
) => {
  const analysisArray: {
    id: string,
    value: number,
    threat: number,
    threatVisible: number,
    threatMemory: number,
    isOwner: boolean,
    fogAge: number
  }[] = [];
  const totalMyPower = perceivedState.fleets
    .filter(f => f.factionId === factionId)
    .reduce((sum, f) => sum + calculateFleetPower(f), 0);

  state.systems.forEach(sys => {
      let value = 10;
      if (sys.resourceType !== 'none') value += 50;
      if (sys.ownerFactionId === factionId) value += 20;

      const fogAge = Math.max(0, state.day - (memory.systemLastSeen[sys.id] || 0));
      const distanceToEmpire = minDistanceBySystemId[sys.id] ?? Infinity;

      const visibleFleetsHere = perceivedState.fleets
        .filter(f => f.factionId !== factionId)
        .filter(f => distSq(f.position, sys.position) <= (CAPTURE_RANGE * CAPTURE_RANGE));

      const threatVisible = visibleFleetsHere.reduce((sum, fleet) => sum + calculateFleetPower(fleet), 0);

      // Estimate threat using stored sightings
      const sightingsHere = Object.values(memory.sightings).filter(s => s.systemId === sys.id);
      const threatMemory = sightingsHere.reduce((sum, sighting) => sum + (sighting.estimatedPower * sighting.confidence), 0);

      const fogThreatFactor = fogAge === 0 ? 1 : 1 / (1 + fogAge * 0.2);
      const threat = threatVisible + (threatMemory * fogThreatFactor);

      const expansionBias = sys.ownerFactionId === factionId ? cfg.defendBias : cfg.attackRatio;
      const frontierScore = 1 + Math.min(1, fogAge * 0.05) + (Number.isFinite(distanceToEmpire) ? Math.min(1, distanceToEmpire / 200) : 0);
      const finalScore = (value * expansionBias * frontierScore) - threat;
      const decision: SystemEvalLog['decision'] = (sys.ownerFactionId === factionId && threat > 0) || (!sys.ownerFactionId && value > 20)
        ? 'TARGET_CANDIDATE'
        : 'IGNORED';

      const data = {
          id: sys.id,
          value,
          threat,
          threatVisible,
          threatMemory,
          isOwner: sys.ownerFactionId === factionId,
          fogAge
      };
      analysisArray.push(data);

      if (aiDebugger.getEnabled()) {
        aiDebugger.logSystemEval({
          systemId: sys.id,
          systemName: sys.name,
          isOwned: sys.ownerFactionId === factionId,
          distanceToEmpire,
          fogAge,
          baseValue: value,
          expansionBias,
          frontierScore,
          threatDetected: threat,
          finalScore,
          decision
        });
      }
  });

  return { analysisArray, totalMyPower };
};

const generateTasks = (
  state: GameState,
  factionId: FactionId,
  cfg: AiConfig,
  analysisArray: { id: string; value: number; threat: number; threatVisible: number; threatMemory: number; isOwner: boolean; fogAge: number }[],
  memory: AIState,
  minDistanceBySystemId: Record<string, number>,
  myFleets: Fleet[],
  totalMyPower: number,
  rng: RNG,
  activeHoldSystems: Record<string, number>
) => {
  const embarkedFriendlyArmies = new Set(
    state.armies
      .filter(a => a.factionId === factionId && a.state === ArmyState.EMBARKED)
      .map(a => a.id)
  );

  const tasks: Task[] = [];

  const taskPreferenceWeights: Record<TaskType, number> = {
    ATTACK: cfg.taskTargets.attack,
    INVADE: cfg.taskTargets.attack,
    DEFEND: cfg.taskTargets.defense,
    HOLD: cfg.taskTargets.defense,
    SCOUT: cfg.taskTargets.scout,
  };

  const applyTaskPreference = (taskType: TaskType, priority: number): number => {
    return priority * (taskPreferenceWeights[taskType] ?? 1);
  };

  const applyDistanceWeight = (systemId: string, basePriority: number): number => {
    const distance = minDistanceBySystemId[systemId];
    const proximityWeight = Number.isFinite(distance) ? 1 + 50 / (50 + distance) : 1;
    return basePriority * proximityWeight;
  };

  Object.entries(activeHoldSystems).forEach(([systemId, holdUntil]) => {
    const sysData = analysisArray.find(data => data.id === systemId);
    const fogAge = sysData?.fogAge ?? 0;
    const fogFactor = 1 / (1 + fogAge * 0.1);
    const inertia = memory.targetPriorities[systemId] || 0;
    const basePriority = 800 + (sysData?.value ?? 0);
    const requiredPower = Math.max(100, (sysData?.threat || 0) * cfg.attackRatio);
    const distanceToClosestFleet = minDistanceBySystemId[systemId] ?? Infinity;
    const distanceWeightedPriority = applyDistanceWeight(systemId, basePriority);

    tasks.push({
      type: 'HOLD',
      systemId,
      priority: applyTaskPreference('HOLD', distanceWeightedPriority * fogFactor + inertia),
      requiredPower,
      distanceToClosestFleet,
      reason: `Hold garrison until turn ${holdUntil}`
    });
  });

  analysisArray.forEach(sysData => {
    const inertia = memory.targetPriorities[sysData.id] || 0;
    const fogFactor = 1 / (1 + sysData.fogAge * 0.1);

    const applyFog = (base: number) => base * fogFactor;

    if (sysData.isOwner && sysData.threat > 0) {
      const distanceWeightedPriority = applyDistanceWeight(sysData.id, (1000 + sysData.value) * cfg.defendBias);
      tasks.push({
        type: 'DEFEND',
        systemId: sysData.id,
        priority: applyTaskPreference('DEFEND', applyFog(distanceWeightedPriority) + inertia),
        requiredPower: sysData.threat * 1.1,
        distanceToClosestFleet: minDistanceBySystemId[sysData.id] ?? Infinity,
        reason: 'Hostiles in sector'
      });
    } else if (!sysData.isOwner && sysData.value > 20) {
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
          const distanceWeightedPriority = applyDistanceWeight(sysData.id, 500 + sysData.value);
          let basePriority = applyFog(distanceWeightedPriority) + inertia;

          if (hasEmbarkedArmies) {
               type = 'INVADE';
               basePriority += 200;
          }

          tasks.push({
            type,
            systemId: sysData.id,
            priority: applyTaskPreference(type, basePriority),
            requiredPower: Math.max(50, sysData.threat * cfg.attackRatio),
            distanceToClosestFleet: minDistanceBySystemId[sysData.id] ?? Infinity,
            reason: 'Expansion opportunity'
          });
      }
    }
  });

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
        priority: applyTaskPreference('SCOUT', 200 + target.value),
        requiredPower: 50,
        distanceToClosestFleet: minDistanceBySystemId[target.id] ?? Infinity,
        reason: 'Reconnaissance target'
      });
    }
  }

  tasks.sort((a, b) => {
    const priorityDiff = b.priority - a.priority;
    if (priorityDiff !== 0) return priorityDiff;

    const distanceDiff = a.distanceToClosestFleet - b.distanceToClosestFleet;
    if (distanceDiff !== 0) return distanceDiff;

    const typeDiff = a.type.localeCompare(b.type);
    if (typeDiff !== 0) return typeDiff;

    return a.systemId.localeCompare(b.systemId);
  });

  return { tasks, embarkedFriendlyArmies };
};

const assignFleets = (
  state: GameState,
  factionId: FactionId,
  cfg: AiConfig,
  tasks: Task[],
  myFleets: Fleet[],
  mySystems: GameState['systems'],
  embarkedFriendlyArmies: Set<string>
) => {
  const availableFleetObjs = myFleets.map(f => ({
      fleet: f,
      power: calculateFleetPower(f),
      assigned: false
  }));

  const assignments: FleetAssignment[] = [];

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

        const fleetEval = { fObj, distSq: d, suitability };

        if (aiDebugger.getEnabled()) {
          aiDebugger.logFleetEval(`${task.type}:${task.systemId}`, {
            fleetId: f.id,
            state: f.state,
            position: f.position,
            shipCount: f.ships.length,
            totalPower: fObj.power,
            distanceToTarget: Math.sqrt(d),
            suitabilityScore: suitability
          });
        }

        return fleetEval;
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
          reason: task.reason || 'No reason provided'
      });
    }
  }

  if (aiDebugger.getEnabled()) {
      aiDebugger.commitTurn();
  }

  return assignments;
};

const generateCommands = (
  state: GameState,
  factionId: FactionId,
  assignments: FleetAssignment[],
  embarkedFriendlyArmies: Set<string>,
  memory: AIState,
  cfg: AiConfig
) => {
  const commands: GameCommand[] = [];

  assignments.forEach(assign => {
      const { fleet, task } = assign;

      if (fleet.state === FleetState.ORBIT &&
          state.systems.find(s => dist(s.position, fleet.position) < 5)?.id === task.systemId) {
          if (task.type === 'INVADE') {
              fleet.ships
                  .filter(s => s.carriedArmyId && embarkedFriendlyArmies.has(s.carriedArmyId))
                  .forEach(ship => {
                      if (!ship.carriedArmyId) return;
                      commands.push({
                          type: 'UNLOAD_ARMY',
                          fleetId: fleet.id,
                          shipId: ship.id,
                          armyId: ship.carriedArmyId,
                          systemId: task.systemId,
                          reason: 'Unload embarked army for invasion objective'
                      });
                  });
          }

          return;
      }

      if (fleet.state === FleetState.MOVING && fleet.targetSystemId === task.systemId) {
          if (task.type === 'INVADE' && fleet.invasionTargetSystemId !== task.systemId) {
              commands.push({
                  type: 'ORDER_INVASION_MOVE',
                  fleetId: fleet.id,
                  targetSystemId: task.systemId,
                  reason: 'Reaffirm invasion move toward assigned target'
              });
          }
          return;
      }

      if (task.type === 'INVADE') {
          commands.push({
              type: 'ORDER_INVASION_MOVE',
              fleetId: fleet.id,
              targetSystemId: task.systemId,
              reason: 'Advance to invade target system'
          });
      } else {
          commands.push({
              type: 'MOVE_FLEET',
              fleetId: fleet.id,
              targetSystemId: task.systemId,
              reason: `Move fleet for ${task.type} task`
          });
      }
  });

  const targetPriorities: Record<string, number> = {};

  Object.entries(memory.targetPriorities).forEach(([systemId, priority]) => {
      const decayedPriority = priority * cfg.targetInertiaDecay;
      if (decayedPriority >= cfg.targetInertiaMin) {
          targetPriorities[systemId] = decayedPriority;
      }
  });

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

export const planAiTurn = (
  state: GameState,
  factionId: FactionId,
  existingState: AIState | undefined,
  rng: RNG
): GameCommand[] => {
  const factionProfile = state.factions.find(faction => faction.id === factionId)?.aiProfile;
  const cfg = getAiConfig(factionProfile);

  const { perceivedState, myFleets, mySystems, minDistanceBySystemId, activeHoldSystems, memory } =
    updateMemory(state, factionId, existingState, cfg);

  const { analysisArray, totalMyPower } = evaluateSystems(
    state,
    factionId,
    perceivedState,
    memory,
    minDistanceBySystemId,
    cfg
  );

  const { tasks, embarkedFriendlyArmies } = generateTasks(
    state,
    factionId,
    cfg,
    analysisArray,
    memory,
    minDistanceBySystemId,
    myFleets,
    totalMyPower,
    rng,
    activeHoldSystems
  );

  const assignments = assignFleets(state, factionId, cfg, tasks, myFleets, mySystems, embarkedFriendlyArmies);

  return generateCommands(state, factionId, assignments, embarkedFriendlyArmies, memory, cfg);
};
