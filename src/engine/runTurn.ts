
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
  HexCoord,
  LogEntry,
  ShipType,
  StarSystem
} from '../shared/types';
import { RNG } from './rng';
import { deepFreezeDev } from './state/immutability';
import { canonicalizeMessages, canonicalizeState, isCanonical } from './state/canonicalize';
import { createEmptyAIState, getLegacyAiFactionId, planAiTurn, AI_HOLD_TURNS } from './ai';
import { applyCommand } from './commands';
import { detectNewBattles, pruneBattles } from './battle/detection';
import { resolveBattle } from './battle/resolution';
import { moveFleet, executeArrivalOperations, MovementStepResult } from './movement/movementPhase';
import { normalizeSurfacePositions } from './planetSurface/positions';
import { checkVictoryConditions } from './objectives';
import { ORBIT_PROXIMITY_RANGE_SQ, COLORS, CAPTURE_RANGE_SQ, SHIP_STATS } from '../content/data/static';
import { isOrbitContested, getOrbitingSystem } from './orbit';
import { distSq } from './math/vec3';
import { resolveOrbitalBombardment } from './orbitalBombardment';
import { generateSurfaceMapForState } from './planetSurface/access';
import { neighborsAxial } from './planetSurface/hex';
import { isPassable, relocateSurfacePosDeterministic } from './planetSurface/validation';
import { deriveTerrainType } from './ground/terrain';
import { computeSupplyDistanceMapForBody, SUPPLY_RADIUS } from './ground/supply';
import { computeZocSnapshotForBody } from './ground/zoc';
import { executeMoveOrder } from './ground/movement';
import { resolveEngagement } from './ground/combat';
import { applyOverrunPenalty, chooseDefenderRetreat } from './ground/breakOutcome';
import { hexKey } from './ground/utils';
import { sanitizeArmies } from './army';
import { quantizeFuel } from './logistics/fuel';
import { sorted } from '../shared/sorting';

export interface TurnContext {
  turn: number;
  rng: RNG;
}

export const runTurn = (state: GameState, rng: RNG): GameState => {
  // Enforce Immutability on Input
  deepFreezeDev(state);

  const turn = state.day + 1;
  const ctx: TurnContext = { rng, turn };
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
  let nextState = { ...state, day: turn };
  if ((import.meta as any).env?.DEV && !isCanonical(nextState)) {
    console.warn('[RunTurn] Input state not canonical; normalizing for determinism.');
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

  // SAFETY: Ensure all battles are resolved before cleanup so turnResolved is always set
  const remainingBattles = nextState.battles.filter(b => b.status === 'scheduled');
  if (remainingBattles.length > 0) {
    console.error(`[RunTurn] CRITICAL: Scheduled battles remaining at end of turn ${ctx.turn}: ${remainingBattles.map(b => b.id).join(', ')}. Force-resolving.`);
    nextState = {
      ...nextState,
      battles: nextState.battles.map(b =>
        b.status === 'scheduled'
          ? {
              ...b,
              turnResolved: ctx.turn,
              status: 'resolved' as const,
              winnerFactionId: 'draw' as const,
              logs: [...b.logs, 'Battle force-resolved due to turn processing error.']
            }
          : b
      )
    };
  }

  // 8. Cleanup & Maintenance
  nextState = measure('cleanup', () => phaseCleanup(nextState, ctx));

  // 8. Canonicalize output & Time Advance
  nextState = canonicalizeState(nextState);

  if (shouldMeasure && timings.length > 0) {
    const total = timings.reduce((sum, timing) => sum + timing.ms, 0);
    const details = timings.map(timing => `${timing.label}=${timing.ms.toFixed(2)}`).join(', ');
    console.debug(`[RunTurn] phase timings (ms): ${details} | total=${total.toFixed(2)}`);
  }

  return {
      ...nextState,
      day: turn
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

export function phaseBattleResolution(state: GameState, ctx: TurnContext): GameState {
  const currentTurnState = state.day === ctx.turn ? state : { ...state, day: ctx.turn };

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
    const result = resolveBattle(battle, { ...currentTurnState, fleets: nextFleets }, ctx.turn);

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
      const sysName = currentTurnState.systems.find(s => s.id === battle.systemId)?.name || 'Unknown';
      nextLogs.push({
        id: ctx.rng.id('log'),
        day: ctx.turn,
        text: `Combat resolved at ${sysName}. Outcome: ${result.updatedBattle.winnerFactionId.toUpperCase()}.`,
        type: 'combat'
      });
    }

    // Battle Message
    const involvedFactionIdsSet = new Set<FactionId>();
    battle.involvedFleetIds.forEach(fleetId => {
      const fleet = currentTurnState.fleets.find(f => f.id === fleetId) || nextFleets.find(f => f.id === fleetId);
      if (fleet) involvedFactionIdsSet.add(fleet.factionId as FactionId);
    });
    Object.keys(result.updatedBattle.shipsLost ?? {}).forEach(factionId => involvedFactionIdsSet.add(factionId as FactionId));
    const involvedFactionIds = sorted(Array.from(involvedFactionIdsSet), (a, b) => a.localeCompare(b));

    const systemName = currentTurnState.systems.find(s => s.id === battle.systemId)?.name || 'Unknown';
    const isPlayerInvolved = involvedFactionIds.includes(currentTurnState.playerFactionId);
    const ammunitionTotals = aggregateAmmunitionTotals(result.updatedBattle.ammunitionByFaction);
    const battleSystemName = systemName || battle.systemId;

    if (lostArmyIds.length > 0) {
      sorted(lostArmyIds).forEach(armyId => {
        nextLogs.push({
          id: ctx.rng.id('log'),
          day: ctx.turn,
          text: `Army ${armyId} was lost with its transport during the battle at ${battleSystemName}.`,
          type: 'combat'
        });
      });
    }

    const message: GameMessage = {
      id: ctx.rng.id('msg'),
      day: ctx.turn,
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
      createdAtTurn: ctx.turn
    };

    nextMessages = canonicalizeMessages([...nextMessages, message]);
  });

  return {
    ...currentTurnState,
    battles: nextBattles,
    fleets: nextFleets,
    armies: nextArmies,
    logs: nextLogs,
    messages: nextMessages
  };
}

export function phaseAI(state: GameState, ctx: TurnContext): GameState {
  if (!state.rules.aiEnabled) return state;

  const currentTurnState = state.day === ctx.turn ? state : { ...state, day: ctx.turn };

  const aiFactions = sorted(
    state.factions.filter(faction => faction.aiProfile),
    (a, b) => a.id.localeCompare(b.id)
  );

  const ensuredAiStates: Record<FactionId, AIState> = { ...(currentTurnState.aiStates ?? {}) };
  const legacyAiFactionId = getLegacyAiFactionId(currentTurnState.factions);

  aiFactions.forEach(faction => {
    if (!ensuredAiStates[faction.id]) {
      const legacyState = faction.id === legacyAiFactionId ? state.aiState : undefined;
      ensuredAiStates[faction.id] = legacyState ?? createEmptyAIState();
    }
  });

  let nextState: GameState = { ...currentTurnState, aiStates: ensuredAiStates };

  for (const faction of aiFactions) {
    const existingAiState = (nextState.aiStates ?? ensuredAiStates)[faction.id] ?? createEmptyAIState();
    const commands = planAiTurn(nextState, faction.id, existingAiState, ctx.rng);

    for (const cmd of commands) {
      const result = applyCommand(nextState, cmd, ctx.rng);
      const updatedState = result.state;
      nextState = updatedState.day === ctx.turn ? updatedState : { ...updatedState, day: ctx.turn };
    }
  }

  const mergedAiStates = { ...ensuredAiStates, ...(nextState.aiStates ?? {}) };
  const alignedState = nextState.day === ctx.turn ? nextState : { ...nextState, day: ctx.turn };
  return { ...alignedState, aiStates: mergedAiStates };
}

export function phaseMovement(state: GameState, ctx: TurnContext): GameState {
  const nextDay = ctx.turn; // Movement projects to current turn positions
  const fleetsToProcess = sorted(state.fleets, (a, b) => a.id.localeCompare(b.id));
  const newLogs: LogEntry[] = [];

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
    const moveResult = moveFleet(fleet, state.systems, nextDay, ctx.rng);
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

    const arrivalFleet: Fleet = {
      ...fleet,
      invasionTargetSystemId: result.invasionTargetSystemId,
      invasionTargetPlanetId: result.invasionTargetPlanetId,
      loadTargetSystemId: result.loadTargetSystemId,
      unloadTargetSystemId: result.unloadTargetSystemId
    };

    const arrivalOutcome = executeArrivalOperations(arrivalFleet, system, workingArmies, workingFleets, ctx.rng, nextDay);

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
    logs: [...state.logs, ...newLogs]
  });
}

export function phaseBattleDetection(state: GameState, ctx: TurnContext): GameState {
  // Only detect if advanced combat is enabled
  if (!state.rules.useAdvancedCombat) return state;

  // 1. Detect New Battles based on positions
  const newBattles = detectNewBattles(state, ctx.rng, ctx.turn);
  if (newBattles.length === 0) return state;

  // 2. Collect IDs of all fleets engaged
  const involvedFleetIds = new Set<string>();
  newBattles.forEach(b => b.involvedFleetIds.forEach(id => involvedFleetIds.add(id)));

  // 3. Update Fleets to COMBAT state
  // This locks them from moving next turn until resolved
  const nextFleets = state.fleets.map(f => {
    if (involvedFleetIds.has(f.id)) {
      // Force stop movement
      return {
        ...f,
        state: FleetState.COMBAT,
        stateStartTurn: ctx.turn, // Mark conflict start
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

export function phaseOrbitalBombardment(state: GameState, ctx: TurnContext): GameState {
  if (!hasUncontestedOrbitalDominance(state)) return state;

  const result = resolveOrbitalBombardment(state);
  if (result.updates.size === 0 && result.logs.length === 0) return state;

  const nextArmies = state.armies.map(army => {
    const update = result.updates.get(army.id);
    if (!update) return army;
    return { ...army, members: update.members, condition: update.condition };
  });

  const nextLogs = [...state.logs];
  result.logs.forEach(text => {
    nextLogs.push({
      id: ctx.rng.id('log'),
      day: ctx.turn,
      text,
      type: 'combat'
    });
  });

  return {
    ...state,
    armies: nextArmies,
    logs: nextLogs
  };
}

export function phaseGround(state: GameState, ctx: TurnContext): GameState {
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

  // --- Ground Surface Combat V1 (map-based) ---

  const outOfCombat = (army: Army): boolean => army.members === 0 || army.condition < 0.2;

  const bodyIndex = new Map<string, { systemId: string; bodyId: string }>();
  state.systems.forEach(system => {
    system.planets.forEach(body => {
      if (!body.isSolid) return;
      bodyIndex.set(body.id, { systemId: system.id, bodyId: body.id });
    });
  });

  const deployedArmies = state.armies.filter(a => a.state === ArmyState.DEPLOYED && bodyIndex.has(a.containerId));
  const armiesByBodyId = deployedArmies.reduce<Map<string, Army[]>>((acc, army) => {
    const list = acc.get(army.containerId) ?? [];
    list.push(army);
    acc.set(army.containerId, list);
    return acc;
  }, new Map());

  const initialBodyOwners = new Map<string, FactionId | null>();
  state.systems.forEach(system => {
    system.planets.forEach(body => {
      if (!body.isSolid) return;
      initialBodyOwners.set(body.id, body.ownerFactionId ?? null);
    });
  });

  // Transient movement stats needed for attack situation flags
  const moveStatsByArmyId = new Map<string, { mpEff: number; mpUsedCenti: number; used75pct: boolean; supplied: boolean }>();

  // Patch armies incrementally via a map (structural sharing at the end)
  const armiesById = new Map(state.armies.map(a => [a.id, a]));
  const removeArmyIds = new Set<string>();

  // Execute per body to localize caches (surfaceMap, supply, occupancy)
  const bodyIds = sorted(Array.from(armiesByBodyId.keys()), (a, b) => a.localeCompare(b));

  bodyIds.forEach(bodyId => {
    const bodyArmies = sorted(armiesByBodyId.get(bodyId) ?? [], (a, b) => a.id.localeCompare(b.id));
    const surfaceMap = generateSurfaceMapForState(state, bodyId);
    if (!surfaceMap) return;
    const { w, h, wrapX } = surfaceMap.descriptor.config;

    // --- Pre-cleanup: remove already-out-of-combat units so they don't block movement/retreat/ownership ---
    bodyArmies.forEach(armyBase => {
      const current = armiesById.get(armyBase.id) ?? armyBase;
      if (removeArmyIds.has(current.id)) return;
      if (current.state !== ArmyState.DEPLOYED) return;
      if (current.containerId !== bodyId) return;
      if (!current.surfacePos) return;
      if (outOfCombat(current)) {
        removeArmyIds.add(current.id);
      }
    });

    const bodyArmiesLive = bodyArmies
      .map(a => armiesById.get(a.id) ?? a)
      .filter(a => a.state === ArmyState.DEPLOYED && a.containerId === bodyId && a.surfacePos && !removeArmyIds.has(a.id));

    // --- Occupancy (no stacking) with deterministic destacking ---
    const occupancy = new Map<string, string>(); // hexKey -> armyId
    const stacks = new Map<string, string[]>(); // hexKey -> armyIds
    const originByKey = new Map<string, HexCoord>();
    bodyArmiesLive.forEach(army => {
      if (!army.surfacePos) return;
      const origin: HexCoord = { q: army.surfacePos.q, r: army.surfacePos.r };
      const key = hexKey(origin);
      const ids = stacks.get(key) ?? [];
      ids.push(army.id);
      stacks.set(key, ids);
      if (!originByKey.has(key)) originByKey.set(key, origin);
    });

    // Place primary occupant per hex (lexicographically smallest id)
    stacks.forEach((ids, key) => {
      ids.sort((a, b) => a.localeCompare(b));
      occupancy.set(key, ids[0]);
    });

    const isOccupied = (coord: HexCoord): boolean => occupancy.has(hexKey(coord));
    const deleteIfMatches = (coord: HexCoord, armyId: string): void => {
      const key = hexKey(coord);
      if (occupancy.get(key) === armyId) occupancy.delete(key);
    };

    // Resolve stacks by relocating non-primary occupants to the nearest free passable tile.
    stacks.forEach((ids, key) => {
      if (ids.length <= 1) return;
      ids.sort((a, b) => a.localeCompare(b));
      const origin = originByKey.get(key);
      if (!origin) return;
      const extras = ids.slice(1);
      extras.forEach(extraId => {
        const relocated = relocateSurfacePosDeterministic({
          state,
          entityId: extraId,
          kind: 'army',
          bodyId,
          origin,
          predicate: (biome) => isPassable(biome),
          isOccupied: (q, r) => occupancy.has(hexKey({ q, r }))
        });

        if (!relocated) {
          removeArmyIds.add(extraId);
          nextLogs.push({
            id: ctx.rng.id('log'),
            day: ctx.turn,
            type: 'info',
            text: `[SYSTEM] Ground stacking on ${bodyId} at (${origin.q},${origin.r}) could not be resolved; removing ${extraId}.`
          });
          return;
        }

        const extraArmy = armiesById.get(extraId);
        if (extraArmy && extraArmy.surfacePos) {
          armiesById.set(extraId, {
            ...extraArmy,
            surfacePos: { bodyId, q: relocated.q, r: relocated.r }
          });
        }
        occupancy.set(hexKey(relocated), extraId);
        nextLogs.push({
          id: ctx.rng.id('log'),
          day: ctx.turn,
          type: 'info',
          text: `[SYSTEM] Ground stacking resolved on ${bodyId} at (${origin.q},${origin.r}): relocated ${extraId} to (${relocated.q},${relocated.r}).`
        });
      });
    });

    // Stable per-body list after stacking resolution/removals
    const bodyArmiesResolved = sorted(
      bodyArmies
        .map(a => armiesById.get(a.id) ?? a)
        .filter(a => a.state === ArmyState.DEPLOYED && a.containerId === bodyId && a.surfacePos && !removeArmyIds.has(a.id)),
      (a, b) => a.id.localeCompare(b.id)
    );

    // --- Supply maps per faction involved on this body ---
    const factionIdsOnBody = sorted(Array.from(new Set(bodyArmiesResolved.map(a => a.factionId))), (a, b) => a.localeCompare(b));
    const supplyByFaction = new Map<FactionId, Uint16Array | null>();
    factionIdsOnBody.forEach(fid => {
      supplyByFaction.set(fid, computeSupplyDistanceMapForBody(state, bodyId, fid));
    });
    const isArmySupplied = (army: Army): boolean => {
      if (!army.surfacePos) return false;
      const dist = supplyByFaction.get(army.factionId);
      if (!dist) return false;
      const idx = army.surfacePos.r * w + army.surfacePos.q;
      const d = dist[idx] ?? 0xffff;
      return d <= SUPPLY_RADIUS;
    };

    // Snapshot ZOC before movement
    const zocPre = computeZocSnapshotForBody(state, bodyId, bodyArmiesResolved) ?? null;

    // --- Execute move orders ---
    bodyArmiesResolved.forEach(army => {
      if (!army.surfacePos) return;
      if (removeArmyIds.has(army.id)) return;
      const current = armiesById.get(army.id) ?? army;
      if (!current.surfacePos) return;
      if (current.groundOrder?.type !== 'move') return;
      if (outOfCombat(current)) return;

      const supplied = isArmySupplied(current);
      // Remove self from occupancy before pathing
      deleteIfMatches({ q: current.surfacePos.q, r: current.surfacePos.r }, current.id);

      const target: HexCoord = { q: current.groundOrder.to.q, r: current.groundOrder.to.r };
      const result = executeMoveOrder({
        state,
        army: current,
        to: target,
        supplied,
        zocSnapshot: zocPre,
        isOccupied
      });

      const updatedArmy = result.updatedArmy;
      armiesById.set(updatedArmy.id, updatedArmy);
      moveStatsByArmyId.set(updatedArmy.id, {
        mpEff: result.mpEff,
        mpUsedCenti: result.mpUsedCenti,
        used75pct: result.used75pct,
        supplied
      });

      // If the unit became out-of-combat due to fatigue, remove it immediately.
      if (outOfCombat(updatedArmy)) {
        removeArmyIds.add(updatedArmy.id);
        return;
      }

      // Re-add occupancy at final position (or original if no move)
      const finalPos = updatedArmy.surfacePos ?? current.surfacePos;
      occupancy.set(hexKey({ q: finalPos.q, r: finalPos.r }), updatedArmy.id);

      if (result.moved) {
        nextLogs.push({
          id: ctx.rng.id('log'),
          day: ctx.turn,
          type: 'move',
          text: `Ground unit ${current.id} moved ${result.steps} hexes on ${bodyId} (fatigue -${result.fatigueDelta.toFixed(2)} C).`
        });
      }
    });

    // Snapshot ZOC after movement (used for retreat heuristics)
    const postMoveArmies = bodyArmiesResolved
      .map(a => armiesById.get(a.id) ?? a)
      .filter(a => a.state === ArmyState.DEPLOYED && a.containerId === bodyId && a.surfacePos && !removeArmyIds.has(a.id));
    const zocPost = computeZocSnapshotForBody(state, bodyId, postMoveArmies) ?? null;

    // --- Execute attack orders ---
    const attackers = sorted(postMoveArmies.filter(a => a.groundOrder?.type === 'attack'), (a, b) => a.id.localeCompare(b.id));

    const isAdjacent = (a: HexCoord, b: HexCoord): boolean => {
      const ns = neighborsAxial(a, w, h, wrapX);
      return ns.some(n => n.q === b.q && n.r === b.r);
    };

    attackers.forEach(attackerBase => {
      const attacker = armiesById.get(attackerBase.id);
      if (!attacker || !attacker.surfacePos) return;
      if (removeArmyIds.has(attacker.id)) return;
      if (outOfCombat(attacker)) return;
      if (attacker.condition < 0.4) return;

      const targetId = attacker.groundOrder?.type === 'attack' ? attacker.groundOrder.targetArmyId : null;
      if (!targetId) return;
      const defender = armiesById.get(targetId);
      if (!defender || defender.state !== ArmyState.DEPLOYED || defender.containerId !== bodyId || !defender.surfacePos) return;
      if (removeArmyIds.has(defender.id)) return;
      if (attacker.factionId === defender.factionId) return;
      if (!isAdjacent({ q: attacker.surfacePos.q, r: attacker.surfacePos.r }, { q: defender.surfacePos.q, r: defender.surfacePos.r }))
        return;

      const defenderHex: HexCoord = { q: defender.surfacePos.q, r: defender.surfacePos.r };
      const terrainType = deriveTerrainType(state, bodyId, defenderHex);

      const aMove = moveStatsByArmyId.get(attacker.id);
      const aSupplied = aMove?.supplied ?? isArmySupplied(attacker);
      const dSupplied = isArmySupplied(defender);

      const engagement = resolveEngagement(attacker, defender, {
        turn: ctx.turn,
        terrainType,
        attackerSituation: { spent75pctMp: aMove?.used75pct ?? false },
        defenderSituation: {},
        attackerStatus: { outOfSupply: !aSupplied },
        defenderStatus: { outOfSupply: !dSupplied }
      });

      let attackerAfter = engagement.attackerAfter;
      let defenderAfter = engagement.defenderAfter;

      // Apply break outcome (defender)
      const defenderStartKey = hexKey(defenderHex);

      if (engagement.defenderBroke && !outOfCombat(defenderAfter)) {
        const outcome = chooseDefenderRetreat({
          state,
          defender: defenderAfter,
          from: defenderHex,
          zocSnapshot: zocPost,
          isOccupied
        });
        if (outcome.type === 'retreat') {
          // Free defender origin and occupy retreat destination.
          deleteIfMatches(defenderHex, defenderAfter.id);
          defenderAfter = {
            ...defenderAfter,
            surfacePos: { bodyId, q: outcome.to.q, r: outcome.to.r }
          };
          occupancy.set(hexKey(outcome.to), defenderAfter.id);
        } else {
          defenderAfter = applyOverrunPenalty(defenderAfter);
        }
      }

      // Advance (MVP): if defender left hex, attacker may advance into it
      const defenderNowKey = defenderAfter.surfacePos ? hexKey({ q: defenderAfter.surfacePos.q, r: defenderAfter.surfacePos.r }) : null;
      const defenderLeftHex = defenderNowKey !== null && defenderNowKey !== defenderStartKey;
      if (defenderLeftHex && !outOfCombat(attackerAfter)) {
        const attackerFrom = { q: attacker.surfacePos.q, r: attacker.surfacePos.r };
        // If defenderStart is now free, advance
        if (!occupancy.get(defenderStartKey)) {
          deleteIfMatches(attackerFrom, attackerAfter.id);
          occupancy.set(defenderStartKey, attackerAfter.id);
          attackerAfter = {
            ...attackerAfter,
            surfacePos: { bodyId, q: defenderHex.q, r: defenderHex.r }
          };
        }
      }

      armiesById.set(attackerAfter.id, attackerAfter);
      armiesById.set(defenderAfter.id, defenderAfter);

      if (outOfCombat(attackerAfter)) {
        removeArmyIds.add(attackerAfter.id);
        if (attackerAfter.surfacePos) deleteIfMatches({ q: attackerAfter.surfacePos.q, r: attackerAfter.surfacePos.r }, attackerAfter.id);
      }
      if (outOfCombat(defenderAfter)) {
        removeArmyIds.add(defenderAfter.id);
        if (defenderAfter.surfacePos) deleteIfMatches({ q: defenderAfter.surfacePos.q, r: defenderAfter.surfacePos.r }, defenderAfter.id);
      }

      nextLogs.push({
        id: ctx.rng.id('log'),
        day: ctx.turn,
        type: 'combat',
        text: `Ground combat on ${bodyId} (${terrainType}): ${attacker.id} vs ${defender.id} R=${engagement.r.toFixed(2)}; losses A=${engagement.lossesAtt}, D=${engagement.lossesDef}; break=${
          engagement.defenderBroke ? 'yes' : 'no'
        }.`
      });
    });
  });

  const nextArmies: Army[] = state.armies
    .map(a => armiesById.get(a.id) ?? a)
    .map(a => ({ ...a, groundOrder: undefined })) // clear orders each turn
    .filter(a => !removeArmyIds.has(a.id));

  const nextSystems = state.systems.map(system => ({
    ...system,
    planets: system.planets.map(planet => ({ ...planet }))
  }));

  const planetIndex = new Map<string, { systemId: string; bodyId: string }>();
  nextSystems.forEach(system => {
    system.planets.forEach(body => {
      planetIndex.set(body.id, { systemId: system.id, bodyId: body.id });
    });
  });

  const armiesByBodyIdAfter = new Map<string, Army[]>();
  const armiesBySystemId = new Map<string, Army[]>();

  nextArmies.forEach(army => {
    if (army.state !== ArmyState.DEPLOYED) return;
    const match = planetIndex.get(army.containerId);
    if (!match) return;
    const listBody = armiesByBodyIdAfter.get(match.bodyId) ?? [];
    listBody.push(army);
    armiesByBodyIdAfter.set(match.bodyId, listBody);
    const listSys = armiesBySystemId.get(match.systemId) ?? [];
    listSys.push(army);
    armiesBySystemId.set(match.systemId, listSys);
  });

  const updatedSystems = nextSystems.map(system => {
    const armiesInSystem = armiesBySystemId.get(system.id) ?? [];
    const groundFactionIds = sorted(Array.from(new Set(armiesInSystem.map(army => army.factionId))), (a, b) => a.localeCompare(b));
    const soleGroundFaction = groundFactionIds.length === 1 ? groundFactionIds[0] : null;

    const updatedPlanets = system.planets.map(body => {
      if (!body.isSolid) return body;
      const armies = armiesByBodyIdAfter.get(body.id) ?? [];
      const factionIds = new Set(armies.map(a => a.factionId));
      const ownerFromLocalPresence = factionIds.size === 1 && armies.length > 0 ? Array.from(factionIds)[0] : body.ownerFactionId;
      const ownerFactionId = soleGroundFaction ? soleGroundFaction : ownerFromLocalPresence;

      const initialOwner = initialBodyOwners.get(body.id) ?? null;
      const ownerChanged = ownerFactionId !== initialOwner;
      const shouldNotify = ownerChanged && armies.length > 0;

      if (shouldNotify) {
        const remainingByFaction = new Map<FactionId, number>();
        armies.forEach(army => {
          remainingByFaction.set(army.factionId, (remainingByFaction.get(army.factionId) ?? 0) + army.members);
        });
        const involvedFactionIds = new Set<FactionId>();
        remainingByFaction.forEach((_, factionId) => involvedFactionIds.add(factionId));
        [initialOwner, ownerFactionId].forEach(fid => {
          if (fid) involvedFactionIds.add(fid);
        });

        const formatRemainingLine = (): string => {
          if (remainingByFaction.size === 0) return 'Remaining forces - none';
          const parts = sorted(Array.from(remainingByFaction.entries()), ([a], [b]) => a.localeCompare(b)).map(
            ([factionId, totalMembers]) => `${factionId}: ${totalMembers} members`
          );
          return `Remaining forces - ${parts.join(', ')}`;
        };

        const isPlayerInvolved = involvedFactionIds.has(state.playerFactionId);
        const message: GameMessage = {
          id: ctx.rng.id('msg'),
          day: ctx.turn,
          type: 'PLANET_CONQUERED',
          priority: isPlayerInvolved ? 2 : 1,
          title: `${body.name} conquered`,
          subtitle: `${system.name} • Turn ${ctx.turn}`,
          lines: ['Losses - see combat log', formatRemainingLine()],
          payload: {
            planetId: body.id,
            systemId: system.id,
            involvedFactionIds: sorted(Array.from(involvedFactionIds), (a, b) => a.localeCompare(b))
          },
          read: false,
          dismissed: false,
          createdAtTurn: ctx.turn
        };
        nextMessages = canonicalizeMessages([...nextMessages, message]);
      }

      return { ...body, ownerFactionId };
    });

    const solidBodies = updatedPlanets.filter(planet => planet.isSolid);
    const uniformSolidOwner = (() => {
      if (solidBodies.length === 0) return null;
      const [firstBody] = solidBodies;
      if (!firstBody.ownerFactionId) return null;

      const sharedOwner = firstBody.ownerFactionId;
      const hasMismatch = solidBodies.some(body => body.ownerFactionId !== sharedOwner);

      return hasMismatch ? null : sharedOwner;
    })();

    const newOwnerFactionId = soleGroundFaction ?? uniformSolidOwner ?? system.ownerFactionId;
    const ownerChanged = newOwnerFactionId !== system.ownerFactionId;
    const solidBodiesHeldByNewOwner = solidBodies.filter(planet => planet.ownerFactionId === newOwnerFactionId);

    if (ownerChanged && newOwnerFactionId && aiFactionIds.has(newOwnerFactionId)) {
      if (!holdUpdates[newOwnerFactionId]) {
        holdUpdates[newOwnerFactionId] = [];
      }
      holdUpdates[newOwnerFactionId].push(system.id);
    }

    if (ownerChanged && newOwnerFactionId) {
      const sortedBodies = sorted(solidBodies, (a, b) => a.name.localeCompare(b.name));
      const involvedFactionIds = new Set<FactionId>([system.ownerFactionId, newOwnerFactionId].filter((factionId): factionId is FactionId =>
        Boolean(factionId)
      ));

      nextLogs = [
        ...nextLogs,
        {
          id: ctx.rng.id('log'),
          day: ctx.turn,
          text: `System ${system.name} control set to ${newOwnerFactionId} after enemy ground presence was cleared. Solid worlds now held: ${
            sortedBodies.filter(body => body.ownerFactionId === newOwnerFactionId).map(body => body.name).join(', ') || 'none'
          }.`,
          type: 'combat'
        }
      ];

      const isPlayerInvolved = newOwnerFactionId === state.playerFactionId || system.ownerFactionId === state.playerFactionId;

      if (isPlayerInvolved) {
        const systemMessage: GameMessage = {
          id: ctx.rng.id('msg'),
          day: ctx.turn,
          type: 'SYSTEM_SECURED',
          priority: newOwnerFactionId === state.playerFactionId ? 2 : 1,
          title: `${system.name} secured`,
          subtitle: `Turn ${ctx.turn}`,
          lines: [
            groundFactionIds.length > 0
              ? `No opposing ground armies remain; ${newOwnerFactionId} holds surface control.`
              : `${newOwnerFactionId} controls the system following ground resolution.`,
            `Solid bodies held: ${solidBodiesHeldByNewOwner.map(body => body.name).join(', ') || 'None'}.`
          ],
          payload: {
            systemId: system.id,
            newOwnerFactionId,
            involvedFactionIds: sorted(Array.from(new Set<FactionId>([...involvedFactionIds, ...groundFactionIds])), (a, b) =>
              a.localeCompare(b)
            )
          },
          read: false,
          dismissed: false,
          createdAtTurn: ctx.turn
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

      const updatedState: AIState = {
        ...existingState,
        holdUntilTurnBySystemId: {
          ...existingState.holdUntilTurnBySystemId,
          ...systemIds.reduce<Record<string, number>>((acc, systemId) => {
            acc[systemId] = ctx.turn + AI_HOLD_TURNS;
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
    armies: nextArmies,
    logs: nextLogs,
    messages: nextMessages,
    aiStates: nextAiStates
  };
}

export function phaseObjectives(state: GameState, ctx: TurnContext): GameState {
  if (state.winnerFactionId) return state; // Already decided

  const winnerFactionId = checkVictoryConditions({ ...state, day: ctx.turn });

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

export function phaseCleanup(state: GameState, ctx: TurnContext): GameState {
  // 1. Prune Old Battles
  const activeBattles = pruneBattles(state.battles, ctx.turn);
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
      day: ctx.turn,
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
