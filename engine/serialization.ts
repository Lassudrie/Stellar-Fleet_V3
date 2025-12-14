import { Vec3, vec3 } from './math/vec3';
import { AIState, Army, Battle, Fleet, FleetState, GameObjectives, GameState, LaserShot, LogEntry, StarSystem } from '../types';
import { LaserShotDTO, SaveFileV2, GameStateDTO, Vector3DTO, ShipDTO, FleetDTO, StarSystemDTO, EnemySightingDTO, SAVE_VERSION } from './saveFormat';
import { toEnemySightings, fromEnemySightings } from './saveEnemies';
import { deepFreezeDev } from './state/immutability';

const serializeVector3 = (v: Vec3): Vector3DTO => ({ x: v.x, y: v.y, z: v.z });
const deserializeVector3 = (v: Vector3DTO): Vec3 => vec3(v.x, v.y, v.z);

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

const finiteOr = (value: any, fallback: number): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const finiteOrUndefined = (value: any): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

export const serializeGameState = (state: GameState): SaveFileV2 => {
  const dto: GameStateDTO = {
    scenarioId: state.scenarioId,
    scenarioTitle: state.scenarioTitle,
    playerFactionId: state.playerFactionId,
    seed: state.seed,
    rngState: state.rngState,
    startYear: state.startYear,
    systems: state.systems.map(s => ({
      id: s.id,
      name: s.name,
      position: serializeVector3(s.position),
      ownerFactionId: s.ownerFactionId,
      population: s.population,
      maxPopulation: s.maxPopulation,
      economy: s.economy,
      defenseLevel: s.defenseLevel,
      resources: s.resources,
      color: s.color,
    })),
    fleets: state.fleets.map(f => ({
      id: f.id,
      name: f.name,
      factionId: f.factionId,
      position: serializeVector3(f.position),
      ships: f.ships.map(s => ({
        id: s.id,
        type: s.type,
        hp: s.hp,
        maxHp: s.maxHp,
        missileCooldown: s.missileCooldown,
        carriedArmyId: s.carriedArmyId,
        veteranLevel: s.veteranLevel,
        kills: s.kills,
      })),
      fuel: f.fuel,
      maxFuel: f.maxFuel,
      destination: f.destination ? serializeVector3(f.destination) : undefined,
      arrivedAt: f.arrivedAt,
      state: f.state,
      targetSystemId: f.targetSystemId,
      targetPosition: f.targetPosition ? serializeVector3(f.targetPosition) : null,
      radius: f.radius,
      stateStartTurn: f.stateStartTurn,
      retreating: f.retreating,
      invasionTargetSystemId: f.invasionTargetSystemId,
      currentSystemId: f.currentSystemId,
      embarkedArmyIds: f.embarkedArmyIds,
    })),
    armies: state.armies.map(a => ({
      id: a.id,
      factionId: a.factionId,
      strength: a.strength,
      state: a.state,
      containerId: a.containerId,

      // Optional ground combat fields
      groundAttack: a.groundAttack,
      groundDefense: a.groundDefense,
      maxStrength: a.maxStrength,
      experience: a.experience,
      level: a.level,
      morale: a.morale,
      fatigue: a.fatigue,
    })),
    factions: state.factions.map(f => ({
      id: f.id,
      name: f.name,
      color: f.color,
      resources: (f as any).resources || { metal: 0, crystal: 0, fuel: 0 },
      aiControlled: (f as any).aiControlled !== undefined ? (f as any).aiControlled : !f.isPlayable,
      eliminated: (f as any).eliminated,
    })),
    battles: state.battles,
    logs: state.logs,
    lasers: state.lasers.map(ls => ({
      id: ls.id,
      start: serializeVector3(ls.start),
      end: serializeVector3(ls.end),
      color: ls.color,
      life: (ls as any).life || 0,
    })),
    laserShots: state.laserShots.map(ls => ({
      id: ls.id,
      start: serializeVector3(ls.start),
      end: serializeVector3(ls.end),
      color: ls.color,
      createdAt: ls.createdAt,
      duration: ls.duration,
    })),
    day: state.day,
    currentPlayer: state.currentPlayer,
    selectedFleetId: state.selectedFleetId,
    selectedSystemId: state.selectedSystemId,
    winnerFactionId: state.winnerFactionId,
    cameraPosition: serializeVector3(state.cameraPosition),
    cameraTarget: serializeVector3(state.cameraTarget),
    rules: state.rules,
    aiState: state.aiState,
    gameStarted: state.gameStarted,
    gameOver: state.gameOver,
    winner: state.winner,
    objectives: state.objectives,
    enemySightings: toEnemySightings(state.aiState),
  };

  return {
    version: SAVE_VERSION,
    timestamp: Date.now(),
    gameState: dto,
  };
};

export const deserializeGameState = (saveFile: SaveFileV2): GameState => {
  try {
    const dto = saveFile.gameState;

    const systems: StarSystem[] = dto.systems.map((s: StarSystemDTO) => ({
      id: s.id,
      name: s.name,
      position: deserializeVector3(s.position),
      ownerFactionId: s.ownerFactionId,
      population: s.population,
      maxPopulation: s.maxPopulation,
      economy: s.economy,
      defenseLevel: s.defenseLevel,
      resources: s.resources,
      color: s.color,
    }));

    const fleets: Fleet[] = dto.fleets.map((f: FleetDTO) => ({
      id: f.id,
      name: f.name,
      factionId: f.factionId || (f as any).faction, // Migration
      position: deserializeVector3(f.position),
      ships: f.ships.map((s: ShipDTO) => ({
        id: s.id,
        type: s.type,
        hp: s.hp,
        maxHp: s.maxHp,
        missileCooldown: s.missileCooldown,
        carriedArmyId: s.carriedArmyId,
        veteranLevel: s.veteranLevel,
        kills: s.kills,
      })),
      fuel: f.fuel,
      maxFuel: f.maxFuel,
      destination: f.destination ? deserializeVector3(f.destination) : undefined,
      arrivedAt: f.arrivedAt,
      state: ((f as any).state as FleetState) || FleetState.ORBIT, // Migration: default to ORBIT if missing
      targetSystemId: (f as any).targetSystemId || null,
      targetPosition: (f as any).targetPosition ? deserializeVector3((f as any).targetPosition) : null,
      radius: (f as any).radius || 0,
      stateStartTurn: (f as any).stateStartTurn || 0,
      retreating: (f as any).retreating,
      invasionTargetSystemId: (f as any).invasionTargetSystemId,
      currentSystemId: (f as any).currentSystemId,
      embarkedArmyIds: (f as any).embarkedArmyIds,
    }));

    const armies: Army[] = (dto.armies || []).map((a: any) => {
      const strength = Math.max(0, finiteOr(a.strength, 0));
      const maxStrength = Math.max(strength, finiteOr(a.maxStrength, strength));
      const experience = Math.max(0, finiteOr(a.experience, 0));
      const levelFromSave = finiteOrUndefined(a.level);
      const level = levelFromSave !== undefined ? Math.max(1, Math.floor(levelFromSave)) : Math.max(1, Math.floor(experience / 100) + 1);
      const morale = clamp(finiteOr(a.morale, 100), 0, 100);

      return {
        id: a.id,
        factionId: a.factionId || a.faction, // Migration
        strength: Math.min(strength, maxStrength),
        state: a.state,
        containerId: a.containerId,

        // Ground combat fields (optional)
        groundAttack: finiteOrUndefined(a.groundAttack),
        groundDefense: finiteOrUndefined(a.groundDefense),
        maxStrength,
        experience,
        level,
        morale,
        fatigue: finiteOrUndefined(a.fatigue),
      };
    });

    const battles: Battle[] = dto.battles || [];

    const laserShots: LaserShot[] = (dto.laserShots || []).map((ls: LaserShotDTO) => ({
      id: ls.id,
      start: deserializeVector3(ls.start),
      end: deserializeVector3(ls.end),
      color: ls.color,
      createdAt: ls.createdAt,
      duration: ls.duration,
    }));

    const logs: LogEntry[] = dto.logs || [];

    const aiState: AIState = dto.aiState || { enemySightings: {} };

    const lasers: LaserShot[] = (dto.lasers || []).map((l: any) => ({
      id: l.id,
      start: deserializeVector3(l.start),
      end: deserializeVector3(l.end),
      color: l.color,
      createdAt: (l as any).createdAt || Date.now(),
      duration: (l as any).duration || 1000,
    }));

    const state: GameState = {
      scenarioId: dto.scenarioId || 'unknown',
      scenarioTitle: dto.scenarioTitle,
      playerFactionId: dto.playerFactionId || dto.currentPlayer,
      factions: dto.factions.map((f: any) => ({
        id: f.id,
        name: f.name,
        color: f.color,
        isPlayable: !f.aiControlled,
        aiProfile: f.aiControlled ? 'aggressive' : undefined,
      })),
      seed: dto.seed || Date.now(),
      rngState: dto.rngState || dto.seed || Date.now(),
      startYear: dto.startYear || 2200,
      systems,
      fleets,
      armies,
      lasers,
      battles,
      logs,
      laserShots,
      day: dto.day || 0,
      currentPlayer: dto.currentPlayer,
      selectedFleetId: dto.selectedFleetId,
      selectedSystemId: dto.selectedSystemId,
      winnerFactionId: dto.winnerFactionId || dto.winner,
      cameraPosition: deserializeVector3(dto.cameraPosition),
      cameraTarget: deserializeVector3(dto.cameraTarget),
      rules: dto.rules || {
        fogOfWar: true,
        aiEnabled: true,
        useAdvancedCombat: true,
        totalWar: true,
      },
      aiState: fromEnemySightings(aiState, dto.enemySightings as EnemySightingDTO[]),
      gameStarted: dto.gameStarted,
      gameOver: dto.gameOver,
      winner: dto.winner || dto.winnerFactionId,
      objectives: dto.objectives || {
        conditions: [],
        maxTurns: undefined,
      },
    };

    // Freeze for dev safety (optional)
    deepFreezeDev(state);
    return state;
  } catch (error) {
    console.error('Error deserializing game state:', error);
    throw error;
  }
};
