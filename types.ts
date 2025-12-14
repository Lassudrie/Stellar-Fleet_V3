
import { Vec3 } from './engine/math/vec3';

// Replaces enum Faction
export type FactionId = string;

export interface FactionState {
  id: FactionId;
  name: string;
  color: string;
  isPlayable: boolean;
  aiProfile?: string; // If present, controlled by AI
}

export enum FleetState {
  ORBIT = 'ORBIT',
  MOVING = 'MOVING',
  COMBAT = 'COMBAT',
}

export enum ArmyState {
  EMBARKED = 'EMBARKED',
  DEPLOYED = 'DEPLOYED',
  IN_TRANSIT = 'IN_TRANSIT',
}

export enum ShipType {
  CARRIER = 'carrier',
  CRUISER = 'cruiser',
  DESTROYER = 'destroyer',
  FRIGATE = 'frigate',
  FIGHTER = 'fighter',
  BOMBER = 'bomber',
  TROOP_TRANSPORT = 'troop_transport',
}

export type ResourceType = 'none' | 'gas';

export interface ShipStats {
  maxHp: number;
  damage: number;
  speed: number;
  cost: number;
  pdStrength: number;
  evasion: number;
  maneuverability: number;
  missileStock: number;
  missileDamage: number;
  torpedoStock: number;
  torpedoDamage: number;
  role: 'capital' | 'screen' | 'striker' | 'transport';
}

export interface ShipEntity {
  id: string;
  type: ShipType;
  hp: number;
  maxHp: number;
  carriedArmyId: string | null;
}

export interface Army {
  id: string;
  factionId: FactionId; // Renamed from faction
  strength: number;
  state: ArmyState;
  containerId: string;
  embarkedFleetId?: string; // Fleet ID if army is embarked on a fleet
}

export interface StarSystem {
  id: string;
  name: string;
  position: Vec3;
  color: string; // Visual color (usually matches owner color)
  size: number;
  ownerFactionId: FactionId | null; // Renamed from owner
  resourceType: ResourceType;
}

export interface Fleet {
  id: string;
  factionId: FactionId; // Renamed from faction
  ships: ShipEntity[];
  position: Vec3;
  state: FleetState;
  targetSystemId: string | null;
  targetPosition: Vec3 | null;
  radius: number; // Visual size based on ship count (Derived field)
  stateStartTurn: number; // Turn when the current state began (Used for VFX)
  retreating?: boolean; // True if the fleet is forced to retreat after a defeat
  invasionTargetSystemId?: string | null; // If set, fleet will unload armies automatically upon arrival at this system
  currentSystemId?: string | null; // System ID where the fleet is currently located (if in orbit)
  embarkedArmyIds?: string[]; // Array of army IDs embarked on this fleet
}

export interface LaserShot {
  id: string;
  start: Vec3;
  end: Vec3;
  color: string;
  life: number;
}

export interface LogEntry {
  id: string;
  day: number;
  text: string;
  type: 'info' | 'combat' | 'move' | 'ai';
}

export type BattleStatus = 'scheduled' | 'resolved';

export interface BattleShipSnapshot {
  shipId: string;
  fleetId: string;
  factionId: FactionId; // Renamed from faction
  type: ShipType;
  maxHp: number;
  startingHp: number;
}

export interface Battle {
  id: string;
  systemId: string;
  turnCreated: number;
  turnResolved?: number;
  status: BattleStatus;
  involvedFleetIds: string[];
  logs: string[];
  initialShips?: BattleShipSnapshot[];
  survivorShipIds?: string[];
  winnerFactionId?: FactionId | 'draw'; // Renamed from winner
  roundsPlayed?: number;
  shipsLost?: Record<FactionId, number>; // Keys are FactionId strings
  missilesIntercepted?: number;
  projectilesDestroyedByPd?: number;
}

export interface EnemySighting {
  fleetId: string;
  systemId: string | null;
  position: Vec3;
  daySeen: number;
  estimatedPower: number;
  confidence: number;
}

export interface AIState {
  sightings: Record<string, EnemySighting>;
  targetPriorities: Record<string, number>;
  systemLastSeen: Record<string, number>;
  lastOwnerBySystemId: Record<string, FactionId | null>;
  holdUntilTurnBySystemId: Record<string, number>;
}

export type VictoryType = 'elimination' | 'domination' | 'survival' | 'king_of_the_hill';

export interface VictoryCondition {
  type: VictoryType;
  value?: number | string;
}

export interface GameObjectives {
  conditions: VictoryCondition[];
  maxTurns?: number;
}

export interface GameplayRules {
  fogOfWar: boolean;
  useAdvancedCombat: boolean;
  aiEnabled: boolean;
  totalWar: boolean;
}

export interface GameState {
  scenarioId: string;
  scenarioTitle?: string;
  
  // Faction System
  playerFactionId: FactionId; // The ID of the local player
  factions: FactionState[];   // Registry of all factions in this game

  seed: number;
  rngState: number;
  startYear: number;
  day: number;
  systems: StarSystem[];
  fleets: Fleet[];
  armies: Army[];
  lasers: LaserShot[];
  battles: Battle[];
  logs: LogEntry[];
  selectedFleetId: string | null;
  winnerFactionId: FactionId | null; // Renamed from winner
  aiState?: AIState; // TODO: Can be a Map<FactionId, AIState> for multi-AI later
  objectives: GameObjectives;
  rules: GameplayRules;
}
