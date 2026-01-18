
import {
  AIState,
  Army,
  ArmyState,
  BattleAmmunitionBreakdown,
  BattleAmmunitionByFaction,
  FactionId,
  Fleet,
  FleetState,
  GameMessage,
  GameState,
  LogEntry,
  PlanetBody,
  PlanetSurfaceMap,
  ShipType,
  StarSystem
} from '../shared/shared';
import { MS_PER_DAY, MS_PER_MINUTE } from '../shared/shared';
import { RNG } from './rng';
import { deepFreezeDev } from './state';
import { canonicalizeMessages, canonicalizeState, isCanonical } from './state';
import { createEmptyAIState, getLegacyAiFactionId, planAiTick, AI_HOLD_DAYS } from './ai';
import { applyCommand } from './commands';
import { detectNewBattles, pruneBattles, resolveBattle } from './battle';
import { moveFleet, executeArrivalOperations, MovementStepResult } from './movement';
import {
  generateSurfaceMapForState,
  getSurfaceTileCoordFromId,
  isPassable,
  normalizeSurfacePositions,
  resolveSurfaceTileId
} from './planetSurface';
import { checkVictoryConditions } from './objectives';
import { ORBIT_PROXIMITY_RANGE_SQ, COLORS, CAPTURE_RANGE_SQ, SHIP_STATS } from '../content/data/static';
import { GROUND_UNIT_STATS } from '../content/data/groundUnits';
import { isFleetOrbitingSystem, isOrbitContested, getOrbitingSystem } from './orbit';
import { distSq } from './math/vec3';
import { resolveOrbitalBombardment } from './orbitalBombardment';
import {
  AO_LANDING_COEFF,
  AO_LANDING_MAX,
  BOMBARD_LANDING_PENALTY,
  CONDITION_RECOVERY,
  FATIGUE_FACTOR_MIN,
  FATIGUE_RECOVERY,
  LANDING_BASE,
  LANDING_MAX,
  LANDING_VAR,
  MAX_UNITS_PER_SIDE,
  MORALE_RECOVERY,
  ORBIT_CONTESTED_LANDING_PENALTY,
  POST_BATTLE_FATIGUE_ADD,
  POST_BATTLE_MORALE_CAP,
  STACKING_CAP,
  computeCoverFactorAtCoord,
  computeFortifFactorAtCoord,
  computeStackingFactors,
  computeSupplyDistanceMapFromSurfaceMap,
  computeZocSnapshotFromArmies,
  deriveRoutedAfterMorale,
  executeMoveOrder,
  hasLineOfSight,
  isInEnemyZoc,
  isRouted,
  isSupplied,
  resolveEngagement,
  tileDistance,
  tileKey,
  type EngagementParticipant
} from './ground';
import { sanitizeArmies } from './army';
import { quantizeFuel } from './logistics/fuel';
import { sorted } from '../shared/shared';

export interface StrategicContext {
  timeMs: number;
  timeDays: number;
  deltaMs: number;
  rng: RNG;
}

const STRATEGIC_TICK_MS = MS_PER_MINUTE;

export const runStrategicTick = (state: GameState, rng: RNG): GameState => {
  // Enforce Immutability on Input
  deepFreezeDev(state);

  const timeMs = state.timeMs;
  const ctx: StrategicContext = {
    rng,
    timeMs,
    timeDays: timeMs / MS_PER_DAY,
    deltaMs: STRATEGIC_TICK_MS
  };
  const shouldMeasure = (import.meta as any).env?.DEV && typeof performance !== 'undefined';
  const timings: Array<{ label: string; ms: number }> = [];
  const measure = <T>(label: string, fn: () => T): T => {
    if (!shouldMeasure) return fn();
    const start = performance.now();
    const result = fn();
    timings.push({ label, ms: performance.now() - start });
    return result;
  };

  // --- CANONICALIZE INPUT STATE ---
  // Ensures consistent iteration order for deterministic RNG consumption
  let nextState = { ...state, timeMs };
  if ((import.meta as any).env?.DEV && !isCanonical(nextState)) {
    console.warn('[StrategicTick] Input state not canonical; normalizing for determinism.');
    nextState = canonicalizeState(nextState);
  }

  // --- PIPELINE EXECUTION ---
  // Each phase takes (state, ctx) and returns nextState.

  // 1. AI Planning & Execution (Generates commands)
  nextState = measure('ai', () => phaseAI(nextState, ctx));

  // 2. Movement (Updates positions)
  nextState = measure('movement', () => phaseMovement(nextState, ctx));

  // 3. Detect New Battles (Locks fleets and schedule resolution)
  nextState = measure('battle_detection', () => phaseBattleDetection(nextState, ctx));

  // 4. Resolve all scheduled battles immediately (Scheduled -> Resolved)
  nextState = measure('battle_resolution', () => phaseBattleResolution(nextState, ctx));

  // 5. Orbital Bombardment (auto)
  nextState = measure('orbital_bombardment', () => phaseOrbitalBombardment(nextState, ctx));

  // 6. Ground Combat & Conquest
  nextState = measure('ground', () => phaseGround(nextState, ctx));

  // 7. Check Victory Objectives
  nextState = measure('objectives', () => phaseObjectives(nextState, ctx));

  // SAFETY: Ensure all battles are resolved before cleanup so timeResolvedMs is always set
  const remainingBattles = nextState.battles.filter(b => b.status === 'scheduled');
  if (remainingBattles.length > 0) {
    console.error(`[StrategicTick] CRITICAL: Scheduled battles remaining at time ${ctx.timeMs}: ${remainingBattles.map(b => b.id).join(', ')}. Force-resolving.`);
    nextState = {
      ...nextState,
      battles: nextState.battles.map(b =>
        b.status === 'scheduled'
          ? {
              ...b,
              timeResolvedMs: ctx.timeMs,
              status: 'resolved' as const,
              winnerFactionId: 'draw' as const,
              logs: [...b.logs, 'Battle force-resolved due to strategic tick processing error.']
            }
          : b
      )
    };
  }

  // 8. Cleanup & Maintenance
  nextState = measure('cleanup', () => phaseCleanup(nextState, ctx));

  // 8. Canonicalize output
  nextState = canonicalizeState(nextState);

  if (shouldMeasure && timings.length > 0) {
    const total = timings.reduce((sum, timing) => sum + timing.ms, 0);
    const details = timings.map(timing => `${timing.label}=${timing.ms.toFixed(2)}`).join(', ');
    console.debug(`[StrategicTick] phase timings (ms): ${details} | total=${total.toFixed(2)}`);
  }

  return {
      ...nextState,
      timeMs
  };
};

// -------------------------
// Phase implementations
// -------------------------

function createEmptyAmmunitionTotals(): BattleAmmunitionBreakdown {
  return {
    offensiveMissiles: { initial: 0, used: 0, remaining: 0 },
    torpedoes: { initial: 0, used: 0, remaining: 0 },
    interceptors: { initial: 0, used: 0, remaining: 0 }
  };
}

function aggregateAmmunitionTotals(ammunitionByFaction?: BattleAmmunitionByFaction): BattleAmmunitionBreakdown {
  const totals = createEmptyAmmunitionTotals();

  Object.values(ammunitionByFaction ?? {}).forEach(breakdown => {
    totals.offensiveMissiles.initial += breakdown.offensiveMissiles.initial;
    totals.offensiveMissiles.used += breakdown.offensiveMissiles.used;
    totals.offensiveMissiles.remaining += breakdown.offensiveMissiles.remaining;

    totals.torpedoes.initial += breakdown.torpedoes.initial;
    totals.torpedoes.used += breakdown.torpedoes.used;
    totals.torpedoes.remaining += breakdown.torpedoes.remaining;

    totals.interceptors.initial += breakdown.interceptors.initial;
    totals.interceptors.used += breakdown.interceptors.used;
    totals.interceptors.remaining += breakdown.interceptors.remaining;
  });

  return totals;
}

function formatLossesLine(shipsLost: Record<FactionId, number>, involvedFactionIds: FactionId[]): string {
  const sortedFactions = sorted(involvedFactionIds, (a, b) => a.localeCompare(b));
  const descriptions = sortedFactions.map(factionId => `${factionId}: ${shipsLost[factionId] ?? 0}`);
  return descriptions.join(', ');
}

function formatAmmunitionLine(totals: BattleAmmunitionBreakdown): string {
  const formatTally = (label: string, tally: { initial: number; used: number; remaining: number }) =>
    `${label} ${tally.used}/${tally.initial} used (${tally.remaining} remaining)`;

  return [
    formatTally('Missiles', totals.offensiveMissiles),
    formatTally('Torpedoes', totals.torpedoes),
    formatTally('Interceptors', totals.interceptors)
  ].join(' | ');
}

function invalidateStaleInvasionDecisions(
  messages: GameMessage[],
  fleets: Fleet[],
  systems: StarSystem[]
): GameMessage[] {
  if (messages.length === 0) return messages;

  const fleetsById = new Map(fleets.map(fleet => [fleet.id, fleet]));
  const systemsById = new Map(systems.map(system => [system.id, system]));
  let changed = false;

  const updatedMessages = messages.map(message => {
    if (message.type !== 'INVASION_DECISION' || message.dismissed) return message;

    const payload = message.payload ?? {};
    const fleetId = typeof payload.fleetId === 'string' ? payload.fleetId : null;
    const systemId = typeof payload.systemId === 'string' ? payload.systemId : null;
    if (!fleetId || !systemId) return message;

    const fleet = fleetsById.get(fleetId);
    const system = systemsById.get(systemId);
    if (fleet && system && isFleetOrbitingSystem(fleet, system)) {
      return message;
    }

    changed = true;
    return { ...message, dismissed: true, read: true };
  });

  return changed ? updatedMessages : messages;
}

export function phaseBattleResolution(state: GameState, ctx: StrategicContext): GameState {
  const currentTickState = state.timeMs === ctx.timeMs ? state : { ...state, timeMs: ctx.timeMs };

  // 1. Identify Scheduled Battles
  const scheduledBattles = sorted(
    state.battles.filter(b => b.status === 'scheduled'),
    (a, b) => {
      // Primary: by systemId (alphabetical)
      const sysCompare = a.systemId.localeCompare(b.systemId);
      if (sysCompare !== 0) return sysCompare;
      // Secondary: by battle id (ensures uniqueness)
      return a.id.localeCompare(b.id);
    }
  );

  if (scheduledBattles.length === 0) return state;

  let nextBattles = [...state.battles];
  let nextFleets = [...state.fleets];
  let nextArmies = [...state.armies];
  let nextLogs = [...state.logs];
  let nextMessages = [...state.messages];

  // 2. Resolve Each Battle
  scheduledBattles.forEach(battle => {
    const fleetsInBattle = nextFleets.filter(fleet => battle.involvedFleetIds.includes(fleet.id));
    const result = resolveBattle(battle, { ...currentTickState, fleets: nextFleets }, ctx.timeMs);

    // Update Battle in list (Mark as resolved, add logs, stats)
    nextBattles = nextBattles.map(b => (b.id === battle.id ? result.updatedBattle : b));

    // Update Fleets:
    // A. Remove ALL fleets originally involved (some might have died, some survived with new state)
    nextFleets = nextFleets.filter(f => !battle.involvedFleetIds.includes(f.id));

    // B. Add survivors back (These are new immutable Fleet objects returned by resolver)
    nextFleets.push(...result.survivingFleets);

    const destroyedFleetIds = new Set<string>(
      result.destroyedFleetIds && result.destroyedFleetIds.length > 0
        ? result.destroyedFleetIds
        : battle.involvedFleetIds.filter(fleetId => !result.survivingFleets.some(fleet => fleet.id === fleetId))
    );
    const destroyedShipIds = new Set(result.destroyedShipIds ?? []);
    const destroyedArmyIds = new Set(result.destroyedArmyIds ?? []);

    fleetsInBattle.forEach(fleet => {
      fleet.ships.forEach(ship => {
        if (ship.carriedArmyId && destroyedShipIds.has(ship.id)) {
          destroyedArmyIds.add(ship.carriedArmyId);
        }
      });
    });

    const armiesAfterBattle: Army[] = [];
    const lostArmyIds: string[] = [];

    nextArmies.forEach(army => {
      if (army.state !== ArmyState.EMBARKED) {
        armiesAfterBattle.push(army);
        return;
      }

      if (destroyedArmyIds.has(army.id) || destroyedFleetIds.has(army.containerId)) {
        destroyedArmyIds.add(army.id);
        lostArmyIds.push(army.id);
        return;
      }

      armiesAfterBattle.push(army);
    });

    nextArmies = armiesAfterBattle;

    // Global Notification
    if (result.updatedBattle.winnerFactionId) {
      const sysName = currentTickState.systems.find(s => s.id === battle.systemId)?.name || 'Unknown';
      nextLogs.push({
        id: ctx.rng.id('log'),
        timeMs: ctx.timeMs,
        text: `Combat resolved at ${sysName}. Outcome: ${result.updatedBattle.winnerFactionId.toUpperCase()}.`,
        type: 'combat'
      });
    }

    // Battle Message
    const involvedFactionIdsSet = new Set<FactionId>();
    battle.involvedFleetIds.forEach(fleetId => {
      const fleet = currentTickState.fleets.find(f => f.id === fleetId) || nextFleets.find(f => f.id === fleetId);
      if (fleet) involvedFactionIdsSet.add(fleet.factionId as FactionId);
    });
    Object.keys(result.updatedBattle.shipsLost ?? {}).forEach(factionId => involvedFactionIdsSet.add(factionId as FactionId));
    const involvedFactionIds = sorted(Array.from(involvedFactionIdsSet), (a, b) => a.localeCompare(b));

    const systemName = currentTickState.systems.find(s => s.id === battle.systemId)?.name || 'Unknown';
    const isPlayerInvolved = involvedFactionIds.includes(currentTickState.playerFactionId);
    const ammunitionTotals = aggregateAmmunitionTotals(result.updatedBattle.ammunitionByFaction);
    const battleSystemName = systemName || battle.systemId;

    if (lostArmyIds.length > 0) {
      sorted(lostArmyIds).forEach(armyId => {
        nextLogs.push({
          id: ctx.rng.id('log'),
          timeMs: ctx.timeMs,
          text: `Army ${armyId} was lost with its transport during the battle at ${battleSystemName}.`,
          type: 'combat'
        });
      });
    }

    const message: GameMessage = {
      id: ctx.rng.id('msg'),
      timeMs: ctx.timeMs,
      type: 'battle_resolution',
      priority: isPlayerInvolved ? 2 : 1,
      title: `Battle resolved at ${systemName}`,
      subtitle: result.updatedBattle.winnerFactionId ? `Winner: ${result.updatedBattle.winnerFactionId.toUpperCase()}` : 'Outcome undetermined',
      lines: [
        `Ships lost - ${formatLossesLine(result.updatedBattle.shipsLost ?? {}, involvedFactionIds)}`,
        `Munitions - ${formatAmmunitionLine(ammunitionTotals)}`
      ],
      payload: {
        battleId: battle.id,
        systemId: battle.systemId,
        involvedFactionIds
      },
      read: false,
      dismissed: false,
      createdAtTimeMs: ctx.timeMs
    };

    nextMessages = canonicalizeMessages([...nextMessages, message]);
  });

  nextMessages = invalidateStaleInvasionDecisions(nextMessages, nextFleets, currentTickState.systems);

  return {
    ...currentTickState,
    battles: nextBattles,
    fleets: nextFleets,
    armies: nextArmies,
    logs: nextLogs,
    messages: nextMessages
  };
}

export function phaseAI(state: GameState, ctx: StrategicContext): GameState {
  if (!state.rules.aiEnabled) return state;

  const currentTickState = state.timeMs === ctx.timeMs ? state : { ...state, timeMs: ctx.timeMs };

  const aiFactions = sorted(
    state.factions.filter(faction => faction.aiProfile),
    (a, b) => a.id.localeCompare(b.id)
  );

  const ensuredAiStates: Record<FactionId, AIState> = { ...(currentTickState.aiStates ?? {}) };
  const legacyAiFactionId = getLegacyAiFactionId(currentTickState.factions);

  aiFactions.forEach(faction => {
    if (!ensuredAiStates[faction.id]) {
      const legacyState = faction.id === legacyAiFactionId ? state.aiState : undefined;
      ensuredAiStates[faction.id] = legacyState ?? createEmptyAIState();
    }
  });

  let nextState: GameState = { ...currentTickState, aiStates: ensuredAiStates };

  for (const faction of aiFactions) {
    const existingAiState = (nextState.aiStates ?? ensuredAiStates)[faction.id] ?? createEmptyAIState();
    const commands = planAiTick(nextState, faction.id, existingAiState, ctx.rng);

    for (const cmd of commands) {
      const result = applyCommand(nextState, cmd, ctx.rng, ctx.timeMs);
      const updatedState = result.state;
      nextState = updatedState.timeMs === ctx.timeMs ? updatedState : { ...updatedState, timeMs: ctx.timeMs };
    }
  }

  const mergedAiStates = { ...ensuredAiStates, ...(nextState.aiStates ?? {}) };
  const alignedState = nextState.timeMs === ctx.timeMs ? nextState : { ...nextState, timeMs: ctx.timeMs };
  return { ...alignedState, aiStates: mergedAiStates };
}

export function phaseMovement(state: GameState, ctx: StrategicContext): GameState {
  const tickTimeMs = ctx.timeMs; // Movement projects to current tick positions
  const fleetsToProcess = sorted(state.fleets, (a, b) => a.id.localeCompare(b.id));
  const newLogs: LogEntry[] = [];
  let nextMessages = state.messages;

  let workingArmies = state.armies;
  let workingFleets = fleetsToProcess;

  const movementResults: Array<
    MovementStepResult & {
      invasionTargetSystemId: string | null;
      invasionTargetPlanetId: string | null;
      loadTargetSystemId: string | null;
      unloadTargetSystemId: string | null;
    }
  > = [];

  // First pass: compute final positions for all fleets without arrival operations
  fleetsToProcess.forEach(fleet => {
    const moveResult = moveFleet(fleet, state.systems, tickTimeMs, ctx.deltaMs, ctx.rng);
    movementResults.push({
      ...moveResult,
      invasionTargetSystemId: fleet.invasionTargetSystemId ?? null,
      invasionTargetPlanetId: fleet.invasionTargetPlanetId ?? null,
      loadTargetSystemId: fleet.loadTargetSystemId ?? null,
      unloadTargetSystemId: fleet.unloadTargetSystemId ?? null
    });
    workingFleets = workingFleets.map(existing => (existing.id === fleet.id ? moveResult.fleet : existing));
    newLogs.push(...moveResult.logs);
  });

  // Second pass: execute arrival operations using the fully updated fleet positions
  movementResults.forEach(result => {
    if (!result.arrivalSystemId) return;

    const system = state.systems.find(s => s.id === result.arrivalSystemId);
    if (!system) return;

    const fleet = workingFleets.find(f => f.id === result.fleet.id);
    if (!fleet) return;

    const isPlayerInvasionArrival = fleet.factionId === state.playerFactionId && result.invasionTargetSystemId === system.id;

    if (isPlayerInvasionArrival) {
      const solidPlanets = sorted(
        system.planets.filter(planet => planet.isSolid),
        (a, b) => a.id.localeCompare(b.id)
      );
      const preferredPlanet =
        result.invasionTargetPlanetId && solidPlanets.some(planet => planet.id === result.invasionTargetPlanetId)
          ? solidPlanets.find(planet => planet.id === result.invasionTargetPlanetId) ?? null
          : null;
      const suggestedPlanet = preferredPlanet ?? solidPlanets[0] ?? null;

      const message: GameMessage = {
        id: ctx.rng.id('msg'),
        timeMs: ctx.timeMs,
        type: 'INVASION_DECISION',
        priority: 2,
        title: `Invasion in orbit: ${system.name}`,
        subtitle: suggestedPlanet ? `Decide: siege or land troops on ${suggestedPlanet.name}.` : 'No solid bodies available for landing.',
        lines: suggestedPlanet
          ? ['Option 1: siege (orbital bombardment).', 'Option 2: attack (land embarked armies).']
          : ['This system has no solid bodies. Landing is impossible.'],
        payload: {
          fleetId: fleet.id,
          systemId: system.id,
          planetId: suggestedPlanet?.id ?? null
        },
        read: false,
        dismissed: false,
        createdAtTimeMs: ctx.timeMs
      };

      nextMessages = canonicalizeMessages([...nextMessages, message]);
    }

    const arrivalFleet: Fleet = {
      ...fleet,
      invasionTargetSystemId: isPlayerInvasionArrival ? null : result.invasionTargetSystemId,
      invasionTargetPlanetId: isPlayerInvasionArrival ? null : result.invasionTargetPlanetId,
      loadTargetSystemId: result.loadTargetSystemId,
      unloadTargetSystemId: result.unloadTargetSystemId
    };

    const arrivalOutcome = executeArrivalOperations(
      state,
      arrivalFleet,
      system,
      workingArmies,
      workingFleets,
      ctx.rng,
      tickTimeMs
    );

    workingArmies = arrivalOutcome.armies;
    workingFleets = workingFleets.map(existing =>
      existing.id === fleet.id
        ? {
            ...arrivalOutcome.fleet,
            invasionTargetSystemId: null,
            invasionTargetPlanetId: null,
            loadTargetSystemId: null,
            unloadTargetSystemId: null
          }
        : existing
    );
    newLogs.push(...arrivalOutcome.logs);
  });

  return normalizeSurfacePositions({
    ...state,
    fleets: workingFleets,
    armies: workingArmies,
    logs: [...state.logs, ...newLogs],
    messages: nextMessages
  });
}

export function phaseBattleDetection(state: GameState, ctx: StrategicContext): GameState {
  // Only detect if advanced combat is enabled
  if (!state.rules.useAdvancedCombat) return state;

  // 1. Detect New Battles based on positions
  const newBattles = detectNewBattles(state, ctx.timeMs);
  if (newBattles.length === 0) return state;

  // 2. Collect IDs of all fleets engaged
  const involvedFleetIds = new Set<string>();
  newBattles.forEach(b => b.involvedFleetIds.forEach(id => involvedFleetIds.add(id)));

  // 3. Update Fleets to COMBAT state
  // This locks them from moving next tick until resolved
  const nextFleets = state.fleets.map(f => {
    if (involvedFleetIds.has(f.id)) {
      // Force stop movement
      return {
        ...f,
        state: FleetState.COMBAT,
        stateStartTimeMs: ctx.timeMs, // Mark conflict start
        targetSystemId: null,
        targetPosition: null,
        invasionTargetSystemId: null,
        invasionTargetPlanetId: null,
        loadTargetSystemId: null,
        unloadTargetSystemId: null
      };
    }
    return f;
  });

  return {
    ...state,
    fleets: nextFleets,
    battles: [...state.battles, ...newBattles]
  };
}

function hasUncontestedOrbitalDominance(state: GameState): boolean {
  return state.systems.some(system => {
    if (isOrbitContested(system, state)) return false;

    const fleetsInOrbit = state.fleets.filter(
      fleet => fleet.ships.length > 0 && distSq(fleet.position, system.position) <= ORBIT_PROXIMITY_RANGE_SQ
    );

    if (fleetsInOrbit.length === 0) return false;

    const factionIds = new Set(fleetsInOrbit.map(fleet => fleet.factionId));
    return factionIds.size === 1;
  });
}

export function phaseOrbitalBombardment(state: GameState, ctx: StrategicContext): GameState {
  if (!hasUncontestedOrbitalDominance(state)) {
    return {
      ...state,
      bombardedTilesByBodyId: {}
    };
  }

  const result = resolveOrbitalBombardment(state);
  const hasChanges = result.updates.size > 0 || result.logs.length > 0 || Object.keys(result.bombardedTileIdsByBodyId).length > 0;
  if (!hasChanges) {
    return {
      ...state,
      bombardedTilesByBodyId: {}
    };
  }

  const nextArmies = state.armies.map(army => {
    const update = result.updates.get(army.id);
    if (!update) return army;
    const routed = deriveRoutedAfterMorale(army, update.morale);
    return { ...army, members: update.members, morale: update.morale, routed };
  });

  const nextLogs = [...state.logs];
  result.logs.forEach(text => {
    nextLogs.push({
      id: ctx.rng.id('log'),
      timeMs: ctx.timeMs,
      text,
      type: 'combat'
    });
  });

  return {
    ...state,
    armies: nextArmies,
    logs: nextLogs,
    bombardedTilesByBodyId: result.bombardedTileIdsByBodyId
  };
}

export function phaseGround(state: GameState, ctx: StrategicContext): GameState {
  let nextLogs = [...state.logs];
  let nextMessages = [...state.messages];
  let nextAiStates: Record<FactionId, AIState> = { ...(state.aiStates ?? {}) };

  const aiFactionIds = new Set(state.factions.filter(faction => faction.aiProfile).map(faction => faction.id));
  const legacyAiFactionId = getLegacyAiFactionId(state.factions);

  aiFactionIds.forEach(factionId => {
    if (!nextAiStates[factionId]) {
      const legacyState = factionId === legacyAiFactionId ? state.aiState : undefined;
      nextAiStates[factionId] = legacyState ?? createEmptyAIState();
    }
  });

  const holdUpdates: Record<FactionId, string[]> = {};

  const bodyIndex = new Map<string, { system: StarSystem; body: PlanetBody }>();
  state.systems.forEach(system => {
    system.planets.forEach(body => {
      if (!body.isSolid) return;
      bodyIndex.set(body.id, { system, body });
    });
  });

  const surfaceMapCache = new Map<string, PlanetSurfaceMap | null>();
  const getSurfaceMap = (bodyId: string): PlanetSurfaceMap | null => {
    if (surfaceMapCache.has(bodyId)) return surfaceMapCache.get(bodyId) ?? null;
    const map = generateSurfaceMapForState(state, bodyId);
    surfaceMapCache.set(bodyId, map ?? null);
    return map ?? null;
  };

  const initialBodyOwners = new Map<string, FactionId | null>();
  bodyIndex.forEach(({ body }, bodyId) => {
    initialBodyOwners.set(bodyId, body.ownerFactionId ?? null);
  });

  // NOTE: `settlementControl` is intentionally sparse.
  // Generating all surface maps every tick (to pre-seed entries) is extremely expensive and can stall processing.
  // Missing entries fall back to the settlement's generated `factionId` when needed.
  let settlementControl = state.settlementControl ? { ...state.settlementControl } : {};

  const armiesById = new Map(state.armies.map(army => [army.id, army]));
  const removeArmyIds = new Set<string>();
  const landedArmyIds = new Set<string>();
  const invalidLandingIds = new Set<string>();

  armiesById.forEach(army => {
    if (army.members <= 0) {
      removeArmyIds.add(army.id);
    }
  });

  const preLandingArmiesByBodyId = new Map<string, Army[]>();
  armiesById.forEach(army => {
    if (army.state !== ArmyState.DEPLOYED) return;
    if (!bodyIndex.has(army.containerId)) return;
    if (!army.surfacePos) return;
    if (army.members <= 0) return;
    const list = preLandingArmiesByBodyId.get(army.containerId) ?? [];
    list.push(army);
    preLandingArmiesByBodyId.set(army.containerId, list);
  });

  const bombardedTilesByBodyId = state.bombardedTilesByBodyId ?? {};
  const bombardedTileIdsByBodyId = new Map<string, Set<number>>();
  Object.entries(bombardedTilesByBodyId).forEach(([bodyId, tiles]) => {
    const set = new Set<number>();
    tiles.forEach(tileId => {
      if (!Number.isFinite(tileId)) return;
      set.add(Math.floor(tileId));
    });
    bombardedTileIdsByBodyId.set(bodyId, set);
  });

  const normalizeOrders = (orders: Army['groundOrders'] | undefined): Army['groundOrders'] | undefined => {
    if (!orders) return undefined;
    const move = orders.move;
    const attack = orders.attack;
    if (!move && !attack) return undefined;
    return { ...(move ? { move } : {}), ...(attack ? { attack } : {}) };
  };

  const resolveTileId = (
    map: PlanetSurfaceMap,
    pos: { bodyId: string; tileId?: number; q?: number; r?: number } | null | undefined
  ): number | null => {
    if (!pos) return null;
    return resolveSurfaceTileId(map.descriptor, pos);
  };

  const toSurfacePos = (map: PlanetSurfaceMap, tileId: number) => {
    const coord = getSurfaceTileCoordFromId(map.descriptor, tileId);
    return coord ? { bodyId: map.bodyId, tileId, q: coord.q, r: coord.r } : { bodyId: map.bodyId, tileId };
  };

  const occupancyByBody = new Map<string, Map<string, string[]>>();
  const factionCountByBody = new Map<string, Map<FactionId, number>>();
  preLandingArmiesByBodyId.forEach((armies, bodyId) => {
    const occupancy = new Map<string, string[]>();
    const factionCounts = new Map<FactionId, number>();
    const map = getSurfaceMap(bodyId);
    if (!map) {
      occupancyByBody.set(bodyId, occupancy);
      factionCountByBody.set(bodyId, factionCounts);
      return;
    }
    armies.forEach(army => {
      if (!army.surfacePos) return;
      const tileId = resolveTileId(map, army.surfacePos);
      if (tileId === null) return;
      const key = tileKey(tileId);
      const ids = occupancy.get(key) ?? [];
      ids.push(army.id);
      occupancy.set(key, ids);
      factionCounts.set(army.factionId, (factionCounts.get(army.factionId) ?? 0) + 1);
    });
    occupancyByBody.set(bodyId, occupancy);
    factionCountByBody.set(bodyId, factionCounts);
  });

  const landingCandidates = sorted(
    Array.from(armiesById.values()).filter(army => army.state === ArmyState.EMBARKED && army.landingOrder),
    (a, b) => {
      const ta = a.landingOrder!.to;
      const tb = b.landingOrder!.to;
      if (ta.bodyId !== tb.bodyId) return ta.bodyId.localeCompare(tb.bodyId);
      const descA = state.planetSurfaceDescriptorsByBodyId?.[ta.bodyId];
      const descB = state.planetSurfaceDescriptorsByBodyId?.[tb.bodyId];
      const tileA = descA ? resolveSurfaceTileId(descA, ta) ?? -1 : -1;
      const tileB = descB ? resolveSurfaceTileId(descB, tb) ?? -1 : -1;
      if (tileA !== tileB) return tileA - tileB;
      return a.id.localeCompare(b.id);
    }
  );

  const landingPlanByBody = new Map<string, Map<string, Army[]>>();

  const isWaterBiome = (biome: string): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';

  landingCandidates.forEach(army => {
    const order = army.landingOrder!;
    const bodyId = order.to.bodyId;
    const bodyEntry = bodyIndex.get(bodyId);
    if (!bodyEntry) {
      invalidLandingIds.add(army.id);
      return;
    }
    const carrier = state.fleets.find(fleet => fleet.id === army.containerId);
    if (!carrier || !isFleetOrbitingSystem(carrier, bodyEntry.system)) {
      invalidLandingIds.add(army.id);
      return;
    }
    const map = getSurfaceMap(bodyId);
    if (!map) {
      invalidLandingIds.add(army.id);
      return;
    }
    const targetTileId = resolveSurfaceTileId(map.descriptor, order.to);
    if (targetTileId === null || targetTileId < 0 || targetTileId >= map.tiles.length) {
      invalidLandingIds.add(army.id);
      return;
    }
    const tile = map.tiles[targetTileId];
    if (!tile) {
      invalidLandingIds.add(army.id);
      return;
    }
    const isAmphibious = GROUND_UNIT_STATS[army.unitType].tags?.includes('amphibious') ?? false;
    if (!isPassable(tile.biome) && !(isAmphibious && isWaterBiome(tile.biome))) {
      invalidLandingIds.add(army.id);
      return;
    }

    const occupancy = occupancyByBody.get(bodyId) ?? new Map<string, string[]>();
    const key = tileKey(targetTileId);
    const occupants = occupancy.get(key) ?? [];
    const enemyOnHex = occupants.some(id => (armiesById.get(id)?.factionId ?? army.factionId) !== army.factionId);
    if (enemyOnHex) {
      invalidLandingIds.add(army.id);
      return;
    }
    const friendlyCount = occupants.filter(id => (armiesById.get(id)?.factionId ?? army.factionId) === army.factionId).length;
    if (friendlyCount >= STACKING_CAP) {
      invalidLandingIds.add(army.id);
      return;
    }

    const factionCounts = factionCountByBody.get(bodyId) ?? new Map<FactionId, number>();
    const currentCount = factionCounts.get(army.factionId) ?? 0;
    if (currentCount >= MAX_UNITS_PER_SIDE) {
      invalidLandingIds.add(army.id);
      return;
    }

    const byHex = landingPlanByBody.get(bodyId) ?? new Map<string, Army[]>();
    const list = byHex.get(key) ?? [];
    list.push(army);
    byHex.set(key, list);
    landingPlanByBody.set(bodyId, byHex);

    occupancy.set(key, [...occupants, army.id]);
    occupancyByBody.set(bodyId, occupancy);
    factionCounts.set(army.factionId, currentCount + 1);
    factionCountByBody.set(bodyId, factionCounts);
  });

  invalidLandingIds.forEach(armyId => {
    const army = armiesById.get(armyId);
    if (!army) return;
    armiesById.set(armyId, { ...army, landingOrder: undefined });
  });

  const distributeLandingLosses = (totalLosses: number, armies: Army[]): Record<string, number> => {
    const losses: Record<string, number> = {};
    if (totalLosses <= 0) {
      armies.forEach(army => {
        losses[army.id] = 0;
      });
      return losses;
    }
    const totalMembers = armies.reduce((sum, army) => sum + army.members, 0);
    if (totalMembers <= 0) {
      armies.forEach(army => {
        losses[army.id] = 0;
      });
      return losses;
    }

    let allocated = 0;
    const fractional: Array<{ id: string; frac: number; capacity: number }> = [];

    armies.forEach(army => {
      const raw = (totalLosses * army.members) / totalMembers;
      let baseLoss = Math.floor(raw);
      baseLoss = Math.min(baseLoss, army.members);
      losses[army.id] = baseLoss;
      allocated += baseLoss;
      fractional.push({ id: army.id, frac: raw - Math.floor(raw), capacity: army.members - baseLoss });
    });

    let remaining = totalLosses - allocated;
    const sortedFractional = sorted(fractional, (a, b) => {
      if (a.frac !== b.frac) return b.frac - a.frac;
      return a.id.localeCompare(b.id);
    });

    let idx = 0;
    while (remaining > 0 && sortedFractional.some(entry => entry.capacity > 0)) {
      const entry = sortedFractional[idx % sortedFractional.length];
      idx += 1;
      if (entry.capacity <= 0) continue;
      losses[entry.id] += 1;
      entry.capacity -= 1;
      remaining -= 1;
    }

    return losses;
  };

  landingPlanByBody.forEach((byHex, bodyId) => {
    const map = getSurfaceMap(bodyId);
    if (!map) return;
    const bodyEntry = bodyIndex.get(bodyId);
    const system = bodyEntry?.system ?? null;
    const buildings = state.groundBuildings ?? [];
    const orbitContested = system ? isOrbitContested(system, state.fleets) : false;
    const bombardedTileIds = bombardedTileIdsByBodyId.get(bodyId) ?? new Set<number>();
    const preLandingArmies = preLandingArmiesByBodyId.get(bodyId) ?? [];

    byHex.forEach((armiesOnHex, key) => {
      if (armiesOnHex.length === 0) return;
      const tileId = Number(key);
      if (!Number.isFinite(tileId)) return;
      const landingFactionId = armiesOnHex[0].factionId;
      const coord = getSurfaceTileCoordFromId(map.descriptor, tileId);

      const landingForce = armiesOnHex.reduce((sum, army) => {
        const resistance = GROUND_UNIT_STATS[army.unitType].landingResistance ?? 1;
        return sum + army.members * resistance;
      }, 0);

      let defenseProjection = 0;
      preLandingArmies.forEach(defender => {
        if (defender.factionId === landingFactionId) return;
        if (!defender.surfacePos) return;
        if (defender.members <= 0) return;
        if (isRouted(defender)) return;
        const defenderTileId = resolveTileId(map, defender.surfacePos);
        if (defenderTileId === null) return;
        const dist = tileDistance(map, defenderTileId, tileId);
        if (dist > defender.projectionRange) return;
        defenseProjection += defender.members * defender.defense * Math.max(0, Math.min(1, defender.condition));
      });

      const fortifFactor = computeFortifFactorAtCoord(map, buildings, tileId);
      defenseProjection *= fortifFactor;

      let antiOrbitalProjection = 0;
      preLandingArmies.forEach(defender => {
        if (defender.factionId === landingFactionId) return;
        if (!defender.surfacePos) return;
        if (defender.members <= 0) return;
        const rating = GROUND_UNIT_STATS[defender.unitType].antiOrbital ?? 0;
        if (rating <= 0) return;
        const defenderTileId = resolveTileId(map, defender.surfacePos);
        if (defenderTileId === null) return;
        const dist = tileDistance(map, defenderTileId, tileId);
        if (dist > defender.projectionRange) return;
        const ratio = defender.maxMembers > 0 ? defender.members / defender.maxMembers : 0;
        antiOrbitalProjection += rating * ratio;
      });

      buildings.forEach(building => {
        if (building.factionId === landingFactionId) return;
        if (building.surfacePos.bodyId !== bodyId) return;
        const buildingTileId = resolveTileId(map, building.surfacePos);
        if (buildingTileId === null || buildingTileId !== tileId) return;
        const rating = Number.isFinite(building.antiOrbital)
          ? Math.max(0, building.antiOrbital ?? 0)
          : (building.tags?.includes('anti_orbital') || building.type === 'bunker' ? 1 : 0);
        antiOrbitalProjection += rating;
      });

      const variableLoss = landingForce > 0 ? LANDING_VAR * (defenseProjection / (defenseProjection + landingForce)) : 0;
      const orbitPenalty = orbitContested ? ORBIT_CONTESTED_LANDING_PENALTY : 0;
      const bombardPenalty = bombardedTileIds.has(tileId) ? BOMBARD_LANDING_PENALTY : 0;
      const antiOrbitalPenalty = Math.min(AO_LANDING_MAX, AO_LANDING_COEFF * antiOrbitalProjection);

      const totalLossRate = Math.max(
        0,
        Math.min(LANDING_BASE + variableLoss + orbitPenalty + bombardPenalty + antiOrbitalPenalty, LANDING_MAX)
      );
      const totalMembers = armiesOnHex.reduce((sum, army) => sum + army.members, 0);
      const totalLosses = Math.min(totalMembers, Math.round(totalMembers * totalLossRate));
      const lossesById = distributeLandingLosses(totalLosses, armiesOnHex);

      armiesOnHex.forEach(army => {
        const loss = lossesById[army.id] ?? 0;
        const membersAfter = Math.max(0, army.members - loss);
        const targetPos = toSurfacePos(map, tileId);
          const updated: Army = {
          ...army,
          state: ArmyState.DEPLOYED,
          containerId: bodyId,
          surfacePos: targetPos,
          members: membersAfter,
          landingOrder: undefined,
          lastDeployedTimeMs: ctx.timeMs
        };
        armiesById.set(army.id, updated);
        landedArmyIds.add(army.id);
        if (membersAfter <= 0) {
          removeArmyIds.add(army.id);
        }
        nextLogs.push({
          id: ctx.rng.id('log'),
          timeMs: ctx.timeMs,
          type: 'combat',
          text: `Landing on ${bodyId} (${coord ? `${coord.q},${coord.r}` : `tile ${tileId}`}): ${army.id} lost ${loss} members.`
        });
      });
    });
  });

  const nextFleets =
    landedArmyIds.size > 0
      ? state.fleets.map(fleet => {
          const touched = fleet.ships.some(ship => ship.carriedArmyId && landedArmyIds.has(ship.carriedArmyId));
          if (!touched) return fleet;
          return {
            ...fleet,
            ships: fleet.ships.map(ship => {
              if (!ship.carriedArmyId || !landedArmyIds.has(ship.carriedArmyId)) return ship;
              return { ...ship, carriedArmyId: null };
            })
          };
        })
      : state.fleets;

  const deployedArmiesByBodyId = new Map<string, Army[]>();
  armiesById.forEach(army => {
    if (removeArmyIds.has(army.id)) return;
    if (army.state !== ArmyState.DEPLOYED) return;
    if (!bodyIndex.has(army.containerId)) return;
    if (!army.surfacePos) return;
    if (army.members <= 0) return;
    const list = deployedArmiesByBodyId.get(army.containerId) ?? [];
    list.push(army);
    deployedArmiesByBodyId.set(army.containerId, list);
  });

  const bodyOwnerOverrides = new Map<string, FactionId | null>();

  const bodyIds = sorted(Array.from(deployedArmiesByBodyId.keys()), (a, b) => a.localeCompare(b));

  bodyIds.forEach(bodyId => {
    const map = getSurfaceMap(bodyId);
    if (!map) return;
    const buildings = state.groundBuildings ?? [];
    const bombardedTileIds = bombardedTileIdsByBodyId.get(bodyId) ?? new Set<number>();
    const bodyArmies = sorted(deployedArmiesByBodyId.get(bodyId) ?? [], (a, b) => a.id.localeCompare(b.id));
    if (bodyArmies.length === 0) return;

    const occupancy = new Map<string, string[]>();
    bodyArmies.forEach(army => {
      if (!army.surfacePos) return;
      const tileId = resolveTileId(map, army.surfacePos);
      if (tileId === null) return;
      const key = tileKey(tileId);
      const ids = occupancy.get(key) ?? [];
      ids.push(army.id);
      occupancy.set(key, ids);
    });

    const getOccupants = (tileId: number): Army[] => {
      const ids = occupancy.get(tileKey(tileId)) ?? [];
      return ids.map(id => armiesById.get(id)).filter((a): a is Army => Boolean(a));
    };

    const removeFromOccupancy = (tileId: number, armyId: string) => {
      const key = tileKey(tileId);
      const ids = occupancy.get(key);
      if (!ids) return;
      const next = ids.filter(id => id !== armyId);
      if (next.length === 0) {
        occupancy.delete(key);
      } else {
        occupancy.set(key, next);
      }
    };

    const addToOccupancy = (tileId: number, armyId: string) => {
      const key = tileKey(tileId);
      const ids = occupancy.get(key) ?? [];
      occupancy.set(key, [...ids, armyId]);
    };

    const factionIds = sorted(
      Array.from(new Set(bodyArmies.map(army => army.factionId))),
      (a, b) => a.localeCompare(b)
    );
    const supplyByFaction = new Map<FactionId, Uint16Array | null>();
    factionIds.forEach(fid => {
      const dist = computeSupplyDistanceMapFromSurfaceMap(map, buildings, settlementControl, fid);
      supplyByFaction.set(fid, dist);
    });

    const isArmySupplied = (army: Army): boolean => {
      const tileId = army.surfacePos ? resolveTileId(map, army.surfacePos) : null;
      if (tileId === null) return false;
      const dist = supplyByFaction.get(army.factionId) ?? null;
      return isSupplied(dist, tileId, map);
    };

    const zocPre = computeZocSnapshotFromArmies({ bodyId, map, armies: bodyArmies });
    const enteredEnemyZoc = new Map<string, boolean>();

    bodyArmies.forEach(armyBase => {
      const current = armiesById.get(armyBase.id) ?? armyBase;
      if (!current.surfacePos) return;
      if (removeArmyIds.has(current.id)) return;
      const moveOrder = current.groundOrders?.move;
      if (!moveOrder) return;

      if (moveOrder.to.bodyId !== bodyId) {
        const nextOrders = normalizeOrders({ ...current.groundOrders, move: undefined });
        armiesById.set(current.id, { ...current, groundOrders: nextOrders });
        return;
      }

      const targetTileId = resolveTileId(map, moveOrder.to);
      if (targetTileId === null) {
        const nextOrders = normalizeOrders({ ...current.groundOrders, move: undefined });
        armiesById.set(current.id, { ...current, groundOrders: nextOrders });
        return;
      }
      const supplied = isArmySupplied(current);
      const currentTileId = resolveTileId(map, current.surfacePos);
      if (currentTileId === null) return;
      removeFromOccupancy(currentTileId, current.id);

      const result = executeMoveOrder({
        state,
        army: current,
        toTileId: targetTileId,
        supplied,
        zocSnapshot: zocPre,
        getOccupants,
        stackingCap: STACKING_CAP
      });

      let updatedArmy = result.updatedArmy;
      let updatedOrders = updatedArmy.groundOrders;
      if (updatedArmy.surfacePos && updatedOrders?.move) {
        const updatedTileId = resolveTileId(map, updatedArmy.surfacePos);
        const reached = updatedTileId !== null && updatedTileId === targetTileId;
        if (reached) {
          updatedOrders = normalizeOrders({ ...updatedOrders, move: undefined });
          updatedArmy = { ...updatedArmy, groundOrders: updatedOrders };
        }
      }

      armiesById.set(updatedArmy.id, updatedArmy);

      const finalPos = updatedArmy.surfacePos ?? current.surfacePos;
      const finalTileId = resolveTileId(map, finalPos);
      if (finalTileId !== null) {
        addToOccupancy(finalTileId, updatedArmy.id);
      }

      if (result.enteredEnemyZoc) {
        enteredEnemyZoc.set(updatedArmy.id, true);
      }

      if (result.moved) {
        nextLogs.push({
          id: ctx.rng.id('log'),
          timeMs: ctx.timeMs,
          type: 'move',
          text: `Ground unit ${current.id} moved ${result.steps} tiles on ${bodyId}.`
        });
      }
    });

    const postMoveArmies = sorted(
      bodyArmies
        .map(army => armiesById.get(army.id) ?? army)
        .filter(
          army =>
            army.state === ArmyState.DEPLOYED &&
            army.containerId === bodyId &&
            army.surfacePos &&
            army.members > 0 &&
            !removeArmyIds.has(army.id)
        ),
      (a, b) => a.id.localeCompare(b.id)
    );

    const stackingFactors = computeStackingFactors(occupancy);

    const validAttackOrders = new Map<string, string>();

    postMoveArmies.forEach(attacker => {
      const attackOrder = attacker.groundOrders?.attack;
      if (!attackOrder) return;

      const defender = armiesById.get(attackOrder.targetArmyId);
      if (
        !defender ||
        defender.state !== ArmyState.DEPLOYED ||
        defender.containerId !== bodyId ||
        !defender.surfacePos ||
        removeArmyIds.has(defender.id) ||
        defender.factionId === attacker.factionId
      ) {
        const nextOrders = normalizeOrders({ ...attacker.groundOrders, attack: undefined });
        armiesById.set(attacker.id, { ...attacker, groundOrders: nextOrders });
        return;
      }

      if (!attacker.surfacePos) return;
      const attackerTileId = resolveTileId(map, attacker.surfacePos);
      const defenderTileId = resolveTileId(map, defender.surfacePos);
      if (attackerTileId === null || defenderTileId === null) return;

      const dist = tileDistance(map, attackerTileId, defenderTileId);
      if (dist < attacker.rangeMin || dist > attacker.rangeMax) return;
      if (!hasLineOfSight({ map, buildings, fromTileId: attackerTileId, toTileId: defenderTileId })) return;
      if (isRouted(attacker)) return;

      validAttackOrders.set(attacker.id, defender.id);
    });

    const forcedAttacks = new Map<string, string>();

    const computeDefensePotential = (defender: Army): number => {
      if (!defender.surfacePos) return 0;
      const defenderTileId = resolveTileId(map, defender.surfacePos);
      if (defenderTileId === null) return 0;
      const stackingFactor = stackingFactors.get(defender.id) ?? 1;
      const moraleFactor = Math.max(0, Math.min(1, defender.morale));
      const fatigueFactor = Math.max(FATIGUE_FACTOR_MIN, 1 - defender.fatigue);
      const base =
        defender.members *
        defender.defense *
        Math.max(0, Math.min(1, defender.condition)) *
        moraleFactor *
        fatigueFactor *
        stackingFactor;
      const coverFactor = computeCoverFactorAtCoord(map, buildings, defenderTileId);
      const fortifFactor = computeFortifFactorAtCoord(map, buildings, defenderTileId);
      return base * coverFactor * fortifFactor;
    };

    postMoveArmies.forEach(attacker => {
      if (!enteredEnemyZoc.get(attacker.id)) return;
      if (validAttackOrders.has(attacker.id)) return;
      if (!attacker.surfacePos) return;
      if (isRouted(attacker)) return;

      const candidates = postMoveArmies.filter(defender => {
        if (defender.factionId === attacker.factionId) return false;
        if (!defender.surfacePos) return false;
        if (defender.members <= 0) return false;
        if (isRouted(defender)) return false;
        const attackerTileId = resolveTileId(map, attacker.surfacePos);
        const defenderTileId = resolveTileId(map, defender.surfacePos);
        if (attackerTileId === null || defenderTileId === null) return false;
        const distToDefender = tileDistance(map, defenderTileId, attackerTileId);
        if (distToDefender > defender.projectionRange) return false;
        if (distToDefender < attacker.rangeMin || distToDefender > attacker.rangeMax) return false;
        if (!hasLineOfSight({ map, buildings, fromTileId: attackerTileId, toTileId: defenderTileId })) return false;
        return true;
      });

      if (candidates.length === 0) return;

      let best = candidates[0];
      let bestScore = computeDefensePotential(best);
      for (let i = 1; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        const score = computeDefensePotential(candidate);
        if (score > bestScore || (score === bestScore && candidate.id.localeCompare(best.id) < 0)) {
          best = candidate;
          bestScore = score;
        }
      }

      forcedAttacks.set(attacker.id, best.id);
    });

    const attackersByDefender = new Map<string, Array<{ attackerId: string; frontAssault: boolean }>>();
    validAttackOrders.forEach((defenderId, attackerId) => {
      const list = attackersByDefender.get(defenderId) ?? [];
      list.push({ attackerId, frontAssault: false });
      attackersByDefender.set(defenderId, list);
    });
    forcedAttacks.forEach((defenderId, attackerId) => {
      const list = attackersByDefender.get(defenderId) ?? [];
      list.push({ attackerId, frontAssault: true });
      attackersByDefender.set(defenderId, list);
    });

    const combatParticipants = new Set<string>();

    const defenderEntries = sorted(
      Array.from(attackersByDefender.keys()).map(defenderId => {
        const defender = armiesById.get(defenderId);
        const tileId = defender?.surfacePos ? resolveTileId(map, defender.surfacePos) ?? -1 : -1;
        return { defenderId, tileId };
      }),
      (a, b) => (a.tileId !== b.tileId ? a.tileId - b.tileId : a.defenderId.localeCompare(b.defenderId))
    );

    defenderEntries.forEach(entry => {
      const defender = armiesById.get(entry.defenderId);
      if (!defender || removeArmyIds.has(defender.id) || defender.members <= 0 || !defender.surfacePos) return;
      const attackerEntries = attackersByDefender.get(entry.defenderId) ?? [];
      if (attackerEntries.length === 0) return;

      const attackers: EngagementParticipant[] = [];
      attackerEntries.forEach(attackerEntry => {
        const attacker = armiesById.get(attackerEntry.attackerId);
        if (!attacker) return;
        if (removeArmyIds.has(attacker.id)) return;
        if (attacker.state !== ArmyState.DEPLOYED || attacker.containerId !== bodyId) return;
        if (!attacker.surfacePos || attacker.members <= 0) return;
        if (isRouted(attacker)) return;
        attackers.push({
          army: attacker,
          supplied: isArmySupplied(attacker),
          stackingFactor: stackingFactors.get(attacker.id) ?? 1,
          frontAssault: attackerEntry.frontAssault
        });
      });

      if (attackers.length === 0) return;

      const engagement = resolveEngagement({
        timeMs: ctx.timeMs,
        map,
        buildings,
        bombardedTileIds,
        attackers,
        defender: {
          army: defender,
          supplied: isArmySupplied(defender),
          stackingFactor: stackingFactors.get(defender.id) ?? 1
        }
      });

      engagement.attackersAfter.forEach(updated => {
        const attackerAfter: Army =
          updated.posture === 'prepared_defense'
            ? { ...updated, posture: 'normal', postureSetTimeMs: undefined }
            : updated;
        armiesById.set(attackerAfter.id, attackerAfter);
        combatParticipants.add(attackerAfter.id);
        if (attackerAfter.members <= 0) {
          removeArmyIds.add(attackerAfter.id);
          if (attackerAfter.surfacePos) {
            const attackerTileId = resolveTileId(map, attackerAfter.surfacePos);
            if (attackerTileId !== null) {
              removeFromOccupancy(attackerTileId, attackerAfter.id);
            }
          }
        }
      });

      armiesById.set(engagement.defenderAfter.id, engagement.defenderAfter);
      combatParticipants.add(engagement.defenderAfter.id);
      if (engagement.defenderAfter.members <= 0) {
        removeArmyIds.add(engagement.defenderAfter.id);
        if (engagement.defenderAfter.surfacePos) {
          const defenderTileId = resolveTileId(map, engagement.defenderAfter.surfacePos);
          if (defenderTileId !== null) {
            removeFromOccupancy(defenderTileId, engagement.defenderAfter.id);
          }
        }
      }

      nextLogs.push({
        id: ctx.rng.id('log'),
        timeMs: ctx.timeMs,
        type: 'combat',
        text: `Ground combat on ${bodyId}: ${engagement.defenderId} vs ${engagement.attackerIds.join(', ')} losses A=${engagement.lossesAtkTotal} D=${engagement.lossesDef}.`
      });
    });

    postMoveArmies.forEach(army => {
      if (removeArmyIds.has(army.id)) return;
      const attackOrder = army.groundOrders?.attack;
      if (!attackOrder) return;
      const target = armiesById.get(attackOrder.targetArmyId);
      if (
        !target ||
        removeArmyIds.has(target.id) ||
        target.state !== ArmyState.DEPLOYED ||
        target.containerId !== bodyId ||
        target.factionId === army.factionId
      ) {
        const nextOrders = normalizeOrders({ ...army.groundOrders, attack: undefined });
        armiesById.set(army.id, { ...army, groundOrders: nextOrders });
      }
    });

    const postCombatArmies = postMoveArmies
      .map(army => armiesById.get(army.id) ?? army)
      .filter(
        army =>
          army.state === ArmyState.DEPLOYED &&
          army.containerId === bodyId &&
          army.surfacePos &&
          army.members > 0 &&
          !removeArmyIds.has(army.id)
      );

    const zocCapture = computeZocSnapshotFromArmies({ bodyId, map, armies: postCombatArmies });
    const settlements = map.settlements;
    settlements.forEach(settlement => {
      const tileId = settlement.tileId;
      if (!Number.isFinite(tileId)) return;
      const key = tileKey(tileId);
      const occupantIds = occupancy.get(key) ?? [];
      const occupantFactions = new Set<FactionId>();
      occupantIds.forEach(id => {
        const occupant = armiesById.get(id);
        if (!occupant || removeArmyIds.has(occupant.id) || occupant.members <= 0) return;
        occupantFactions.add(occupant.factionId);
      });

      if (occupantFactions.size === 1) {
        const [factionId] = Array.from(occupantFactions.values());
        const enemyZoc = isInEnemyZoc(zocCapture, Math.floor(tileId), factionId);
        if (!enemyZoc) {
          const current = settlementControl[settlement.id];
          if (!current || current.factionId !== factionId) {
            settlementControl = {
              ...settlementControl,
              [settlement.id]: { factionId, lastCaptureTimeMs: ctx.timeMs }
            };
            nextLogs.push({
              id: ctx.rng.id('log'),
              timeMs: ctx.timeMs,
              type: 'combat',
              text: `Settlement ${settlement.name} captured by ${factionId} on ${bodyId}.`
            });
          }
        }
      }
    });

    let winnerFactionId: FactionId | null = null;
    if (settlements.length > 0) {
      const controllers = settlements
        .map(s => settlementControl[s.id]?.factionId ?? s.factionId ?? null)
        .filter(Boolean) as FactionId[];
      const uniqueControllers = new Set(controllers);
      if (uniqueControllers.size === 1 && controllers.length === settlements.length) {
        winnerFactionId = controllers[0];
      }
    }

    if (!winnerFactionId) {
      const activeFactions = new Set(
        postCombatArmies.filter(army => !isRouted(army) && army.members > 0).map(army => army.factionId)
      );
      if (activeFactions.size === 1) {
        winnerFactionId = Array.from(activeFactions.values())[0];
      }
    }

    if (winnerFactionId) {
      const initialOwner = initialBodyOwners.get(bodyId) ?? null;
      if (winnerFactionId !== initialOwner) {
        bodyOwnerOverrides.set(bodyId, winnerFactionId);
        const remainingByFaction = new Map<FactionId, number>();
        postCombatArmies.forEach(army => {
          remainingByFaction.set(army.factionId, (remainingByFaction.get(army.factionId) ?? 0) + army.members);
        });
        const involvedFactionIds = new Set<FactionId>();
        remainingByFaction.forEach((_, factionId) => involvedFactionIds.add(factionId));
        [initialOwner, winnerFactionId].forEach(fid => {
          if (fid) involvedFactionIds.add(fid);
        });

        const bodyEntry = bodyIndex.get(bodyId);
        const bodyName = bodyEntry?.body.name ?? bodyId;
        const systemName = bodyEntry?.system.name ?? bodyEntry?.system.id ?? 'unknown';

        const formatRemainingLine = (): string => {
          if (remainingByFaction.size === 0) return 'Remaining forces - none';
          const parts = sorted(Array.from(remainingByFaction.entries()), ([a], [b]) => a.localeCompare(b)).map(
            ([factionId, totalMembers]) => `${factionId}: ${totalMembers} members`
          );
          return `Remaining forces - ${parts.join(', ')}`;
        };

        const isPlayerInvolved = involvedFactionIds.has(state.playerFactionId);
        const timeMinutes = ctx.timeMs / MS_PER_MINUTE;
        const message: GameMessage = {
          id: ctx.rng.id('msg'),
          timeMs: ctx.timeMs,
          type: 'PLANET_CONQUERED',
          priority: isPlayerInvolved ? 2 : 1,
          title: `${bodyName} conquered`,
          subtitle: `${systemName} • T+${timeMinutes}m`,
          lines: ['Losses - see combat log', formatRemainingLine()],
          payload: {
            planetId: bodyId,
            systemId: bodyEntry?.system.id ?? 'unknown',
            involvedFactionIds: sorted(Array.from(involvedFactionIds), (a, b) => a.localeCompare(b))
          },
          read: false,
          dismissed: false,
          createdAtTimeMs: ctx.timeMs
        };
        nextMessages = canonicalizeMessages([...nextMessages, message]);
      }

      postCombatArmies.forEach(army => {
        const morale = Math.min(army.morale, POST_BATTLE_MORALE_CAP);
        const fatigue = Math.min(1, army.fatigue + POST_BATTLE_FATIGUE_ADD);
        const routed = deriveRoutedAfterMorale(army, morale);
        if (morale !== army.morale || fatigue !== army.fatigue || routed !== (army.routed ?? false)) {
          armiesById.set(army.id, { ...army, morale, fatigue, routed });
        }
      });
    }

    postCombatArmies.forEach(army => {
      if (removeArmyIds.has(army.id)) return;
      if (combatParticipants.has(army.id)) return;
      const lastCombatTimeMs = army.lastCombatTimeMs ?? -Infinity;
      if (lastCombatTimeMs > ctx.timeMs - 2 * MS_PER_MINUTE) return;
      const morale = Math.min(1, army.morale + MORALE_RECOVERY);
      const condition = Math.min(1, army.condition + CONDITION_RECOVERY);
      const fatigue = Math.max(0, army.fatigue - FATIGUE_RECOVERY);
      const routed = deriveRoutedAfterMorale(army, morale);
      if (
        morale !== army.morale ||
        condition !== army.condition ||
        fatigue !== army.fatigue ||
        routed !== (army.routed ?? false)
      ) {
        armiesById.set(army.id, { ...army, morale, condition, fatigue, routed });
      }
    });
  });

  const nextArmies: Army[] = state.armies
    .map(army => armiesById.get(army.id) ?? army)
    .filter(army => !removeArmyIds.has(army.id));

  const updatedSystems = state.systems.map(system => {
    const updatedPlanets = system.planets.map(body => {
      if (!body.isSolid) return body;
      const override = bodyOwnerOverrides.get(body.id);
      if (override === undefined) return body;
      return { ...body, ownerFactionId: override };
    });

    const solidBodies = updatedPlanets.filter(body => body.isSolid);
    const uniformSolidOwner = (() => {
      if (solidBodies.length === 0) return null;
      const [firstBody] = solidBodies;
      if (!firstBody.ownerFactionId) return null;
      const sharedOwner = firstBody.ownerFactionId;
      const hasMismatch = solidBodies.some(body => body.ownerFactionId !== sharedOwner);
      return hasMismatch ? null : sharedOwner;
    })();

    const newOwnerFactionId = uniformSolidOwner ?? system.ownerFactionId;
    const ownerChanged = newOwnerFactionId !== system.ownerFactionId;

    if (ownerChanged && newOwnerFactionId && aiFactionIds.has(newOwnerFactionId)) {
      if (!holdUpdates[newOwnerFactionId]) {
        holdUpdates[newOwnerFactionId] = [];
      }
      holdUpdates[newOwnerFactionId].push(system.id);
    }

    if (ownerChanged && newOwnerFactionId) {
      const sortedBodies = sorted(solidBodies, (a, b) => a.id.localeCompare(b.id));
      const involvedFactionIds = new Set<FactionId>(
        [system.ownerFactionId, newOwnerFactionId].filter((factionId): factionId is FactionId => Boolean(factionId))
      );

      nextLogs = [
        ...nextLogs,
        {
          id: ctx.rng.id('log'),
          timeMs: ctx.timeMs,
          text: `System ${system.name} control set to ${newOwnerFactionId} after ground conquest.`,
          type: 'combat'
        }
      ];

      const isPlayerInvolved = newOwnerFactionId === state.playerFactionId || system.ownerFactionId === state.playerFactionId;

      if (isPlayerInvolved) {
        const timeMinutes = ctx.timeMs / MS_PER_MINUTE;
        const systemMessage: GameMessage = {
          id: ctx.rng.id('msg'),
          timeMs: ctx.timeMs,
          type: 'SYSTEM_SECURED',
          priority: newOwnerFactionId === state.playerFactionId ? 2 : 1,
          title: `${system.name} secured`,
          subtitle: `T+${timeMinutes}m`,
          lines: [
            `Solid bodies held: ${
              sortedBodies.filter(body => body.ownerFactionId === newOwnerFactionId).map(body => body.name).join(', ') || 'None'
            }.`
          ],
          payload: {
            systemId: system.id,
            newOwnerFactionId,
            involvedFactionIds: sorted(Array.from(involvedFactionIds), (a, b) => a.localeCompare(b))
          },
          read: false,
          dismissed: false,
          createdAtTimeMs: ctx.timeMs
        };

        nextMessages = canonicalizeMessages([...nextMessages, systemMessage]);
      }
    }

    const newColor =
      ownerChanged && newOwnerFactionId ? state.factions.find(faction => faction.id === newOwnerFactionId)?.color ?? COLORS.star : system.color;

    return {
      ...system,
      ownerFactionId: newOwnerFactionId,
      color: newColor,
      planets: updatedPlanets
    };
  });

  if (Object.keys(holdUpdates).length > 0) {
    nextAiStates = { ...nextAiStates };

    Object.entries(holdUpdates).forEach(([factionId, systemIds]) => {
      const existingState: AIState = nextAiStates[factionId] ?? createEmptyAIState();
      const holdUntilTimeMs = ctx.timeMs + AI_HOLD_DAYS * MS_PER_DAY;

      const updatedState: AIState = {
        ...existingState,
        holdUntilTimeMsBySystemId: {
          ...existingState.holdUntilTimeMsBySystemId,
          ...systemIds.reduce<Record<string, number>>((acc, systemId) => {
            acc[systemId] = holdUntilTimeMs;
            return acc;
          }, {})
        }
      };

      nextAiStates[factionId] = updatedState;
    });
  }

  return {
    ...state,
    systems: updatedSystems,
    fleets: nextFleets,
    armies: nextArmies,
    logs: nextLogs,
    messages: nextMessages,
    aiStates: nextAiStates,
    settlementControl
  };
}

export function phaseObjectives(state: GameState, ctx: StrategicContext): GameState {
  if (state.winnerFactionId) return state; // Already decided

  const winnerFactionId = checkVictoryConditions({ ...state, timeMs: ctx.timeMs });

  if (winnerFactionId) {
    return { ...state, winnerFactionId };
  }

  return state;
}

const LOG_RETENTION_LIMIT = 2000;
const MESSAGE_RETENTION_LIMIT = 500;
const MIN_TANKER_RESERVE_RATIO = 0.1;

function trimLogs(logs: GameState['logs']): GameState['logs'] {
  if (logs.length <= LOG_RETENTION_LIMIT) return logs;
  return logs.slice(-LOG_RETENTION_LIMIT);
}

function trimMessages(messages: GameState['messages']): GameState['messages'] {
  if (messages.length <= MESSAGE_RETENTION_LIMIT) return messages;
  return messages.slice(-MESSAGE_RETENTION_LIMIT);
}

function getFuelCapacity(type: ShipType): number {
  return SHIP_STATS[type]?.fuelCapacity ?? 0;
}
function getExtractorRate(): number {
  return SHIP_STATS[ShipType.EXTRACTOR]?.fuelExtractionRate ?? 0;
}
function getFuelTransferRate(type: ShipType): number {
  return SHIP_STATS[type]?.fuelTransferRate ?? 0;
}

function getFleetsInCaptureRangeBySystem(systems: StarSystem[], fleets: Fleet[]): Map<string, Fleet[]> {
  const gasSystems = systems.filter(system => system.resourceType === 'gas');
  const bySystem = new Map<string, Fleet[]>();

  for (const system of gasSystems) {
    const fleetsInRange = fleets.filter(fleet => fleet.ships.length > 0 && distSq(fleet.position, system.position) <= CAPTURE_RANGE_SQ);

    if (fleetsInRange.length > 0) {
      bySystem.set(system.id, fleetsInRange);
    }
  }

  return bySystem;
}

function applyGasExtractionToFleet(fleet: Fleet, system: StarSystem | null, fleetsInRange: Fleet[]): Fleet {
  if (!system || system.resourceType !== 'gas') return fleet;

  const extractorRate = getExtractorRate();
  if (extractorRate <= 0) return fleet;

  const extractorCount = fleet.ships.filter(ship => ship.type === ShipType.EXTRACTOR).length;
  if (extractorCount === 0) return fleet;

  const hasEnemyInRange = fleetsInRange.some(otherFleet => otherFleet.factionId !== fleet.factionId);
  if (hasEnemyInRange || isOrbitContested(system, fleetsInRange)) return fleet;

  let remaining = extractorCount * extractorRate;
  if (remaining <= 0) return fleet;

  const ships = fleet.ships.map(ship => ({ ...ship }));
  const targets = ships
    .map((ship, index) => {
      const capacity = getFuelCapacity(ship.type);
      const missing = Math.max(0, capacity - ship.fuel);
      return { index, capacity, missing };
    })
    .filter(target => target.capacity > 0 && target.missing > 0);

  if (targets.length === 0) return fleet;

  let remainingTargets = targets.length;
  for (const target of targets) {
    const share = remaining / remainingTargets;
    const delta = Math.min(target.missing, share);
    if (delta > 0) {
      const ship = ships[target.index];
      const currentFuel = ship.fuel;
      const nextFuel = Math.min(target.capacity, currentFuel + delta);
      ship.fuel = quantizeFuel(nextFuel);
      const added = ship.fuel - currentFuel;
      remaining -= added;
    }
    remainingTargets -= 1;
  }

  return { ...fleet, ships };
}

function applyGasExtraction(state: GameState): GameState {
  if (state.rules?.unlimitedFuel) return state;

  const fleetsBySystem = getFleetsInCaptureRangeBySystem(state.systems, state.fleets);

  let fleetsChanged = false;
  const fleets = state.fleets.map(fleet => {
    const system = getOrbitingSystem(fleet, state.systems);
    const fleetsInRange = system ? fleetsBySystem.get(system.id) ?? [] : [];
    const updated = applyGasExtractionToFleet(fleet, system, fleetsInRange);
    if (updated !== fleet) fleetsChanged = true;
    return updated;
  });

  if (!fleetsChanged) return state;
  return { ...state, fleets };
}

function applyTankerTransfersToFleet(fleet: Fleet): Fleet {
  const transferBudget = fleet.ships.reduce((total, ship) => {
    if (ship.type !== ShipType.TANKER) return total;
    return total + getFuelTransferRate(ship.type);
  }, 0);

  if (transferBudget <= 0) return fleet;

  const tankers = fleet.ships
    .map((ship, index) => ({ ship, index }))
    .filter(({ ship }) => ship.type === ShipType.TANKER)
    .map(({ ship, index }) => {
      const capacity = getFuelCapacity(ship.type);
      const reserve = capacity * MIN_TANKER_RESERVE_RATIO;
      const available = quantizeFuel(Math.max(0, ship.fuel - reserve));
      return { index, available };
    })
    .filter(tanker => tanker.available > 0);

  if (tankers.length === 0) return fleet;

  const targets = fleet.ships
    .map((ship, index) => ({ ship, index }))
    .filter(({ ship }) => ship.type !== ShipType.TANKER)
    .map(({ ship, index }) => {
      const capacity = getFuelCapacity(ship.type);
      const missing = Math.max(0, capacity - ship.fuel);
      return { index, capacity, missing };
    })
    .filter(target => target.capacity > 0 && target.missing > 0);

  if (targets.length === 0) return fleet;

  const ships = fleet.ships.map(ship => ({ ...ship }));
  let remainingBudget = transferBudget;
  let remainingAvailable = tankers.reduce((total, tanker) => total + tanker.available, 0);
  let changed = false;

  for (const target of targets) {
    if (remainingBudget <= 0 || remainingAvailable <= 0) break;

    let missing = target.capacity - ships[target.index].fuel;
    for (const tanker of tankers) {
      if (missing <= 0 || remainingBudget <= 0 || remainingAvailable <= 0) break;
      if (tanker.available <= 0) continue;

      const transferable = Math.min(missing, tanker.available, remainingBudget);
      const transfer = quantizeFuel(transferable);
      if (transfer <= 0) continue;

      const tankerShip = ships[tanker.index];
      const recipient = ships[target.index];

      const updatedRecipientFuel = Math.min(target.capacity, quantizeFuel(recipient.fuel + transfer));
      const updatedTankerFuel = quantizeFuel(tankerShip.fuel - transfer);

      if (updatedRecipientFuel !== recipient.fuel) {
        ships[target.index] = { ...recipient, fuel: updatedRecipientFuel };
        missing = target.capacity - updatedRecipientFuel;
        changed = true;
      } else {
        missing = target.capacity - recipient.fuel;
      }

      if (updatedTankerFuel !== tankerShip.fuel) {
        ships[tanker.index] = { ...tankerShip, fuel: updatedTankerFuel };
        changed = true;
      }

      tanker.available = quantizeFuel(tanker.available - transfer);
      remainingBudget = quantizeFuel(remainingBudget - transfer);
      remainingAvailable = quantizeFuel(remainingAvailable - transfer);
    }
  }

  if (!changed) return fleet;
  return { ...fleet, ships };
}

function applyTankerTransfers(state: GameState): GameState {
  if (state.rules?.unlimitedFuel) return state;

  let fleetsChanged = false;
  const fleets = state.fleets.map(fleet => {
    const updated = applyTankerTransfersToFleet(fleet);
    if (updated !== fleet) fleetsChanged = true;
    return updated;
  });

  if (!fleetsChanged) return state;
  return { ...state, fleets };
}

export function phaseCleanup(state: GameState, ctx: StrategicContext): GameState {
  // 1. Prune Old Battles
  const activeBattles = pruneBattles(state.battles, ctx.timeMs);
  const fleetIds = new Set(state.fleets.map(fleet => fleet.id));

  const carrierLossLogs: string[] = [];
  const armiesAfterFleetLoss = state.armies.filter(army => {
    if (army.state === ArmyState.EMBARKED && !fleetIds.has(army.containerId)) {
      carrierLossLogs.push(`Army ${army.id} removed after losing transport fleet ${army.containerId}.`);
      return false;
    }
    return true;
  });

  // 2. Sanitize Armies (Remove orphans, fix references)
  // Note: We use a temp state with pruned battles to ensure army logic has fresh context
  const { state: sanitizedArmyState, logs: sanitizationLogs } = sanitizeArmies({
    ...state,
    armies: armiesAfterFleetLoss,
    battles: activeBattles
  });

  // 3. Apply passive gas extraction before final log trim
  const extractedState = applyGasExtraction(sanitizedArmyState);
  const refueledState = applyTankerTransfers(extractedState);

  // 4. Add Tech Logs
  const newLogs = [...refueledState.logs];
  [...carrierLossLogs, ...sanitizationLogs].forEach(txt => {
    newLogs.push({
      id: ctx.rng.id('log'),
      timeMs: ctx.timeMs,
      text: `[SYSTEM] ${txt}`,
      type: 'info'
    });
  });

  return {
    ...refueledState,
    battles: activeBattles,
    logs: trimLogs(newLogs),
    messages: trimMessages(refueledState.messages)
  };
}
