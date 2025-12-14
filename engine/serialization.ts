import { GameState, Fleet, StarSystem, LaserShot, Battle, AIState, EnemySighting, Army, GameObjectives, ShipType, GameplayRules, FactionState, FactionId } from '../types';
import { Vec3, vec3 } from './math/vec3';
import { 
  SAVE_VERSION, 
  SaveFileV2,
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
import { sanitizeEngagementState } from './features/engagementRewards/state';

// --- HELPERS ---

const serializeVector3 = (v: Vec3): Vector3DTO => ({ x: v.x, y: v.y, z: v.z });
const deserializeVector3 = (v: Vector3DTO): Vec3 => vec3(v.x, v.y, v.z);

// --- VALIDATORS & MIGRATION ---

// Helper to provide default factions if missing (Backward Compat)
const DEFAULT_FACTIONS: FactionState[] = [
    { id: 'blue', name: 'United Earth Fleet', color: '#3b82f6', isPlayable: true },
    { id: 'red', name: 'Martian Syndicate', color: '#ef4444', isPlayable: false, aiProfile: 'aggressive' }
];

export const serializeGameState = (state: GameState): string => {
  // Serialize AI State
  let aiStateDto: AIStateDTO | undefined;
  if (state.aiState) {
    const sightings: Record<string, EnemySightingDTO> = {};
    Object.entries(state.aiState.sightings).forEach(([key, s]) => {
      sightings[key] = {
        ...s,
        position: serializeVector3(s.position)
      };
    });
    aiStateDto = {
      sightings,
      targetPriorities: state.aiState.targetPriorities,
      systemLastSeen: state.aiState.systemLastSeen,
      lastOwnerBySystemId: state.aiState.lastOwnerBySystemId,
      holdUntilTurnBySystemId: state.aiState.holdUntilTurnBySystemId
    };
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
      maxStrength: a.maxStrength,
      xp: a.xp,
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
    objectives: state.objectives,
    rules: state.rules,
    engagement: state.engagement
  };

  const saveFile: SaveFileV2 = {
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
    const armies: Army[] = (dto.armies || []).map((a: any) => {
      const strengthRaw = typeof a?.strength === 'number' && Number.isFinite(a.strength)
        ? a.strength
        : 0;
      const strength = Math.floor(strengthRaw);

      const maxStrengthRaw = typeof a?.maxStrength === 'number' && Number.isFinite(a.maxStrength)
        ? a.maxStrength
        : strength;
      const maxStrength = Math.max(Math.floor(maxStrengthRaw), strength);

      const xpRaw = typeof a?.xp === 'number' && Number.isFinite(a.xp)
        ? a.xp
        : 0;
      const xp = Math.max(0, Math.floor(xpRaw));

      return {
        id: a.id,
        factionId: a.factionId || a.faction, // Migration
        strength,
        maxStrength,
        xp,
        state: a.state,
        containerId: a.containerId
      };
    });

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

    let aiState: AIState | undefined;
    if (dto.aiState) {
      const sightings: Record<string, EnemySighting> = {};
      Object.entries(dto.aiState.sightings || {}).forEach(([key, s]: [string, any]) => {
        sightings[key] = {
          ...s,
          position: deserializeVector3(s.position)
        };
      });
      aiState = {
        sightings,
        targetPriorities: dto.aiState.targetPriorities,
        systemLastSeen: dto.aiState.systemLastSeen || {},
        lastOwnerBySystemId: dto.aiState.lastOwnerBySystemId || {},
        holdUntilTurnBySystemId: dto.aiState.holdUntilTurnBySystemId || {}
      };
    }

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
      aiState,
      objectives: dto.objectives || { conditions: [], maxTurns: undefined },
      rules: {
        fogOfWar: dto.rules?.fogOfWar ?? true,
        aiEnabled: dto.rules?.aiEnabled ?? true,
        useAdvancedCombat: dto.rules?.useAdvancedCombat ?? true,
        totalWar: dto.rules?.totalWar ?? true,
        useArmyExperience: dto.rules?.useArmyExperience ?? false
      },
      engagement: sanitizeEngagementState(dto.engagement)
    };

    return state;
  } catch (e) {
    throw new Error(`Error reconstructing game state: ${(e as Error).message}`);
  }
};
