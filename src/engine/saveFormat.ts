
import {
  FleetState,
  ResourceType,
  ShipType,
  LogEntry,
  BattleStatus,
  ArmyState,
  VictoryType,
  GameplayRules,
  FactionState,
  StarSystemAstro,
  PlanetBody
} from '../shared/types';

export const SAVE_VERSION = 3 as const;
export type SaveVersion = typeof SAVE_VERSION;

// --- DTOs (Data Transfer Objects) ---

export interface Vector3DTO {
  x: number;
  y: number;
  z: number;
}

export interface ShipConsumablesDTO {
  offensiveMissiles: number;
  torpedoes: number;
  interceptors: number;
}

export interface ShipKillRecordDTO {
  id: string;
  day: number;
  turn: number;
  targetId: string;
  targetType: ShipType;
  targetFactionId: string;
}

export interface ShipDTO {
  id: string;
  type: ShipType;
  hp: number;
  maxHp: number;
  carriedArmyId?: string | null;
  transferBusyUntilDay?: number;
  consumables?: ShipConsumablesDTO;
  offensiveMissilesLeft?: number;
  torpedoesLeft?: number;
  interceptorsLeft?: number;
  killHistory?: ShipKillRecordDTO[];
}

export interface FleetDTO {
  id: string;
  factionId: string; // Renamed
  ships: ShipDTO[];
  position: Vector3DTO;
  state: FleetState;
  targetSystemId: string | null;
  targetPosition: Vector3DTO | null;
  radius: number;
  stateStartTurn: number;
  retreating?: boolean;
  invasionTargetSystemId?: string | null;
  loadTargetSystemId?: string | null;
  unloadTargetSystemId?: string | null;
}

export interface ArmyDTO {
  id: string;
  factionId: string; // Renamed
  strength: number;
  maxStrength?: number;
  morale?: number;
  state: ArmyState;
  containerId: string;
}

export interface StarSystemDTO {
  id: string;
  name: string;
  position: Vector3DTO;
  color: string;
  size: number;
  ownerFactionId: string | null; // Renamed
  resourceType: ResourceType;
  isHomeworld?: boolean;
  planets?: PlanetBody[];
  astro?: StarSystemAstro;
}

export interface LaserShotDTO {
  id: string;
  start: Vector3DTO;
  end: Vector3DTO;
  color: string;
  life: number;
}

export interface BattleShipSnapshotDTO {
  shipId: string;
  fleetId: string;
  factionId: string; // Renamed
  type: ShipType;
  maxHp: number;
  startingHp: number;
}

export interface BattleDTO {
  id: string;
  systemId: string;
  turnCreated: number;
  turnResolved?: number;
  status: BattleStatus;
  involvedFleetIds: string[];
  initialShips?: BattleShipSnapshotDTO[];
  survivorShipIds?: string[];
  logs: string[];
  
  winnerFactionId?: string | 'draw'; // Renamed
  roundsPlayed?: number;
  shipsLost?: Record<string, number>; 
  missilesIntercepted?: number;
  projectilesDestroyedByPd?: number;
}

export interface EnemySightingDTO {
  fleetId: string;
  factionId: string;
  systemId: string | null;
  position: Vector3DTO;
  daySeen: number;
  estimatedPower: number;
  confidence: number;
  lastUpdateDay?: number;
}

export interface AIStateDTO {
  sightings: Record<string, EnemySightingDTO>;
  targetPriorities: Record<string, number>;
  systemLastSeen: Record<string, number>;
  lastOwnerBySystemId?: Record<string, string | null>;
  holdUntilTurnBySystemId?: Record<string, number>;
}

export interface VictoryConditionDTO {
  type: VictoryType;
  value?: number | string;
}

export interface GameObjectivesDTO {
  conditions: VictoryConditionDTO[];
  maxTurns?: number;
}

export interface GameMessageDTO {
  id: string;
  day: number;
  type: string;
  priority: number;
  title: string;
  subtitle: string;
  lines: string[];
  payload: Record<string, unknown>;
  read: boolean;
  dismissed: boolean;
  createdAtTurn: number;
}

export interface GameStateDTO {
  scenarioId?: string;
  scenarioTitle?: string;
  
  // NEW V2 Fields
  playerFactionId: string;
  factions: FactionState[];

  seed: number;
  rngState?: number;
  startYear: number;
  day: number;
  systems: StarSystemDTO[];
  fleets: FleetDTO[];
  armies?: ArmyDTO[];
  lasers?: LaserShotDTO[];
  battles?: BattleDTO[];
  logs?: LogEntry[];
  messages?: GameMessageDTO[];
  selectedFleetId: string | null;
  winnerFactionId: string | 'draw' | null; // Renamed

  objectives?: GameObjectivesDTO;
  rules?: GameplayRules;
  aiState?: AIStateDTO;
  aiStates?: Record<string, AIStateDTO>;
}

export interface SaveFileV2 {
  version: 2;
  createdAt: string;
  state: GameStateDTO;
}

export interface SaveFileV3 {
  version: 3;
  createdAt: string;
  state: GameStateDTO;
}

export type SaveFile = SaveFileV2 | SaveFileV3;
