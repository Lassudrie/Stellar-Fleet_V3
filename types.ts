export type FactionId = string;

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface StarSystem {
  id: string;
  name: string;
  position: Vector3;
  ownerFactionId: FactionId | null;
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

export enum ShipType {
  FIGHTER = 'fighter',
  BOMBER = 'bomber',
  FRIGATE = 'frigate',
  DESTROYER = 'destroyer',
  CRUISER = 'cruiser',
  CARRIER = 'carrier',
  TROOP_TRANSPORT = 'troop_transport'
}

export interface ShipEntity {
  id: string;
  type: ShipType;
  hp: number;
  maxHp: number;
  missileCooldown: number;
  carriedArmyId: string | null;
  veteranLevel?: number; // XP level for ship crew
  kills?: number; // Track ship kills
}

export interface Fleet {
  id: string;
  name: string;
  factionId: FactionId;
  position: Vector3;
  ships: ShipEntity[];
  fuel: number;
  maxFuel: number;
  destination?: Vector3;
  arrivedAt?: number;

  // Runtime navigation state
  state?: FleetState;
  targetSystemId?: string | null;
  targetPosition?: Vector3 | null;
  invasionTargetSystemId?: string | null;
  retreating?: boolean;
  stateStartTurn?: number;
  radius?: number;
}

export enum FleetState {
  ORBIT = 'ORBIT',
  MOVING = 'MOVING',
  COMBAT = 'COMBAT'
}

export enum ArmyState {
  DEPLOYED = 'deployed',
  EMBARKED = 'embarked',
  IN_TRANSIT = 'in_transit'
}

export interface Army {
  id: string;
  factionId: FactionId; // Renamed from faction
  strength: number;
  state: ArmyState;
  containerId: string;
  embarkedFleetId?: string; // Fleet ID if army is embarked on a fleet

  // --- Ground Combat (Deterministic Attrition Model) ---
  // Persistent / long-term stats (evolve slowly via recruitment & XP)
  groundAttack?: number;    // offensive capability (dimensionless points)
  groundDefense?: number;   // defensive capability (dimensionless points)
  maxStrength?: number;     // maximum theoretical strength (in "soldiers")
  experience?: number;      // cumulative XP
  level?: number;           // derived from experience (stored for convenience)

  // Dynamic / battle stats (fluctuate during fights)
  morale?: number;          // 0..100
  fatigue?: number;         // optional (not required in baseline v1)
}

export interface Battle {
  id: string;
  systemId: string;
  fleets: string[];
  resolved: boolean;
}

export interface LogEntry {
  id: string;
  day: number;
  text: string;
  type: 'info' | 'combat' | 'diplomacy' | 'objective';
}

export interface LaserShot {
  id: string;
  start: Vector3;
  end: Vector3;
  color: string;
  createdAt: number;
  duration: number;
}

export interface EnemySighting {
  fleetId: string;
  position: Vector3;
  lastSeen: number;
}

export interface AIState {
  enemySightings: Record<string, EnemySighting[]>; // factionId -> sightings
}

export interface GameObjectives {
  targetSystems: number;
  eliminateAllEnemies: boolean;
}

export type GroundCombatModel = 'legacy' | 'deterministic_attrition_v1';

export interface GroundCombatRules {
  enabled: boolean;
  model: GroundCombatModel;
  /** Optional balance/scenario config id (data-driven). */
  configId?: string;
}

export interface GameplayRules {
  fogOfWar: boolean;
  useAdvancedCombat: boolean;
  aiEnabled: boolean;
  totalWar: boolean;

  /**
   * Optional: deterministic ground combat toggle.
   * - If absent or enabled=false, the game uses the legacy ground conquest resolver.
   */
  groundCombat?: GroundCombatRules;
}

export interface GameState {
  systems: StarSystem[];
  fleets: Fleet[];
  armies: Army[];
  factions: {
    id: FactionId;
    name: string;
    color: string;
    resources: {
      metal: number;
      crystal: number;
      fuel: number;
    };
    aiControlled: boolean;
    eliminated?: boolean;
  }[];
  battles: Battle[];
  logs: LogEntry[];
  laserShots: LaserShot[];
  day: number;
  currentPlayer: FactionId;
  selectedFleetId: string | null;
  selectedSystemId: string | null;
  cameraPosition: Vector3;
  cameraTarget: Vector3;
  rules: GameplayRules;
  aiState: AIState;
  gameStarted: boolean;
  gameOver: boolean;
  winner: FactionId | null;
  objectives: GameObjectives;
}
