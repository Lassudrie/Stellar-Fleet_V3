
import { GameState, Fleet, FactionId, AIState, ArmyState, FleetState, ShipType, FactionState, EnemySighting, Army, StarSystem } from '../types';
import { GameCommand } from './commands';
import { calculateFleetPower, getSystemById } from './world';
import { RNG } from './rng';
import { SpatialIndex } from './spatialIndex';
import { aiDebugger, SystemEvalLog } from './aiDebugger';
import { distSq, dist } from './math/vec3';
import { applyFogOfWar, getObservedSystemIds } from './fogOfWar';
import { CAPTURE_RANGE, CAPTURE_RANGE_SQ } from '../data/static';
import { getDefaultSolidPlanet } from './planets';
import { isFleetOrbitingSystem } from './orbit';


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

const compareStrings = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });
const sortRecordKeys = (record: Record<string, unknown>): string[] =>
  Object.keys(record).sort(compareStrings);

const createSortedRecord = <T>(record: Record<string, T>): Record<string, T> => {
  const sorted: Record<string, T> = {};
  sortRecordKeys(record).forEach(key => {
    sorted[key] = record[key];
  });
  return sorted;
};

const isCommandableFleet = (fleet: Fleet): boolean => fleet.state !== FleetState.COMBAT && !fleet.retreating;

export const getAiFactionIds = (factions: FactionState[]): FactionId[] =>
  factions
    .filter(faction => faction.aiProfile)
    .map(faction => faction.id)
    .sort((a, b) => compareStrings(a, b));

export const getLegacyAiFactionId = (factions: FactionState[]): FactionId | undefined =>
  getAiFactionIds(factions)[0];

const buildPlanetSystemMap = (systems: GameState['systems']): Map<string, string> => {
  const map = new Map<string, string>();
  systems.forEach(system => {
    system.planets.forEach(planet => {
      map.set(planet.id, system.id);
    });
  });
  return map;
};

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

const cloneAIState = (state: AIState): AIState => ({
  sightings: Object.entries(state.sightings).reduce<Record<string, EnemySighting>>((acc, [key, sighting]) => {
    acc[key] = {
      ...sighting,
      position: { ...sighting.position }
    };
    return acc;
  }, {}),
  targetPriorities: { ...state.targetPriorities },
  systemLastSeen: { ...state.systemLastSeen },
  lastOwnerBySystemId: { ...state.lastOwnerBySystemId },
  holdUntilTurnBySystemId: { ...state.holdUntilTurnBySystemId },
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
  const myFleets = state.fleets.filter(f => f.factionId === factionId && isCommandableFleet(f));
  const mySystems = state.systems.filter(s => s.ownerFactionId === factionId);
  const fleetIndex = new SpatialIndex(myFleets, CAPTURE_RANGE);
  const systemIndex = new SpatialIndex(state.systems, CAPTURE_RANGE);

  const minDistanceBySystemId: Record<string, number> = {};
  state.systems.forEach(system => {
    const nearest = fleetIndex.findNearest(system.position);
    minDistanceBySystemId[system.id] = nearest ? Math.sqrt(nearest.distanceSq) : Infinity;
  });

  const activeHoldSystems: Record<string, number> = {};

  const memory: AIState = existingState
    ? cloneAIState(existingState)
    : createEmptyAIState();

  // Hold expirations are inclusive of the stored day: systems remain on hold
  // while the current day is less than or equal to the recorded turn.
  sortRecordKeys(memory.holdUntilTurnBySystemId).forEach(systemId => {
    const holdUntil = memory.holdUntilTurnBySystemId[systemId];
    const system = state.systems.find(s => s.id === systemId);

    if (!system || system.ownerFactionId !== factionId || holdUntil < state.day) {
      delete memory.holdUntilTurnBySystemId[systemId];
      return;
    }

    activeHoldSystems[systemId] = holdUntil;
  });

  const observedSystemIds = state.rules.fogOfWar
    ? getObservedSystemIds(perceivedState, factionId, perceivedState.fleets.filter(f => f.factionId === factionId && isCommandableFleet(f)))
    : new Set(state.systems.map(s => s.id));

  const visibleEnemyFleets = perceivedState.fleets.filter(
    f => f.factionId !== factionId && isCommandableFleet(f)
  );
  const refreshedSightings = new Set<string>();
  const captureSq = CAPTURE_RANGE_SQ;

  visibleEnemyFleets.forEach(fleet => {
    const nearestSystem = systemIndex.findNearest(fleet.position, sys => distSq(sys.position, fleet.position) <= captureSq);
    const closestSystemId = nearestSystem && nearestSystem.distanceSq <= captureSq ? nearestSystem.item.id : null;

    const updatedSighting: EnemySighting = {
      fleetId: fleet.id,
      factionId: fleet.factionId,
      systemId: closestSystemId,
      position: { ...fleet.position },
      daySeen: state.day,
      estimatedPower: calculateFleetPower(fleet),
      confidence: 1.0,
      lastUpdateDay: state.day
    };

    memory.sightings[fleet.id] = updatedSighting;
    refreshedSightings.add(fleet.id);
  });

  Object.entries(memory.sightings).forEach(([fleetId, sighting]) => {
    if (refreshedSightings.has(fleetId)) {
      return;
    }

    const turnsSinceSeen = state.day - sighting.daySeen;
    const lastUpdateDay = sighting.lastUpdateDay ?? sighting.daySeen;
    const turnsSinceUpdate = Math.max(0, state.day - lastUpdateDay);

    if (turnsSinceSeen > cfg.sightingForgetAfterTurns) {
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

  memory.holdUntilTurnBySystemId = createSortedRecord(memory.holdUntilTurnBySystemId);

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
  const visibleEnemyFleets = perceivedState.fleets
    .filter(f => f.factionId !== factionId && isCommandableFleet(f));
  const enemyIndex = new SpatialIndex(visibleEnemyFleets, CAPTURE_RANGE);
  const totalMyPower = perceivedState.fleets
    .filter(f => f.factionId === factionId && isCommandableFleet(f))
    .reduce((sum, f) => sum + calculateFleetPower(f), 0);

  state.systems.forEach(sys => {
      let value = 10;
      if (sys.resourceType !== 'none') value += 50;
      if (sys.ownerFactionId === factionId) value += 20;
      if (sys.isHomeworld) value += 150;

      const fogAge = Math.max(0, state.day - (memory.systemLastSeen[sys.id] || 0));
      const distanceToEmpire = minDistanceBySystemId[sys.id] ?? Infinity;

      const visibleFleetsHere = enemyIndex.queryRadius(sys.position, CAPTURE_RANGE);

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
  mySystems: StarSystem[],
  planetSystemMap: Map<string, string>,
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

  const findNearestOwnedSystem = (targetSystemId: string): { systemId: string; distanceSq: number } | null => {
    const targetSystem = state.systems.find(sys => sys.id === targetSystemId);
    if (!targetSystem) return null;

    let best: { systemId: string; distanceSq: number } | null = null;
    mySystems.forEach(sys => {
      const distanceSq = distSq(sys.position, targetSystem.position);
      if (!best || distanceSq < best.distanceSq) {
        best = { systemId: sys.id, distanceSq };
      }
    });

    return best;
  };

  sortRecordKeys(activeHoldSystems).forEach(systemId => {
    const holdUntil = activeHoldSystems[systemId];
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
          const defenders = state.armies.filter(a => {
              if (a.state !== ArmyState.DEPLOYED) return false;
              const systemId = planetSystemMap.get(a.containerId);
              if (systemId !== sysData.id) return false;
              return a.factionId !== factionId;
          }).length;

          const hasEmbarkedArmies = myFleets.some(f =>
              f.ships.some(s => s.carriedArmyId && embarkedFriendlyArmies.has(s.carriedArmyId))
          );

          let type: TaskType = 'ATTACK';
          const distanceWeightedPriority = applyDistanceWeight(sysData.id, 500 + sysData.value);
          const groundDefensePower = defenders * 50;
          let basePriority = applyFog(distanceWeightedPriority) + inertia;

          if (hasEmbarkedArmies) {
               type = 'INVADE';
               basePriority += 200;
          }

          tasks.push({
            type,
            systemId: sysData.id,
            priority: applyTaskPreference(type, basePriority),
            requiredPower: Math.max(50, (sysData.threat * cfg.attackRatio) + groundDefensePower),
            distanceToClosestFleet: minDistanceBySystemId[sysData.id] ?? Infinity,
            reason: defenders > 0 ? 'Expansion opportunity against defended system' : 'Expansion opportunity'
          });
      } else {
          const staging = findNearestOwnedSystem(sysData.id);

          if (staging) {
            const distanceWeightedPriority = applyDistanceWeight(staging.systemId, 300 + sysData.value * 0.5);
            const regroupPower = Math.max(30, Math.min(300, sysData.threat * 0.3));
            tasks.push({
              type: 'HOLD',
              systemId: staging.systemId,
              priority: applyTaskPreference('HOLD', applyFog(distanceWeightedPriority) + inertia),
              requiredPower: regroupPower,
              distanceToClosestFleet: minDistanceBySystemId[staging.systemId] ?? Infinity,
              reason: 'Regroup near strong target'
            });
          }

          const scoutPriority = applyFog(150 + sysData.value * 0.3) + inertia;
          tasks.push({
            type: 'SCOUT',
            systemId: sysData.id,
            priority: applyTaskPreference('SCOUT', scoutPriority),
            requiredPower: 30,
            distanceToClosestFleet: minDistanceBySystemId[sysData.id] ?? Infinity,
            reason: 'Probe heavily defended target'
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

        return compareStrings(a.id, b.id);
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

    const typeDiff = compareStrings(a.type, b.type);
    if (typeDiff !== 0) return typeDiff;

    return compareStrings(a.systemId, b.systemId);
  });

  return { tasks, embarkedFriendlyArmies };
};

const assignFleets = (
  state: GameState,
  factionId: FactionId,
  cfg: AiConfig,
  tasks: Task[],
  myFleets: Fleet[],
  mySystems: StarSystem[],
  embarkedFriendlyArmies: Set<string>
) => {
  const availableFleetObjs = myFleets.map(f => ({
      fleet: f,
      power: calculateFleetPower(f),
      assigned: false
  }));

  const assignments: FleetAssignment[] = [];

  const findStagingSystemId = (targetSystemId: string): string | null => {
    const targetSystem = getSystemById(state.systems, targetSystemId);
    if (!targetSystem) return null;

    let bestSystemId: string | null = null;
    let bestDistanceSq = Infinity;
    mySystems.forEach(sys => {
      const distanceSq = distSq(sys.position, targetSystem.position);
      if (distanceSq < bestDistanceSq) {
        bestSystemId = sys.id;
        bestDistanceSq = distanceSq;
      }
    });

    return bestSystemId;
  };

  if (aiDebugger.getEnabled()) {
      aiDebugger.startTurn(state.day, factionId, { totalFleets: myFleets.length, ownedSystems: mySystems.length });
  }

  for (const task of tasks) {
    const candidates = availableFleetObjs
      .filter(fObj => !fObj.assigned)
      .map(fObj => {
        const f = fObj.fleet;
        const moveAge = state.day - (f.stateStartTurn ?? state.day);
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

      return compareStrings(a.fObj.fleet.id, b.fObj.fleet.id);
    });

    let assignedPower = 0;
    const assigned: typeof candidates = [];
    const isAssaultTask = task.type === 'ATTACK' || task.type === 'INVADE';
    const partialThreshold = isAssaultTask ? task.requiredPower * 0.7 : task.requiredPower;
    const flexibleTask = task.type === 'DEFEND' || task.type === 'HOLD';

    for (const cand of candidates) {
        if (assignedPower >= task.requiredPower) break;
        assigned.push(cand);
        assignedPower += cand.fObj.power;
    }

    const taskAssigned =
      assignedPower >= task.requiredPower ||
      (assignedPower >= partialThreshold && isAssaultTask) ||
      (assignedPower > 0 && flexibleTask);

    let regroupAssigned = false;

    if (taskAssigned) {
        assigned.forEach(c => {
            c.fObj.assigned = true;
            assignments.push({ fleet: c.fObj.fleet, task });
        });
    } else if (assigned.length && isAssaultTask) {
        const fallbackSystemId = findStagingSystemId(task.systemId) || task.systemId;
        const regroupTask: Task = {
          ...task,
          type: 'HOLD',
          systemId: fallbackSystemId,
          requiredPower: 0,
          reason: `Regroup for ${task.type.toLowerCase()} on ${task.systemId}`
        };

        assigned.forEach(c => {
          c.fObj.assigned = true;
          assignments.push({ fleet: c.fObj.fleet, task: regroupTask });
        });

        regroupAssigned = true;
    }

    if (aiDebugger.getEnabled()) {
      aiDebugger.logTask({
          type: task.type,
          targetSystemId: task.systemId,
          priority: task.priority,
          requiredPower: task.requiredPower,
          assignedPower: assignedPower,
          executed: taskAssigned || regroupAssigned,
          assignedFleetId: assigned[0]?.fObj.fleet.id || null,
          status: taskAssigned ? 'ASSIGNED' : regroupAssigned ? 'REGROUPING' : 'SKIPPED_POWER_MISMATCH',
          reason: task.reason || 'No reason provided'
      });
    }
  }

  if (aiDebugger.getEnabled()) {
      aiDebugger.commitTurn();
  }

  return assignments;
};

const planArmyEmbarkation = (
  state: GameState,
  factionId: FactionId,
  assignments: FleetAssignment[],
  embarkedFriendlyArmies: Set<string>,
  planetSystemMap: Map<string, string>
) => {
  const availableArmyCounts: Record<string, number> = {};
  state.armies.forEach(army => {
    if (army.factionId !== factionId || army.state !== ArmyState.DEPLOYED) return;
    const systemId = planetSystemMap.get(army.containerId);
    if (!systemId) return;
    availableArmyCounts[systemId] = (availableArmyCounts[systemId] || 0) + 1;
  });

  const loadCommands: GameCommand[] = [];
  const loadPlannedFleetIds = new Set<string>();

  const updatedAssignments = assignments.map(assign => {
    const { fleet, task } = assign;
    const isAssaultTask = task.type === 'ATTACK' || task.type === 'INVADE';
    if (!isAssaultTask) return assign;

    const hasEmbarkedArmies = fleet.ships.some(
      ship => ship.carriedArmyId && embarkedFriendlyArmies.has(ship.carriedArmyId)
    );
    const freeTransports = fleet.ships.filter(
      ship => ship.type === ShipType.TROOP_TRANSPORT && !ship.carriedArmyId
    ).length;

    if (hasEmbarkedArmies && task.type === 'ATTACK') {
      const promoteTask: Task = { ...task, type: 'INVADE', reason: `${task.reason} (embarked armies ready)` };
      return { fleet, task: promoteTask };
    }

    if (freeTransports === 0) return assign;

    let bestSystemId: string | null = null;
    let bestDistance = Infinity;

    state.systems.forEach(system => {
      const available = availableArmyCounts[system.id] || 0;
      if (available <= 0) return;

      const distance = dist(fleet.position, system.position);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSystemId = system.id;
      }
    });

    if (!bestSystemId) return assign;

    const loadableCount = Math.min(freeTransports, availableArmyCounts[bestSystemId]);
    if (loadableCount <= 0) return assign;

    availableArmyCounts[bestSystemId] -= loadableCount;
    loadPlannedFleetIds.add(fleet.id);

    const loadReason = `Load armies at ${getSystemById(state.systems, bestSystemId)?.name ?? bestSystemId} for invasion`;
    loadCommands.push({
      type: 'ORDER_LOAD_MOVE',
      fleetId: fleet.id,
      targetSystemId: bestSystemId,
      reason: loadReason
    });

    const updatedTask: Task = task.type === 'INVADE'
      ? task
      : { ...task, type: 'INVADE', reason: `${task.reason} (prepare invasion after embarkation)` };

    return { fleet, task: updatedTask };
  });

  return { loadCommands, loadPlannedFleetIds, updatedAssignments };
};

const generateCommands = (
  state: GameState,
  factionId: FactionId,
  assignments: FleetAssignment[],
  embarkedFriendlyArmies: Set<string>,
  memory: AIState,
  cfg: AiConfig,
  plannedLoadCommands: GameCommand[] = [],
  loadPlannedFleetIds: Set<string> = new Set()
) => {
  const commands: GameCommand[] = [...plannedLoadCommands];

  assignments.forEach(assign => {
      const { fleet, task } = assign;

      if (loadPlannedFleetIds.has(fleet.id)) {
          return;
      }

      if (fleet.state === FleetState.ORBIT &&
          state.systems.find(s => dist(s.position, fleet.position) < 5)?.id === task.systemId) {
          if (task.type === 'INVADE') {
              const targetSystem = getSystemById(state.systems, task.systemId);
              const targetPlanet = targetSystem ? getDefaultSolidPlanet(targetSystem) : null;
              if (!targetPlanet) return;

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
                          planetId: targetPlanet.id,
                          reason: 'Unload embarked army for invasion objective'
                      });
                  });
          }

          return;
      }

      if (fleet.state === FleetState.MOVING && fleet.targetSystemId === task.systemId) {
          if (task.type === 'INVADE') {
              const reason = fleet.invasionTargetSystemId === task.systemId
                ? 'Maintain invasion course toward assigned target'
                : 'Reaffirm invasion move toward assigned target';

              commands.push({
                  type: 'ORDER_INVASION_MOVE',
                  fleetId: fleet.id,
                  targetSystemId: task.systemId,
                  reason
              });
          } else {
              commands.push({
                  type: 'MOVE_FLEET',
                  fleetId: fleet.id,
                  targetSystemId: task.systemId,
                  reason: 'Maintain course toward assigned target'
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

  sortRecordKeys(memory.targetPriorities).forEach(systemId => {
      const priority = memory.targetPriorities[systemId];
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

  memory.targetPriorities = createSortedRecord(targetPriorities);

  commands.push({
      type: 'AI_UPDATE_STATE',
      factionId,
      newState: memory,
      primaryAi: factionId === state.playerFactionId
  });

  return commands;
};

const planPlanetTransfers = (state: GameState, factionId: FactionId): GameCommand[] => {
  const commands: GameCommand[] = [];
  const armiesByPlanetId = new Map<string, Army[]>();

  state.armies.forEach(army => {
    if (army.state !== ArmyState.DEPLOYED) return;
    const list = armiesByPlanetId.get(army.containerId) ?? [];
    list.push(army);
    armiesByPlanetId.set(army.containerId, list);
  });

  const orderedSystems = [...state.systems].sort((a, b) => compareStrings(a.id, b.id));

  orderedSystems.forEach(system => {
    const solidPlanets = system.planets.filter(planet => planet.isSolid).sort((a, b) => compareStrings(a.id, b.id));
    if (solidPlanets.length < 2) return;

    const availableTransports = state.fleets
      .filter(fleet => fleet.factionId === factionId && isFleetOrbitingSystem(fleet, system) && isCommandableFleet(fleet))
      .reduce((count, fleet) => {
        const freeTransports = fleet.ships.filter(ship =>
          ship.type === ShipType.TROOP_TRANSPORT &&
          !ship.carriedArmyId &&
          (ship.transferBusyUntilDay ?? -Infinity) < state.day
        ).length;
        return count + freeTransports;
      }, 0);

    if (availableTransports <= 0) return;

    const planetStats = solidPlanets.map(planet => {
      const armies = (armiesByPlanetId.get(planet.id) ?? []).slice().sort((a, b) => compareStrings(a.id, b.id));
      const friendlyArmies = armies.filter(army => army.factionId === factionId);
      const hostileArmies = armies.filter(army => army.factionId !== factionId);
      return { planet, friendlyArmies, hostileCount: hostileArmies.length };
    });

    const friendlyPlanets = planetStats.filter(stat => stat.friendlyArmies.length > 0);
    const hostilePlanets = planetStats.filter(stat => stat.hostileCount > 0);

    if (friendlyPlanets.length === 0 || hostilePlanets.length === 0) return;

    friendlyPlanets.sort((a, b) => {
      const diff = b.friendlyArmies.length - a.friendlyArmies.length;
      if (diff !== 0) return diff;
      return compareStrings(a.planet.id, b.planet.id);
    });

    hostilePlanets.sort((a, b) => {
      const diff = b.hostileCount - a.hostileCount;
      if (diff !== 0) return diff;
      return compareStrings(a.planet.id, b.planet.id);
    });

    const fromPlanet = friendlyPlanets[0];
    const toPlanet = hostilePlanets[0];
    if (fromPlanet.planet.id === toPlanet.planet.id) return;

    const army = fromPlanet.friendlyArmies[0];
    if (!army) return;

    commands.push({
      type: 'TRANSFER_ARMY_PLANET',
      armyId: army.id,
      fromPlanetId: fromPlanet.planet.id,
      toPlanetId: toPlanet.planet.id,
      systemId: system.id,
      reason: `Redistribute forces toward ${toPlanet.planet.name}`
    });
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
  const planetSystemMap = buildPlanetSystemMap(state.systems);

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
    mySystems,
    planetSystemMap,
    totalMyPower,
    rng,
    activeHoldSystems
  );

  const assignments = assignFleets(state, factionId, cfg, tasks, myFleets, mySystems, embarkedFriendlyArmies);
  const { loadCommands, loadPlannedFleetIds, updatedAssignments } = planArmyEmbarkation(
    state,
    factionId,
    assignments,
    embarkedFriendlyArmies,
    planetSystemMap
  );

  const commandList = generateCommands(
    state,
    factionId,
    updatedAssignments,
    embarkedFriendlyArmies,
    memory,
    cfg,
    loadCommands,
    loadPlannedFleetIds
  );

  const transferCommands = planPlanetTransfers(state, factionId);

  return [...commandList, ...transferCommands];
};
