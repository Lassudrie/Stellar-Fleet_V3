
import { GameState, Fleet, StarSystem, LaserShot, Battle, AIState, EnemySighting, Army, GameObjectives, ShipType, GameplayRules, FactionState, FactionId, ShipConsumables, ShipKillRecord } from '../types';
import { Vec3, vec3 } from './math/vec3';
import { getAiFactionIds, getLegacyAiFactionId } from './ai';
import { computeFleetRadius } from './fleetDerived';
import {
  SAVE_VERSION,
  SaveFile,
  GameStateDTO,
  Vector3DTO,
  StarSystemDTO,
  FleetDTO,
  LaserShotDTO,
  BattleDTO,
  AIStateDTO,
  EnemySightingDTO,
  ArmyDTO
} from './saveFormat';
import { COLORS, SHIP_STATS } from '../data/static';

// --- HELPERS ---

const serializeVector3 = (v: Vec3): Vector3DTO => ({ x: v.x, y: v.y, z: v.z });
const deserializeVector3 = (v: Vector3DTO | undefined, context = 'vector'): Vec3 => {
  if (!v || typeof v !== 'object') {
    throw new Error(`Invalid ${context}: expected an object with numeric x, y, z components.`);
  }

  const components: Array<keyof Vector3DTO> = ['x', 'y', 'z'];
  components.forEach(component => {
    const value = (v as any)[component];
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid ${context}: '${component}' must be a finite number (received ${value}).`);
    }
  });

  return vec3(v.x, v.y, v.z);
};

const normalizeConsumableValue = (value: unknown, fallback: number) => (
  Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback
);

const extractConsumables = (ship: any, type: ShipType): ShipConsumables => {
  const stats = SHIP_STATS[type];

  return {
    offensiveMissiles: normalizeConsumableValue(
      ship?.consumables?.offensiveMissiles ?? ship?.offensiveMissilesLeft,
      stats?.offensiveMissileStock ?? 0
    ),
    torpedoes: normalizeConsumableValue(
      ship?.consumables?.torpedoes ?? ship?.torpedoesLeft,
      stats?.torpedoStock ?? 0
    ),
    interceptors: normalizeConsumableValue(
      ship?.consumables?.interceptors ?? ship?.interceptorsLeft,
      stats?.interceptorStock ?? 0
    )
  };
};

const sanitizeKillHistory = (entries: any[] | undefined): ShipKillRecord[] => {
  if (!Array.isArray(entries)) return [];

  return entries
    .map((entry, index) => ({
      id: typeof entry?.id === 'string' ? entry.id : `kill-${index}`,
      day: Number.isFinite(entry?.day) ? entry.day : 0,
      turn: Number.isFinite(entry?.turn) ? entry.turn : (Number.isFinite(entry?.day) ? entry.day : 0),
      targetId: typeof entry?.targetId === 'string' ? entry.targetId : 'unknown',
      targetType: entry?.targetType ?? ShipType.FRIGATE,
      targetFactionId: entry?.targetFactionId ?? 'unknown'
    }))
    .filter((entry): entry is ShipKillRecord => Boolean(entry.targetId));
};

const serializeAiState = (aiState?: AIState): AIStateDTO | undefined => {
  if (!aiState) return undefined;

  const sightings: Record<string, EnemySightingDTO> = {};
  Object.entries(aiState.sightings).forEach(([key, s]) => {
    sightings[key] = {
      ...s,
      lastUpdateDay: s.lastUpdateDay ?? s.daySeen,
      position: serializeVector3(s.position)
    };
  });

  return {
    sightings,
    targetPriorities: aiState.targetPriorities,
    systemLastSeen: aiState.systemLastSeen,
    lastOwnerBySystemId: aiState.lastOwnerBySystemId,
    holdUntilTurnBySystemId: aiState.holdUntilTurnBySystemId
  };
};

const deserializeAiState = (
  aiStateDto?: AIStateDTO,
  validFactionIds?: Set<FactionId>
): AIState | undefined => {
  if (!aiStateDto) return undefined;

  const sightings: Record<string, EnemySighting> = {};
  Object.entries(aiStateDto.sightings || {}).forEach(([key, s]: [string, any]) => {
    const factionId: FactionId | undefined = s.factionId;

    if (!factionId) {
      return; // Drop malformed sightings lacking faction attribution
    }

    if (validFactionIds && !validFactionIds.has(factionId)) {
      throw new Error(`AI sighting references unknown faction '${factionId}'.`);
    }

    sightings[key] = {
      ...s,
      factionId,
      lastUpdateDay: s.lastUpdateDay ?? s.daySeen,
      position: deserializeVector3(s.position, `AI sighting '${key}' position`)
    };
  });

  return {
    sightings,
    targetPriorities: aiStateDto.targetPriorities,
    systemLastSeen: aiStateDto.systemLastSeen || {},
    lastOwnerBySystemId: aiStateDto.lastOwnerBySystemId || {},
    holdUntilTurnBySystemId: aiStateDto.holdUntilTurnBySystemId || {}
  };
};

// --- VALIDATORS & MIGRATION ---

// Helper to provide default factions if missing (Backward Compat)
const DEFAULT_FACTIONS: FactionState[] = [
    { id: 'blue', name: 'United Earth Fleet', color: '#3b82f6', isPlayable: true },
    { id: 'red', name: 'Martian Syndicate', color: '#ef4444', isPlayable: false, aiProfile: 'aggressive' }
];

export const serializeGameState = (state: GameState): string => {
  const factionColorById = new Map(state.factions.map(faction => [faction.id, faction.color]));

  const legacyAiFactionId = getLegacyAiFactionId(state.factions);
  const legacyAiState = legacyAiFactionId
    ? state.aiStates?.[legacyAiFactionId] ?? state.aiState
    : state.aiState;
  const aiStateDto = serializeAiState(legacyAiState);
  let aiStatesDto: Record<string, AIStateDTO> | undefined;
  if (state.aiStates) {
    aiStatesDto = {};
    Object.entries(state.aiStates).forEach(([factionId, aiState]) => {
      const serialized = serializeAiState(aiState);
      if (serialized) {
        aiStatesDto![factionId] = serialized;
      }
    });
    if (Object.keys(aiStatesDto).length === 0) {
      aiStatesDto = undefined;
    }
  }

  const stateDto: GameStateDTO = {
    scenarioId: state.scenarioId,
    scenarioTitle: state.scenarioTitle,
    playerFactionId: state.playerFactionId,
    factions: state.factions,
    seed: state.seed,
    rngState: state.rngState,
    startYear: state.startYear,
    day: state.day,
    systems: state.systems.map(s => ({
      ...s,
      color: s.color || factionColorById.get(s.ownerFactionId ?? '') || '#ffffff',
      ownerFactionId: s.ownerFactionId,
      position: serializeVector3(s.position)
    })),
    fleets: state.fleets.map(f => ({
      ...f,
      factionId: f.factionId,
      position: serializeVector3(f.position),
      targetPosition: f.targetPosition ? serializeVector3(f.targetPosition) : null,
      retreating: f.retreating ?? false,
      invasionTargetSystemId: f.invasionTargetSystemId ?? null,
      loadTargetSystemId: f.loadTargetSystemId ?? null,
      unloadTargetSystemId: f.unloadTargetSystemId ?? null,
      ships: f.ships.map(s => ({
          id: s.id,
          type: s.type,
          hp: s.hp,
          maxHp: s.maxHp,
          carriedArmyId: s.carriedArmyId || null,
          consumables: extractConsumables(s, s.type),
          offensiveMissilesLeft: s.offensiveMissilesLeft ?? s.consumables?.offensiveMissiles,
          torpedoesLeft: s.torpedoesLeft ?? s.consumables?.torpedoes,
          interceptorsLeft: s.interceptorsLeft ?? s.consumables?.interceptors,
          killHistory: sanitizeKillHistory(s.killHistory)
      }))
    })),
    armies: state.armies.map(a => ({
      id: a.id,
      factionId: a.factionId,
      strength: a.strength,
      maxStrength: a.maxStrength,
      morale: a.morale,
      state: a.state,
      containerId: a.containerId
    })),
    lasers: state.lasers.map(l => ({
      ...l,
      start: serializeVector3(l.start),
      end: serializeVector3(l.end)
    })),
    battles: state.battles.map(b => ({
      ...b,
      winnerFactionId: b.winnerFactionId,
      initialShips: b.initialShips?.map(s => ({...s, factionId: s.factionId})),
      shipsLost: b.shipsLost 
    })),
    logs: state.logs,
    selectedFleetId: state.selectedFleetId,
    winnerFactionId: state.winnerFactionId,
    aiState: aiStateDto,
    aiStates: aiStatesDto,
    objectives: state.objectives,
    rules: state.rules
  };

  const saveFile: SaveFile = {
    version: SAVE_VERSION,
    createdAt: new Date().toISOString(),
    state: stateDto
  };

  return JSON.stringify(saveFile, null, 2);
};

export const deserializeGameState = (json: string): GameState => {
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error("File is not valid JSON.");
  }

  let dto: any = raw.state || raw; // Handle wrapped or raw DTO

  // MIGRATION V1 -> V2 logic
  // If factions or playerFactionId are missing, inject defaults
  const isLegacy = !dto.playerFactionId || !dto.factions;
  
  const factions: FactionState[] = dto.factions || DEFAULT_FACTIONS;
  const validFactionIds = new Set(factions.map(f => f.id));
  const rawPlayerFactionId: string = dto.playerFactionId || 'blue'; // Default to Blue for legacy saves

  const playerFactionId = validFactionIds.has(rawPlayerFactionId)
    ? rawPlayerFactionId
    : factions[0]?.id;

  if (!playerFactionId) {
    throw new Error("Unable to determine player faction: no factions provided in save file.");
  }

  try {
    // Systems
    const systemsDto = dto.systems === undefined ? [] : dto.systems;
    if (!Array.isArray(systemsDto)) {
      throw new Error("Field 'systems' must be an array.");
    }

    const systems: StarSystem[] = systemsDto.map((s: any) => {
      const ownerFactionId = s.ownerFactionId !== undefined ? s.ownerFactionId : (s.owner || null);
      const ownerColor = ownerFactionId
        ? factions.find(faction => faction.id === ownerFactionId)?.color
        : undefined;
      const color = s.color || ownerColor || COLORS.star;

      if (!s.color) {
        // Preserve serialization contract by normalizing falsy colors
        // while keeping legacy saves functional.
        console.warn(`System '${s.id ?? 'unknown'}' had an invalid color; applying fallback.`);
      }

      return {
        id: s.id,
        name: s.name,
        position: deserializeVector3(s.position, `system '${s.id ?? 'unknown'}' position`),
        color,
        size: s.size,
        resourceType: s.resourceType,
        isHomeworld: s.isHomeworld ?? false,
        // Map Legacy 'owner' (enum) to 'ownerFactionId' (string)
        ownerFactionId
      };
    });

    // Fleets
    const fleetsDto = Array.isArray(dto.fleets) ? dto.fleets : [];
    if (dto.fleets !== undefined && !Array.isArray(dto.fleets)) {
      throw new Error("Field 'fleets' must be an array.");
    }

    const fleets: Fleet[] = fleetsDto.map((f: any) => {
      const ships = f.ships || [];
      const radius = Number.isFinite(f.radius) ? f.radius : computeFleetRadius(ships.length);

      return {
        id: f.id,
        // Map Legacy 'faction' to 'factionId'
        factionId: f.factionId || f.faction,
        position: deserializeVector3(f.position, `fleet '${f.id ?? 'unknown'}' position`),
        state: f.state,
        targetSystemId: f.targetSystemId,
        targetPosition: f.targetPosition
          ? deserializeVector3(f.targetPosition, `fleet '${f.id ?? 'unknown'}' targetPosition`)
          : null,
        radius,
        stateStartTurn: f.stateStartTurn ?? 0,
        retreating: f.retreating ?? false,
        invasionTargetSystemId: f.invasionTargetSystemId ?? null,
        loadTargetSystemId: f.loadTargetSystemId ?? null,
        unloadTargetSystemId: f.unloadTargetSystemId ?? null,
        ships: ships.map((s: any) => {
            const fallbackMaxHp = SHIP_STATS[s.type]?.maxHp ?? 100;
            const maxHp = Number.isFinite(s.maxHp) ? s.maxHp : fallbackMaxHp;
            const hp = Number.isFinite(s.hp) ? Math.min(Math.max(s.hp, 0), maxHp) : maxHp;

            const consumables = extractConsumables(s, s.type);
            const killHistory = sanitizeKillHistory(s.killHistory);

            return {
              id: s.id,
              type: s.type,
              hp,
              maxHp,
              carriedArmyId: s.carriedArmyId ?? null,
              consumables,
              offensiveMissilesLeft: s.offensiveMissilesLeft ?? consumables.offensiveMissiles,
              torpedoesLeft: s.torpedoesLeft ?? consumables.torpedoes,
              interceptorsLeft: s.interceptorsLeft ?? consumables.interceptors,
              killHistory
            };
        })
      };
    });

    // Armies
    const armies: Army[] = (dto.armies || []).map((a: any) => ({
      id: a.id,
      factionId: a.factionId || a.faction, // Migration
      strength: a.strength,
      maxStrength: a.maxStrength ?? a.strength,
      morale: a.morale ?? 1,
      state: a.state,
      containerId: a.containerId
    }));

    const lasers: LaserShot[] = (dto.lasers || []).map((l: any) => ({
      id: l.id,
      color: l.color,
      life: l.life,
      start: deserializeVector3(l.start, `laser '${l.id ?? 'unknown'}' start`),
      end: deserializeVector3(l.end, `laser '${l.id ?? 'unknown'}' end`)
    }));

    // Battles
    const battles: Battle[] = (dto.battles || []).map((b: any) => {
        // Handle migration of shipsLost keys if strictly typed previously, but JSON keys are always strings so it's fine.
        // Rename winner -> winnerFactionId
        const winnerFactionId = b.winnerFactionId !== undefined ? b.winnerFactionId : b.winner;
        
        // Migrate Snapshot factions
        const initialShips = b.initialShips?.map((s: any) => ({
            ...s,
            factionId: s.factionId || s.faction
        }));

        return {
            ...b,
            winnerFactionId,
            initialShips,
            survivorShipIds: b.survivorShipIds,
            roundsPlayed: b.roundsPlayed,
            shipsLost: b.shipsLost,
            missilesIntercepted: b.missilesIntercepted,
            projectilesDestroyedByPd: b.projectilesDestroyedByPd
        };
    });

    const aiStatesDto = dto.aiStates as Record<string, AIStateDTO> | undefined;
    const aiStates: Record<FactionId, AIState> | undefined = aiStatesDto
      ? Object.entries(aiStatesDto).reduce<Record<FactionId, AIState>>((acc, [factionId, aiStateDto]) => {
          const parsed = deserializeAiState(aiStateDto, validFactionIds);
          if (parsed) {
            acc[factionId] = parsed;
          }
          return acc;
        }, {})
      : undefined;

    const legacyAiState = deserializeAiState(dto.aiState, validFactionIds);
    const aiFactionIds = getAiFactionIds(factions);
    const legacyAiFactionId = getLegacyAiFactionId(factions);

    const migratedAiStates = aiStates && Object.keys(aiStates).length > 0
      ? aiStates
      : legacyAiState && legacyAiFactionId
        ? { [legacyAiFactionId]: legacyAiState }
        : undefined;

    const primaryAiOwnerId = legacyAiFactionId
      ?? aiFactionIds[0]
      ?? (migratedAiStates ? Object.keys(migratedAiStates)[0] : undefined);
    const primaryAiState = primaryAiOwnerId
      ? migratedAiStates?.[primaryAiOwnerId] || legacyAiState
      : legacyAiState;

    const normalizedSeed = Number(dto.seed);
    if (!Number.isFinite(normalizedSeed)) {
      throw new Error("Field 'seed' must be a finite number.");
    }

    const normalizedRngStateSource = dto.rngState ?? dto.seed;
    const normalizedRngState = Number(normalizedRngStateSource);
    if (!Number.isFinite(normalizedRngState)) {
      throw new Error("Field 'rngState' must be a finite number or derive from a valid 'seed'.");
    }

    const startYear = Number.isFinite(dto.startYear) ? dto.startYear : 0;
    const day = Number.isFinite(dto.day) ? dto.day : 0;

    const state: GameState = {
      scenarioId: dto.scenarioId || 'unknown',
      scenarioTitle: dto.scenarioTitle,
      playerFactionId,
      factions,
      seed: normalizedSeed,
      rngState: normalizedRngState,
      startYear,
      day,
      systems,
      fleets,
      armies,
      lasers,
      battles,
      logs: dto.logs || [],
      selectedFleetId: dto.selectedFleetId ?? null,
      winnerFactionId: dto.winnerFactionId !== undefined ? dto.winnerFactionId : (dto.winner || null),
      aiStates: migratedAiStates,
      aiState: primaryAiState,
      objectives: dto.objectives || { conditions: [], maxTurns: undefined },
      rules: dto.rules || { fogOfWar: true, aiEnabled: true, useAdvancedCombat: true, totalWar: true }
    };

    return state;
  } catch (e) {
    throw new Error(`Error reconstructing game state: ${(e as Error).message}`);
  }
};
