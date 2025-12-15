
import { GameState, Fleet, StarSystem, LaserShot, Battle, AIState, EnemySighting, Army, GameObjectives, ShipType, GameplayRules, FactionState, FactionId } from '../types';
import { Vec3, vec3 } from './math/vec3';
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

// --- HELPERS ---

const serializeVector3 = (v: Vec3): Vector3DTO => ({ x: v.x, y: v.y, z: v.z });
const deserializeVector3 = (v: Vector3DTO): Vec3 => vec3(v.x, v.y, v.z);

const serializeAiState = (aiState?: AIState): AIStateDTO | undefined => {
  if (!aiState) return undefined;

  const sightings: Record<string, EnemySightingDTO> = {};
  Object.entries(aiState.sightings).forEach(([key, s]) => {
    sightings[key] = {
      ...s,
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

const deserializeAiState = (aiStateDto?: AIStateDTO): AIState | undefined => {
  if (!aiStateDto) return undefined;

  const sightings: Record<string, EnemySighting> = {};
  Object.entries(aiStateDto.sightings || {}).forEach(([key, s]: [string, any]) => {
    sightings[key] = {
      ...s,
      position: deserializeVector3(s.position)
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
  const aiStateDto = serializeAiState(state.aiState);
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
      ownerFactionId: s.ownerFactionId,
      position: serializeVector3(s.position)
    })),
    fleets: state.fleets.map(f => ({
      ...f,
      factionId: f.factionId,
      position: serializeVector3(f.position),
      targetPosition: f.targetPosition ? serializeVector3(f.targetPosition) : null,
      ships: f.ships.map(s => ({
          id: s.id,
          type: s.type,
          hp: s.hp,
          maxHp: s.maxHp,
          carriedArmyId: s.carriedArmyId || null
      }))
    })),
    armies: state.armies.map(a => ({
      id: a.id,
      factionId: a.factionId,
      strength: a.strength,
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
  const playerFactionId: string = dto.playerFactionId || 'blue'; // Default to Blue for legacy saves

  try {
    // Systems
    const systems: StarSystem[] = dto.systems.map((s: any) => ({
      id: s.id,
      name: s.name,
      position: deserializeVector3(s.position),
      color: s.color,
      size: s.size,
      resourceType: s.resourceType,
      // Map Legacy 'owner' (enum) to 'ownerFactionId' (string)
      ownerFactionId: s.ownerFactionId !== undefined ? s.ownerFactionId : (s.owner || null) 
    }));

    // Fleets
    const fleets: Fleet[] = dto.fleets.map((f: any) => ({
      id: f.id,
      // Map Legacy 'faction' to 'factionId'
      factionId: f.factionId || f.faction, 
      position: deserializeVector3(f.position),
      state: f.state,
      targetSystemId: f.targetSystemId,
      targetPosition: f.targetPosition ? deserializeVector3(f.targetPosition) : null,
      radius: f.radius,
      stateStartTurn: f.stateStartTurn ?? 0,
      retreating: f.retreating,
      invasionTargetSystemId: f.invasionTargetSystemId,
      ships: f.ships.map((s: any) => ({
          id: s.id,
          type: s.type,
          hp: s.hp,
          maxHp: s.maxHp,
          carriedArmyId: s.carriedArmyId ?? null
      }))
    }));

    // Armies
    const armies: Army[] = (dto.armies || []).map((a: any) => ({
      id: a.id,
      factionId: a.factionId || a.faction, // Migration
      strength: a.strength,
      state: a.state,
      containerId: a.containerId
    }));

    const lasers: LaserShot[] = (dto.lasers || []).map((l: any) => ({
      id: l.id,
      color: l.color,
      life: l.life,
      start: deserializeVector3(l.start),
      end: deserializeVector3(l.end)
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
          const parsed = deserializeAiState(aiStateDto);
          if (parsed) {
            acc[factionId] = parsed;
          }
          return acc;
        }, {})
      : undefined;

    const legacyAiState = deserializeAiState(dto.aiState);
    const DEFAULT_AI_FACTION_ID: FactionId = 'red';

    const migratedAiStates = aiStates && Object.keys(aiStates).length > 0
      ? aiStates
      : legacyAiState
        ? { [DEFAULT_AI_FACTION_ID]: legacyAiState }
        : undefined;

    const primaryAiState = migratedAiStates?.[DEFAULT_AI_FACTION_ID] || legacyAiState;

    const state: GameState = {
      scenarioId: dto.scenarioId || 'unknown',
      scenarioTitle: dto.scenarioTitle,
      playerFactionId,
      factions,
      seed: dto.seed,
      rngState: dto.rngState ?? dto.seed,
      startYear: dto.startYear,
      day: dto.day,
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
