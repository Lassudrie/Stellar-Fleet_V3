import {
  Battle,
  Fleet,
  LaserShot,
  LogEntry,
  ShipType,
  StarSystem,
  ArmyState,
  GameplayRules,
  AIState,
  GameObjectives,
} from '../types';
import { EnemySightingDTO } from './saveEnemies';
export const SAVE_VERSION = 2;

export interface SaveFileV2 {
  version: 2;
  timestamp: number;
  gameState: GameStateDTO;
}

export interface GameStateDTO {
  systems: StarSystemDTO[];
  fleets: FleetDTO[];
  armies: ArmyDTO[];
  factions: FactionDTO[];
  battles: BattleDTO[];
  logs: LogEntry[];
  laserShots: LaserShotDTO[];
  day: number;
  currentPlayer: string;
  selectedFleetId: string | null;
  selectedSystemId: string | null;
  cameraPosition: Vector3DTO;
  cameraTarget: Vector3DTO;
  rules: GameplayRules;
  aiState: AIState;
  gameStarted: boolean;
  gameOver: boolean;
  winner: string | null;
  objectives: GameObjectives;
  enemySightings?: EnemySightingDTO[];
}

export interface Vector3DTO {
  x: number;
  y: number;
  z: number;
}

export interface StarSystemDTO {
  id: string;
  name: string;
  position: Vector3DTO;
  ownerFactionId: string | null;
  population: number;
  maxPopulation: number;
  economy: number;
  defenseLevel: number;
  resources: {
    metal: number;
    crystal: number;
    fuel: number;
  };
  color: string;
}

export interface ShipDTO {
  id: string;
  type: ShipType;
  hp: number;
  maxHp: number;
  missileCooldown: number;
  carriedArmyId: string | null;
  veteranLevel?: number;
  kills?: number;
}

export interface FleetDTO {
  id: string;
  name: string;
  factionId: string; // Renamed
  position: Vector3DTO;
  ships: ShipDTO[];
  fuel: number;
  maxFuel: number;
  destination?: Vector3DTO;
  arrivedAt?: number;
}

export interface ArmyDTO {
  id: string;
  factionId: string; // Renamed
  strength: number;
  state: ArmyState;
  containerId: string;

  // --- Optional Ground Combat Stats (backward-compatible) ---
  groundAttack?: number;
  groundDefense?: number;
  maxStrength?: number;
  experience?: number;
  level?: number;
  morale?: number;
  fatigue?: number;
}

export interface FactionDTO {
  id: string;
  name: string;
  color: string;
  resources: {
    metal: number;
    crystal: number;
    fuel: number;
  };
  aiControlled: boolean;
  eliminated?: boolean;
}

export interface BattleDTO {
  id: string;
  systemId: string;
  fleets: string[];
  resolved: boolean;
}

export interface LaserShotDTO {
  id: string;
  start: Vector3DTO;
  end: Vector3DTO;
  color: string;
  createdAt: number;
  duration: number;
}
