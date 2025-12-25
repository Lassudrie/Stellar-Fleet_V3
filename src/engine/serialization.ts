
import {
  GameState,
  Fleet,
  StarSystem,
  LaserShot,
  Battle,
  AIState,
  EnemySighting,
  Army,
  ArmyState,
  ShipType,
  FleetState,
  BattleStatus,
  GameplayRules,
  FactionState,
  FactionId,
  ShipEntity,
  ShipConsumables,
  ShipKillRecord,
  LogEntry,
  StarSystemAstro,
  GameMessage
} from '../shared/types';
import { Vec3, vec3 } from './math/vec3';
import { getAiFactionIds, getLegacyAiFactionId } from './ai';
import { withUpdatedFleetDerived } from './fleetDerived';
import {
  SAVE_VERSION,
  SaveFile,
  GameStateDTO,
  Vector3DTO,
  GameMessageDTO
} from './saveFormat';
import { COLORS, SHIP_STATS } from '../content/data/static';
import { generateStellarSystem } from './worldgen/stellar';
import { normalizePlanetBodies } from './planets';
import { quantizeFuel } from './logistics/fuel';

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

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const MAX_LOG_ENTRIES = 5000;
const MAX_MESSAGE_ENTRIES = 1000;
const MAX_ARMY_ENTRIES = 10000;
const MAX_BATTLE_ENTRIES = 2000;
const MAX_LOG_TEXT_LENGTH = 600;
const MAX_BATTLE_LOGS = 200;
const MAX_MESSAGE_LINE_LENGTH = 200;
const MAX_MESSAGE_LINES = 20;
const MAX_MESSAGE_TITLE_LENGTH = 200;
const MAX_MESSAGE_SUBTITLE_LENGTH = 200;
const MAX_MESSAGE_TYPE_LENGTH = 64;

const getFuelCapacity = (type: ShipType): number => SHIP_STATS[type]?.fuelCapacity ?? 0;

const ARMY_STATES = new Set(Object.values(ArmyState));
const FLEET_STATES = new Set(Object.values(FleetState));
const SHIP_TYPES = new Set(Object.values(ShipType));
const BATTLE_STATUSES = new Set<BattleStatus>(['scheduled', 'resolved']);

const isEnumValue = <T>(set: Set<T>, value: unknown): value is T => set.has(value as T);

const clampText = (value: unknown, maxLength: number, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const clampArray = <T>(items: T[], max: number, label: string, sliceFromEnd = false): T[] => {
  if (items.length <= max) return items;
  console.warn(`[Serialization] ${label} truncated from ${items.length} to ${max}.`);
  return sliceFromEnd ? items.slice(-max) : items.slice(0, max);
};

const sanitizeStarSystemAstro = (astro: unknown): StarSystemAstro | undefined => {
  if (!astro || typeof astro !== 'object') return undefined;
  const a: any = astro;

  if (!isFiniteNumber(a.seed)) return undefined;
  if (typeof a.primarySpectralType !== 'string') return undefined;
  if (!isFiniteNumber(a.starCount)) return undefined;
  if (!isFiniteNumber(a.metallicityFeH)) return undefined;
  if (!a.derived || typeof a.derived !== 'object') return undefined;
  if (!isFiniteNumber(a.derived.luminosityTotalLSun)) return undefined;
  if (!isFiniteNumber(a.derived.snowLineAu)) return undefined;
  if (!isFiniteNumber(a.derived.hzInnerAu)) return undefined;
  if (!isFiniteNumber(a.derived.hzOuterAu)) return undefined;
  if (!Array.isArray(a.stars)) return undefined;
  if (!Array.isArray(a.planets)) return undefined;

  return a as StarSystemAstro;
};

const restoreAstro = (
  astro: unknown,
  worldSeed: number | undefined,
  systemId: string | undefined
): StarSystemAstro | undefined => {
  const sanitized = sanitizeStarSystemAstro(astro);
  if (sanitized) return sanitized;
  if (isFiniteNumber(worldSeed) && typeof systemId === 'string' && systemId.length > 0) {
    if (astro) {
      console.warn(`[Serialization] Astro data for system '${systemId}' was invalid; regenerating from seed.`);
    }
    return generateStellarSystem({ worldSeed, systemId });
  }
  if (astro) {
    console.warn(`[Serialization] Cannot restore astro for system '${systemId}': invalid data and no seed available.`);
  }
  return undefined;
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

const sanitizeMessagePayload = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== 'object') return {};
  return payload as Record<string, unknown>;
};

const sanitizeMessageLines = (lines: unknown): string[] => {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, MAX_MESSAGE_LINES)
    .map(line => {
      const normalized = typeof line === 'string' ? line : String(line);
      return clampText(normalized, MAX_MESSAGE_LINE_LENGTH, '');
    });
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

const sanitizeLogEntry = (entry: any, index: number): LogEntry | null => {
  const id = typeof entry?.id === 'string' ? entry.id : `log-${index}`;
  const day = isFiniteNumber(entry?.day) ? entry.day : 0;
  const text = clampText(entry?.text, MAX_LOG_TEXT_LENGTH, '');
  const type = entry?.type;
  const normalizedType = type === 'info' || type === 'combat' || type === 'move' || type === 'ai'
    ? type
    : 'info';

  if (!text) return null;

  return { id, day, text, type: normalizedType };
};

const sanitizeNumberRecord = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return Object.entries(record).reduce<Record<string, number>>((acc, [key, entry]) => {
    if (isFiniteNumber(entry)) {
      acc[key] = entry;
    }
    return acc;
  }, {});
};

const sanitizeOwnerRecord = (
  value: unknown,
  validFactionIds?: Set<FactionId>
): Record<string, FactionId | null> => {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return Object.entries(record).reduce<Record<string, FactionId | null>>((acc, [key, entry]) => {
    if (entry === null) {
      acc[key] = null;
      return acc;
    }
    if (typeof entry === 'string' && (!validFactionIds || validFactionIds.has(entry))) {
      acc[key] = entry;
    }
    return acc;
  }, {});
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

    if (!isFiniteNumber(s.daySeen) || !isFiniteNumber(s.estimatedPower) || !isFiniteNumber(s.confidence)) {
      return;
    }

    const systemId = typeof s.systemId === 'string' ? s.systemId : null;
    const confidence = Math.max(0, Math.min(1, s.confidence));
    const daySeen = s.daySeen;
    const lastUpdateDay = isFiniteNumber(s.lastUpdateDay) ? s.lastUpdateDay : daySeen;

    sightings[key] = {
      ...s,
      factionId,
      fleetId: typeof s.fleetId === 'string' ? s.fleetId : key,
      systemId,
      daySeen,
      estimatedPower: s.estimatedPower,
      confidence,
      lastUpdateDay,
      position: deserializeVector3(s.position, `AI sighting '${key}' position`)
    };
  });

  const sanitizedHold = sanitizeNumberRecord(aiStateDto.holdUntilTurnBySystemId);
  Object.keys(sanitizedHold).forEach(key => {
    if (sanitizedHold[key] < 0) {
      delete sanitizedHold[key];
    }
  });

  return {
    sightings,
    targetPriorities: sanitizeNumberRecord(aiStateDto.targetPriorities),
    systemLastSeen: sanitizeNumberRecord(aiStateDto.systemLastSeen),
    lastOwnerBySystemId: sanitizeOwnerRecord(aiStateDto.lastOwnerBySystemId, validFactionIds),
    holdUntilTurnBySystemId: sanitizedHold
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
      position: serializeVector3(s.position),
      planets: s.planets
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
          fuel: s.fuel,
          carriedArmyId: s.carriedArmyId || null,
          transferBusyUntilDay: Number.isFinite(s.transferBusyUntilDay) ? s.transferBusyUntilDay : undefined,
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
    messages: state.messages.map((message): GameMessageDTO => ({
      ...message,
      payload: sanitizeMessagePayload(message.payload),
      lines: sanitizeMessageLines(message.lines)
    })),
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

  if (raw && typeof raw === 'object' && raw.version !== undefined) {
    if (!isFiniteNumber(raw.version)) {
      throw new Error('Save file version must be a number.');
    }
    if (raw.version > SAVE_VERSION) {
      throw new Error(`Save file version ${raw.version} is newer than supported version ${SAVE_VERSION}.`);
    }
    if (!raw.state) {
      throw new Error('Save file is missing the state payload.');
    }
    if (raw.version < 2) {
      console.warn(`[Serialization] Save version ${raw.version} is legacy; attempting best-effort migration.`);
    }
  }

  let dto: any = raw.state || raw; // Handle wrapped or raw DTO
  if (!dto || typeof dto !== 'object') {
    throw new Error('Save file is missing a valid state payload.');
  }

  // MIGRATION V1 -> V2 logic
  // If factions or playerFactionId are missing, inject defaults
  if (dto.factions !== undefined && !Array.isArray(dto.factions)) {
    throw new Error("Field 'factions' must be an array.");
  }
  const factions: FactionState[] = Array.isArray(dto.factions) ? dto.factions : DEFAULT_FACTIONS;
  const validFactionIds = new Set(factions.map(f => f.id));
  const rawPlayerFactionId: string = dto.playerFactionId || 'blue'; // Default to Blue for legacy saves
  const worldSeed: number | undefined = Number.isFinite(dto.seed) ? dto.seed : undefined;

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
      if (typeof s.id !== 'string' || typeof s.name !== 'string') {
        throw new Error('System entry is missing a valid id or name.');
      }
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

      const astro = restoreAstro(s.astro, worldSeed, s.id);
      const planets = normalizePlanetBodies(
        { id: s.id, name: s.name, ownerFactionId },
        s.planets,
        astro
      );

      return {
        id: s.id,
        name: s.name,
        position: deserializeVector3(s.position, `system '${s.id ?? 'unknown'}' position`),
        color,
        size: s.size,
        resourceType: s.resourceType,
        isHomeworld: s.isHomeworld ?? false,
        astro,
        planets,
        // Map Legacy 'owner' (enum) to 'ownerFactionId' (string)
        ownerFactionId
      };
    });

    // Fleets
    const fleetsDto = Array.isArray(dto.fleets) ? dto.fleets : [];
    if (dto.fleets !== undefined && !Array.isArray(dto.fleets)) {
      throw new Error("Field 'fleets' must be an array.");
    }
    if (dto.armies !== undefined && !Array.isArray(dto.armies)) {
      throw new Error("Field 'armies' must be an array.");
    }
    if (dto.lasers !== undefined && !Array.isArray(dto.lasers)) {
      throw new Error("Field 'lasers' must be an array.");
    }
    if (dto.battles !== undefined && !Array.isArray(dto.battles)) {
      throw new Error("Field 'battles' must be an array.");
    }
    if (dto.logs !== undefined && !Array.isArray(dto.logs)) {
      throw new Error("Field 'logs' must be an array.");
    }
    if (dto.messages !== undefined && !Array.isArray(dto.messages)) {
      throw new Error("Field 'messages' must be an array.");
    }

    const fleets: Fleet[] = fleetsDto.map((f: any, index: number) => {
      if (typeof f?.id !== 'string') {
        throw new Error(`Fleet entry at index ${index} is missing a valid id.`);
      }

      const factionId = typeof f.factionId === 'string' ? f.factionId : f.faction;
      if (typeof factionId !== 'string') {
        throw new Error(`Fleet '${f.id}' is missing a valid faction id.`);
      }
      if (validFactionIds && !validFactionIds.has(factionId)) {
        throw new Error(`Fleet '${f.id}' references unknown faction '${factionId}'.`);
      }

      const ships: unknown[] = Array.isArray(f.ships) ? f.ships : [];
      const sanitizedShips = ships
        .map((entry: unknown, index: number): ShipEntity | null => {
          const ship = entry as any;
          if (typeof ship?.id !== 'string') {
            console.warn(`[Serialization] Ship at index ${index} in fleet '${f.id}' has invalid id; skipping.`);
            return null;
          }
          if (!isEnumValue(SHIP_TYPES, ship.type)) {
            console.warn(`[Serialization] Ship '${ship.id}' has invalid type '${ship.type}'; skipping.`);
            return null;
          }

          const shipType = ship.type as ShipType;
          const fallbackMaxHp = SHIP_STATS[shipType]?.maxHp ?? 100;
          const maxHp = Number.isFinite(ship.maxHp) ? ship.maxHp : fallbackMaxHp;
          const hp = Number.isFinite(ship.hp) ? Math.min(Math.max(ship.hp, 0), maxHp) : maxHp;
          const capacity = getFuelCapacity(shipType);
          const fallbackFuel = Number.isFinite(capacity) ? capacity : 0;
          const rawFuel = Number.isFinite(ship.fuel) ? ship.fuel : fallbackFuel;
          const upperBound = capacity > 0 ? capacity : Math.max(rawFuel, 0);
          const clampedFuel = Math.min(Math.max(rawFuel, 0), upperBound);
          const fuel = quantizeFuel(clampedFuel);

          const consumables = extractConsumables(ship, shipType);
          const killHistory = sanitizeKillHistory(ship.killHistory);

          return {
            id: ship.id,
            type: shipType,
            hp,
            maxHp,
            fuel,
            carriedArmyId: typeof ship.carriedArmyId === 'string' ? ship.carriedArmyId : null,
            transferBusyUntilDay: Number.isFinite(ship.transferBusyUntilDay) ? ship.transferBusyUntilDay : undefined,
            consumables,
            offensiveMissilesLeft: ship.offensiveMissilesLeft ?? consumables.offensiveMissiles,
            torpedoesLeft: ship.torpedoesLeft ?? consumables.torpedoes,
            interceptorsLeft: ship.interceptorsLeft ?? consumables.interceptors,
            killHistory
          };
        })
        .filter((ship): ship is ShipEntity => Boolean(ship));

      const fleetState = isEnumValue(FLEET_STATES, f.state) ? f.state : FleetState.ORBIT;
      const targetSystemId = typeof f.targetSystemId === 'string' ? f.targetSystemId : null;
      const targetPosition = f.targetPosition
        ? deserializeVector3(f.targetPosition, `fleet '${f.id ?? 'unknown'}' targetPosition`)
        : null;

      const baseFleet: Fleet = {
        id: f.id,
        factionId,
        position: deserializeVector3(f.position, `fleet '${f.id ?? 'unknown'}' position`),
        state: fleetState,
        targetSystemId,
        targetPosition,
        radius: 1,
        stateStartTurn: Number.isFinite(f.stateStartTurn) ? f.stateStartTurn : 0,
        retreating: f.retreating ?? false,
        invasionTargetSystemId: f.invasionTargetSystemId ?? null,
        loadTargetSystemId: f.loadTargetSystemId ?? null,
        unloadTargetSystemId: f.unloadTargetSystemId ?? null,
        ships: sanitizedShips
      };

      return withUpdatedFleetDerived(baseFleet);
    });

    const fleetIds = new Set(fleets.map(fleet => fleet.id));
    const planetIds = new Set(systems.flatMap(system => system.planets.map(planet => planet.id)));

    // Armies
    const armiesDto = Array.isArray(dto.armies) ? dto.armies : [];
    const clampedArmiesDto = clampArray(armiesDto, MAX_ARMY_ENTRIES, 'armies');
    const armies: Army[] = clampedArmiesDto
      .map((a: any, index: number) => {
        if (typeof a?.id !== 'string') {
          console.warn(`[Serialization] Army entry at index ${index} missing id; skipping.`);
          return null;
        }
        const factionId = typeof a.factionId === 'string' ? a.factionId : a.faction;
        if (typeof factionId !== 'string') return null;
        if (validFactionIds && !validFactionIds.has(factionId)) return null;
        if (!isEnumValue(ARMY_STATES, a.state)) return null;
        if (typeof a.containerId !== 'string') return null;

        const maxStrength = isFiniteNumber(a.maxStrength) ? a.maxStrength : (isFiniteNumber(a.strength) ? a.strength : null);
        if (maxStrength === null || maxStrength < 0) return null;
        const strength = isFiniteNumber(a.strength) ? a.strength : maxStrength;
        const clampedStrength = Math.min(Math.max(strength, 0), maxStrength);
        const morale = isFiniteNumber(a.morale) ? Math.max(0, Math.min(1, a.morale)) : 1;

        if (a.state === ArmyState.DEPLOYED && !planetIds.has(a.containerId)) return null;
        if (a.state !== ArmyState.DEPLOYED && !fleetIds.has(a.containerId)) return null;

        return {
          id: a.id,
          factionId,
          strength: clampedStrength,
          maxStrength,
          morale,
          state: a.state,
          containerId: a.containerId
        };
      })
      .filter((army): army is Army => Boolean(army));

    const lasersDto = Array.isArray(dto.lasers) ? dto.lasers : [];
    const lasers: LaserShot[] = lasersDto.map((l: any, index: number) => {
      if (typeof l?.id !== 'string') {
        throw new Error(`Laser entry at index ${index} is missing a valid id.`);
      }
      if (!isFiniteNumber(l.life)) {
        throw new Error(`Laser '${l.id}' has invalid life value.`);
      }
      return {
        id: l.id,
        color: typeof l.color === 'string' ? l.color : '#ffffff',
        life: l.life,
        start: deserializeVector3(l.start, `laser '${l.id ?? 'unknown'}' start`),
        end: deserializeVector3(l.end, `laser '${l.id ?? 'unknown'}' end`)
      };
    });

    // Battles
    const battlesDto = Array.isArray(dto.battles) ? dto.battles : [];
    const clampedBattlesDto = clampArray(battlesDto, MAX_BATTLE_ENTRIES, 'battles');
    const battles: Battle[] = [];

    clampedBattlesDto.forEach((b: any, index: number) => {
      if (typeof b?.id !== 'string') {
        console.warn(`[Serialization] Battle entry at index ${index} missing id; skipping.`);
        return;
      }
      if (typeof b.systemId !== 'string') return;
      if (!isEnumValue(BATTLE_STATUSES, b.status)) return;

      const involvedFleetIds = Array.isArray(b.involvedFleetIds)
        ? b.involvedFleetIds.filter((id: unknown) => typeof id === 'string' && fleetIds.has(id))
        : [];
      if (involvedFleetIds.length === 0) return;

      const rawLogs: unknown[] = Array.isArray(b.logs) ? b.logs : [];
      const logs: string[] = rawLogs
        .map((entry: unknown) => clampText(entry, MAX_LOG_TEXT_LENGTH, ''))
        .filter((entry): entry is string => Boolean(entry));
      const clampedLogs = clampArray(logs, MAX_BATTLE_LOGS, `battle logs for ${b.id}`, true);

      const turnCreated = isFiniteNumber(b.turnCreated) ? b.turnCreated : 0;
      const rawTurnResolved = isFiniteNumber(b.turnResolved) ? b.turnResolved : undefined;
      const turnResolved = b.status === 'resolved' ? (rawTurnResolved ?? turnCreated) : rawTurnResolved;

      const winnerRaw = b.winnerFactionId !== undefined ? b.winnerFactionId : b.winner;
      const winnerFactionId =
        winnerRaw === 'draw'
          ? 'draw'
          : typeof winnerRaw === 'string' && (!validFactionIds || validFactionIds.has(winnerRaw))
            ? winnerRaw
            : undefined;

      const rawInitialShips: unknown[] = Array.isArray(b.initialShips) ? b.initialShips : [];
      const initialShips = rawInitialShips
        .map((entry: unknown, index: number) => {
          const snapshot = entry as any;
          if (typeof snapshot?.shipId !== 'string' || typeof snapshot?.fleetId !== 'string') {
            console.warn(`[Serialization] Battle '${b.id}' initialShips[${index}] has invalid shipId or fleetId; skipping.`);
            return null;
          }
          const factionId = typeof snapshot.factionId === 'string' ? snapshot.factionId : snapshot.faction;
          if (typeof factionId !== 'string') {
            console.warn(`[Serialization] Battle '${b.id}' ship '${snapshot.shipId}' has invalid factionId; skipping.`);
            return null;
          }
          if (validFactionIds && !validFactionIds.has(factionId)) {
            console.warn(`[Serialization] Battle '${b.id}' ship '${snapshot.shipId}' references unknown faction '${factionId}'; skipping.`);
            return null;
          }
          if (!isEnumValue(SHIP_TYPES, snapshot.type)) {
            console.warn(`[Serialization] Battle '${b.id}' ship '${snapshot.shipId}' has invalid type '${snapshot.type}'; skipping.`);
            return null;
          }
          if (!isFiniteNumber(snapshot.maxHp) || !isFiniteNumber(snapshot.startingHp)) {
            console.warn(`[Serialization] Battle '${b.id}' ship '${snapshot.shipId}' has invalid HP values; skipping.`);
            return null;
          }
          return {
            shipId: snapshot.shipId,
            fleetId: snapshot.fleetId,
            factionId,
            type: snapshot.type,
            maxHp: snapshot.maxHp,
            startingHp: snapshot.startingHp
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      const normalizedInitialShips = initialShips.length > 0 ? initialShips : undefined;

      const survivorShipIds = Array.isArray(b.survivorShipIds)
        ? b.survivorShipIds.filter((id: unknown) => typeof id === 'string')
        : undefined;

      const shipsLostRaw = sanitizeNumberRecord(b.shipsLost);
      const shipsLost = Object.keys(shipsLostRaw).length > 0 ? shipsLostRaw : undefined;

      const battle: Battle = {
        id: b.id,
        systemId: b.systemId,
        turnCreated,
        turnResolved,
        status: b.status as BattleStatus,
        involvedFleetIds,
        logs: clampedLogs,
        initialShips: normalizedInitialShips,
        survivorShipIds,
        winnerFactionId,
        roundsPlayed: isFiniteNumber(b.roundsPlayed) ? b.roundsPlayed : undefined,
        shipsLost,
        missilesIntercepted: isFiniteNumber(b.missilesIntercepted) ? b.missilesIntercepted : undefined,
        projectilesDestroyedByPd: isFiniteNumber(b.projectilesDestroyedByPd) ? b.projectilesDestroyedByPd : undefined
      };

      battles.push(battle);
    });

    const logsDto: unknown[] = Array.isArray(dto.logs) ? dto.logs : [];
    const normalizedLogs = logsDto
      .map((entry: unknown, index: number) => sanitizeLogEntry(entry, index))
      .filter((entry): entry is LogEntry => Boolean(entry));
    const sanitizedLogs = clampArray<LogEntry>(normalizedLogs, MAX_LOG_ENTRIES, 'logs', true);

    const messagesDto = Array.isArray(dto.messages) ? dto.messages : [];
    const clampedMessagesDto = clampArray(messagesDto, MAX_MESSAGE_ENTRIES, 'messages', true);
    const messages: GameMessage[] = clampedMessagesDto.map((m: any, index: number) => ({
      id: typeof m.id === 'string' ? m.id : `message-${index}`,
      day: isFiniteNumber(m.day) ? m.day : 0,
      type: clampText(m.type, MAX_MESSAGE_TYPE_LENGTH, 'generic'),
      priority: isFiniteNumber(m.priority) ? m.priority : 0,
      title: clampText(m.title, MAX_MESSAGE_TITLE_LENGTH, 'Untitled message'),
      subtitle: clampText(m.subtitle, MAX_MESSAGE_SUBTITLE_LENGTH, ''),
      lines: sanitizeMessageLines(m.lines),
      payload: sanitizeMessagePayload(m.payload),
      read: Boolean(m.read),
      dismissed: Boolean(m.dismissed),
      createdAtTurn: isFiniteNumber(m.createdAtTurn) ? m.createdAtTurn : 0
    }));

    if (dto.aiStates !== undefined && (!dto.aiStates || typeof dto.aiStates !== 'object' || Array.isArray(dto.aiStates))) {
      throw new Error("Field 'aiStates' must be an object.");
    }
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

    const defaultRules: GameplayRules = {
      fogOfWar: true,
      aiEnabled: true,
      useAdvancedCombat: true,
      totalWar: true,
      unlimitedFuel: false
    };

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
      logs: sanitizedLogs,
      messages,
      selectedFleetId: dto.selectedFleetId ?? null,
      winnerFactionId: dto.winnerFactionId !== undefined ? dto.winnerFactionId : (dto.winner || null),
      aiStates: migratedAiStates,
      aiState: primaryAiState,
      objectives: dto.objectives || { conditions: [], maxTurns: undefined },
      rules: { ...defaultRules, ...(dto.rules ?? {}) }
    };

    return state;
  } catch (e) {
    throw new Error(`Error reconstructing game state: ${(e as Error).message}`);
  }
};
