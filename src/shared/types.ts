
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

// --- Procedural Stellar System Generation (Astro data) ---
// NOTE: This is intentionally JSON-serializable (numbers/strings/arrays only) to support save files.

export type SpectralType = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';
export type PlanetType = 'Terrestrial' | 'SubNeptune' | 'IceGiant' | 'GasGiant' | 'Dwarf';
export type MoonType = 'Regular' | 'Icy' | 'Volcanic' | 'Eden' | 'Irregular';
export type AtmosphereType = 'None' | 'Thin' | 'Earthlike' | 'CO2' | 'H2He';

export interface WeightedSpectralType {
  type: SpectralType;
  weight: number;
}

export interface StellarClassBounds {
  massSun: [number, number];
  teffK: [number, number];
}

export type StellarMultiplicityByPrimaryType = Record<SpectralType, number>;

export interface StellarSystemGenParams {
  maxPlanets: number;
  maxSemiMajorAxisAu: number;
  minSemiMajorAxisAu: number;
  innerSlotRatio: number;
  hotGiantChance: number;
  snowLineMatchRange: [number, number];
  spacingLogMean: number;
  spacingLogStd: number;
  firstOrbitLogRange: [number, number];
}

export type PlanetTypePlan = PlanetType[];
export type PlanetTypeProbs = Record<PlanetType, number>;

export interface StarData {
  role: 'primary' | 'companion';
  spectralType: SpectralType;
  massSun: number;
  radiusSun: number;
  luminositySun: number;
  teffK: number;
}

export interface MoonData {
  type: MoonType;
  orbitDistanceRp: number;
  massEarth: number;
  radiusEarth: number;
  gravityG: number;
  albedo: number;
  teqK: number;
  tidalBonusK?: number;
  atmosphere: Exclude<AtmosphereType, 'H2He'>;
  temperatureK: number;
}

export interface PlanetData {
  type: PlanetType;
  semiMajorAxisAu: number;
  eccentricity: number;
  massEarth: number;
  radiusEarth: number;
  gravityG: number;
  albedo: number;
  teqK: number;
  atmosphere: AtmosphereType;
  pressureBar?: number;
  temperatureK: number;
  climateTag?: string;
  moons: MoonData[];
}

export type PlanetBodyType = 'planet' | 'moon';
export type PlanetClass = 'solid' | 'gas_giant' | 'ice_giant';

export interface PlanetBody {
  id: string;
  systemId: string;
  name: string;
  bodyType: PlanetBodyType;
  class: PlanetClass;
  ownerFactionId?: FactionId | null;
  size: number;
  isSolid: boolean;
}

// Helper to pass a few derived orbit/HZ values into planet logic
export interface StellarDerived {
  semiMajorAxisAu: number;
  hzInnerAu: number;
  hzOuterAu: number;
}

export interface StarSystemAstro {
  seed: number; // Derived per-system seed for debug / reproducibility
  primarySpectralType: SpectralType;
  starCount: number;
  metallicityFeH: number;
  derived: {
    luminosityTotalLSun: number;
    snowLineAu: number;
    hzInnerAu: number;
    hzOuterAu: number;
  };
  stars: StarData[];
  planets: PlanetData[];
}

export interface StellarSystemPlan {
  planetTypes: PlanetTypePlan;
  moons: MoonType[][];
}

export interface ShipStats {
  maxHp: number;
  damage: number;
  speed: number;
  cost: number;
  pdStrength: number;
  evasion: number;
  maneuverability: number;
  offensiveMissileStock: number;
  missileDamage: number;
  torpedoStock: number;
  torpedoDamage: number;
  interceptorStock: number;
  role: 'capital' | 'screen' | 'striker' | 'transport';
}

export interface ShipConsumables {
  offensiveMissiles: number;
  torpedoes: number;
  interceptors: number;
}

export interface ShipKillRecord {
  id: string;
  day: number;
  turn: number;
  targetId: string;
  targetType: ShipType;
  targetFactionId: FactionId;
}

export interface ShipEntity {
  id: string;
  type: ShipType;
  hp: number;
  maxHp: number;
  carriedArmyId: string | null;
  transferBusyUntilDay?: number;
  consumables?: ShipConsumables;
  offensiveMissilesLeft?: number;
  torpedoesLeft?: number;
  interceptorsLeft?: number;
  killHistory?: ShipKillRecord[];
}

export interface Army {
  id: string;
  factionId: FactionId; // Renamed from faction
  strength: number;
  maxStrength: number;
  morale: number;
  state: ArmyState;
  containerId: string;
}

export interface StarSystem {
  id: string;
  name: string;
  position: Vec3;
  color: string; // Visual color (usually matches owner color)
  size: number;
  ownerFactionId: FactionId | null; // Renamed from owner
  resourceType: ResourceType;
  isHomeworld: boolean;
  planets: PlanetBody[];
  astro?: StarSystemAstro; // Optional procedural astro data (stars/planets/moons)
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
  loadTargetSystemId?: string | null; // If set, fleet will embark allied armies at this system upon arrival
  unloadTargetSystemId?: string | null; // If set, fleet will unload embarked armies at this allied system upon arrival
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

export interface GameMessage {
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

export type BattleStatus = 'scheduled' | 'resolved';

export interface BattleShipSnapshot {
  shipId: string;
  fleetId: string;
  factionId: FactionId; // Renamed from faction
  type: ShipType;
  maxHp: number;
  startingHp: number;
}

export interface BattleAmmunitionTally {
  initial: number;
  used: number;
  remaining: number;
}

export interface BattleAmmunitionBreakdown {
  offensiveMissiles: BattleAmmunitionTally;
  torpedoes: BattleAmmunitionTally;
  interceptors: BattleAmmunitionTally;
}

export type BattleAmmunitionByFaction = Record<FactionId, BattleAmmunitionBreakdown>;

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
  ammunitionByFaction?: BattleAmmunitionByFaction;
}

export interface EnemySighting {
  fleetId: string;
  factionId: FactionId;
  systemId: string | null;
  position: Vec3;
  daySeen: number;
  estimatedPower: number;
  confidence: number;
  lastUpdateDay?: number;
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
  messages: GameMessage[];
  selectedFleetId: string | null;
  winnerFactionId: FactionId | 'draw' | null; // Renamed from winner
  aiStates?: Record<FactionId, AIState>;
  aiState?: AIState; // Legacy single-AI state kept for transition
  objectives: GameObjectives;
  rules: GameplayRules;
}
