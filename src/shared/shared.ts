export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ============================================================
// Shared game types (was: shared/shared.ts)
// ============================================================

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
  COMBAT = 'COMBAT'
}

export enum ArmyState {
  EMBARKED = 'EMBARKED',
  DEPLOYED = 'DEPLOYED',
  IN_TRANSIT = 'IN_TRANSIT'
}

// --- Ground Units (Surface Map) ---

export type GroundUnitType = 'light_infantry' | 'mechanized_infantry' | 'heavy_armor' | 'artillery';

export type GroundPosture = 'normal' | 'prepared_defense';

export type GroundMoveOrder = { type: 'move'; to: SurfacePos };
export type GroundAttackOrder = { type: 'attack'; targetArmyId: string };
export type GroundLandOrder = { type: 'land'; to: SurfacePos };
export type GroundOrder = GroundMoveOrder | GroundAttackOrder;

export interface GroundOrders {
  move?: GroundMoveOrder;
  attack?: GroundAttackOrder;
}

export type GroundUnitTag =
  | 'artillery'
  | 'airborne'
  | 'engineer'
  | 'armored'
  | 'amphibious'
  | 'hardened'
  | 'anti_orbital';

export enum ShipType {
  CARRIER = 'carrier',
  CRUISER = 'cruiser',
  DESTROYER = 'destroyer',
  FRIGATE = 'frigate',
  FIGHTER = 'fighter',
  BOMBER = 'bomber',
  TRANSPORTER = 'transporter',
  BUILDER = 'builder',
  SUPPORT = 'support',
  TANKER = 'tanker',
  EXTRACTOR = 'extractor'
}

export type StationType = 'shipyard' | 'mining' | 'defense' | 'relay' | 'outpost';

export type ResourceType = 'none' | 'gas';

// --- Procedural Stellar System Generation (Astro data) ---
// NOTE: This is intentionally JSON-serializable (numbers/strings/arrays only) to support save files.

export type SpectralType = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';
export type StellarAgeClass = 'young' | 'mid' | 'old';
export type PlanetType = 'Terrestrial' | 'SubNeptune' | 'IceGiant' | 'GasGiant' | 'Dwarf';
export type MoonType = 'Regular' | 'Icy' | 'Volcanic' | 'Eden' | 'Irregular';
export type AtmosphereType = 'None' | 'Thin' | 'Earthlike' | 'CO2' | 'H2He';
export type OrbitRegime = 'A_froid' | 'B_tiede' | 'C_excite';
export type OrbitReferencePlane = 'invariant' | 'ecliptic_simulated' | 'central_equator';
export type OrbitEccentricityModel = 'beta_kipping_2013' | 'mixture_beta' | 'custom';

export interface WeightedSpectralType {
  type: SpectralType;
  weight: number;
}

export interface StellarClassBounds {
  massSun: [number, number];
  teffK: [number, number];
}

export type StellarMultiplicityByPrimaryType = Record<SpectralType, number>;

export interface OrbitGenerationParams {
  regime?: OrbitRegime;
  excitation?: number;
  referencePlane?: OrbitReferencePlane;
  sigmaIMutDeg?: number;
  sigmaISysDeg?: number;
  iTailWeight?: number;
  iTailRangeDeg?: [number, number];
  eModel?: OrbitEccentricityModel;
  eBetaParams?: { a: number; b: number };
  eTailWeight?: number;
  eTailBetaParams?: { a: number; b: number };
  eTailUniformRange?: [number, number];
  tidalCircularization?: {
    enabled?: boolean;
    aMinAu?: number;
    aTideAu?: number;
  };
  stabilityFilter?: {
    enabled?: boolean;
    margin?: number;
  };
  clamps?: {
    maxE?: number;
    maxIAbsDeg?: number;
  };
}

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
  orbit?: OrbitGenerationParams;
}

export type PlanetTypePlan = PlanetType[];
export type PlanetTypeProbs = Record<PlanetType, number>;

export interface StarOrbit {
  semiMajorAxisAu: number;
  periodDays: number;
  phaseDeg: number;
  inclinationDeg: number;
  ascendingNodeDeg: number;
}

export interface StarData {
  role: 'primary' | 'companion';
  spectralType: SpectralType;
  massSun: number;
  radiusSun: number;
  luminositySun: number;
  teffK: number;
  orbit?: StarOrbit;
}

export interface MoonData {
  type: MoonType;
  orbitDistanceRp: number;
  orbitEccentricity: number;
  orbitInclinationDeg: number;
  orbitAscendingNodeDeg: number;
  massEarth: number;
  radiusEarth: number;
  gravityG: number;
  albedo: number;
  teqK: number;
  tidalBonusK?: number;
  atmosphere: Exclude<AtmosphereType, 'H2He'>;
  pressureBar?: number;
  greenhouseK: number;
  climateK: number;
  airMassIndex: number;
  temperatureK: number;
  seasonalDeltaK: number;
}

export interface PlanetData {
  type: PlanetType;
  semiMajorAxisAu: number;
  eccentricity: number;
  orbitInclinationDeg: number;
  orbitAscendingNodeDeg: number;
  axialTiltDeg: number;
  massEarth: number;
  radiusEarth: number;
  gravityG: number;
  albedo: number;
  teqK: number;
  atmosphere: AtmosphereType;
  pressureBar?: number;
  greenhouseK: number;
  climateK: number;
  airMassIndex: number;
  temperatureK: number;
  seasonalDeltaK: number;
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

// --- Planet Surface Map (2D Hex, deterministic) ---
// NOTE: This is intentionally JSON-serializable to support save files.

export type Biome =
  | 'ocean'
  | 'coast'
  | 'lake'
  | 'ice'
  | 'fractured_ice'
  | 'dusty_ice'
  | 'cryovolcanic'
  | 'tundra'
  | 'taiga'
  | 'grassland'
  | 'forest'
  | 'rainforest'
  | 'desert'
  | 'ash_desert'
  | 'thermal_polygons'
  | 'lava_flats'
  | 'vitrified'
  | 'oxidized'
  | 'compressed_plateau'
  | 'chemical_erosion'
  | 'fossil_basin'
  | 'rocky'
  | 'mountain'
  | 'volcanic'
  | 'cratered';

export interface HexCoord {
  q: number;
  r: number;
}

export interface PlanetSurfaceConfig {
  w: number; // ex: 96
  h: number; // ex: 48
  wrapX: boolean; // true (cylindrical)
  generatorVersion: number; // ex: 1 (bump on breaking changes)
}

export interface PlanetSurfaceDescriptor {
  seed: number; // uint32
  config: PlanetSurfaceConfig;
  astroRef: { planetIndex: number; moonIndex?: number };
  settlementConfig?: SettlementGenerationConfig;
}

export const enum FeatureBits {
  River = 1 << 0,
  Road = 1 << 1,
  City = 1 << 2,
  Capital = 1 << 3,
  Resource1 = 1 << 8
}

export interface PlanetSurfaceTile {
  elev: number; // int16-ish (implementation chooses encoding)
  tempC2: number; // int16: local temperature in °C*2 (stable encoding)
  moist: number; // uint8 0..255
  biome: Biome;
  featureBits: number; // bitset
}

export type SettlementType = 'outpost' | 'colony' | 'frontierTown' | 'city' | 'metropolis' | 'megalopolis';
export type SettlementStatus = 'active' | 'ruins';

export interface SettlementGenerationConfig {
  neutralOutpostChance?: number;
  neutralOutpostRuinsChance?: number;
  developmentBias?: number;
}

export interface Settlement {
  id: string;
  name: string;
  coord: HexCoord;
  factionId?: string; // undefined if neutral
  type: SettlementType;
  population: number;
  status?: SettlementStatus;
  /**
   * Marks the primary settlement for the owning faction on this body.
   * Used as a deterministic anchor point for initial ground deployments.
   */
  isCapital?: boolean;
}

export type SettlementId = string;

export interface SettlementControlState {
  factionId: FactionId | null;
  lastCaptureTurn: number;
}

export interface PlanetSurfaceMap {
  systemId: string;
  bodyId: string; // planetId or moonId
  descriptor: PlanetSurfaceDescriptor;
  seaLevelElev: number;
  tiles: PlanetSurfaceTile[]; // length w*h (or derived from typed buffers internally)
  settlements: Settlement[];
}

export interface SurfacePos {
  bodyId: string; // planetId or moonId
  q: number;
  r: number;
}

export type GroundBuildingType = 'city' | 'outpost' | 'factory' | 'mine' | 'fortification' | 'bunker';

export type GroundBuildingTag = 'supply_node' | 'fortification_light' | 'bunker' | 'anti_orbital';

export interface GroundBuilding {
  id: string;
  factionId: FactionId;
  type: GroundBuildingType;
  surfacePos: SurfacePos;
  name?: string;
  tags?: GroundBuildingTag[];
  antiOrbital?: number;
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
  stellarAgeGyr?: number;
  stellarAgeClass?: StellarAgeClass;
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
  role: 'capital' | 'screen' | 'striker' | 'transport' | 'builder' | 'support';
  fuelCapacity: number;
  fuelConsumptionPerLy: number;
  fuelExtractionRate?: number;
  fuelTransferRate?: number;
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
  fuel: number;
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
  state: ArmyState;
  containerId: string;
  /**
   * Persisted surface position when DEPLOYED on a planet/moon surface.
   * Authoritative gameplay state (not derived).
   */
  surfacePos?: SurfacePos;

  // --- Metadata (not part of combat formulas) ---
  unitType: GroundUnitType;
  posture?: GroundPosture;
  postureSetTurn?: number;
  groundOrders?: GroundOrders;
  landingOrder?: GroundLandOrder;
  /**
   * Turn index when the army last transitioned to DEPLOYED.
   * Used for amphibious/airborne assault penalties (first turn after landing).
   */
  lastDeployedTurn?: number;
  /**
   * Turn index when the army last participated in a ground engagement.
   * Used for morale/condition recovery timing.
   */
  lastCombatTurn?: number;

  // --- Strict combat profile (used by ground resolver) ---
  maxMembers: number; // MM
  members: number; // M
  attack: number; // A
  defense: number; // D
  condition: number; // C in [0..1]
  morale: number; // [0..1]
  /**
   * Whether the army is currently routed (break/rally hysteresis).
   * When routed, the unit remains routed until morale recovers above the rally threshold.
   */
  routed?: boolean;
  fatigue: number; // [0..1]
  rangeMin: number; // Min attack range (hex)
  rangeMax: number; // Max attack range (hex)
  projectionRange: number; // ZOC / projection range (hex)
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
  invasionTargetPlanetId?: string | null; // Preferred planet target for invasion orders
  loadTargetSystemId?: string | null; // If set, fleet will embark allied armies at this system upon arrival
  unloadTargetSystemId?: string | null; // If set, fleet will unload embarked armies at this allied system upon arrival
}

export interface Station {
  id: string;
  systemId: string;
  factionId: FactionId;
  type: StationType;
  name?: string;
  anchorBodyId?: string | null;
  slotIndex?: number;
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
  unlimitedFuel: boolean;
}

export interface GameState {
  scenarioId: string;
  scenarioTitle?: string;

  // Faction System
  playerFactionId: FactionId; // The ID of the local player
  factions: FactionState[]; // Registry of all factions in this game

  seed: number;
  rngState: number;
  startYear: number;
  day: number;
  systems: StarSystem[];
  fleets: Fleet[];
  stations?: Station[];
  armies: Army[];
  lasers: LaserShot[];
  battles: Battle[];
  logs: LogEntry[];
  messages: GameMessage[];
  selectedFleetId: string | null;
  winnerFactionId: FactionId | 'draw' | null; // Renamed from winner
  aiStates?: Record<FactionId, AIState>;
  aiState?: AIState; // Legacy single-AI state kept for transition
  /**
   * Deterministic planet surface descriptors keyed by bodyId.
   * Stored in saves to freeze surface generation results across algorithm evolution.
   */
  planetSurfaceDescriptorsByBodyId?: Record<string, PlanetSurfaceDescriptor>;
  /**
   * Persisted ground buildings placed on planet surfaces.
   */
  groundBuildings?: GroundBuilding[];
  /**
   * Persisted settlement control state keyed by settlement id.
   */
  settlementControl?: Record<SettlementId, SettlementControlState>;
  /**
   * Hexes bombarded during the current turn, keyed by bodyId.
   */
  bombardedHexesByBodyId?: Record<string, HexCoord[]>;
  objectives: GameObjectives;
  rules: GameplayRules;
}

// ============================================================
// Worldgen audit log (debug only, JSON serializable)
// ============================================================

export type WorldgenAuditMode = 'summary' | 'climate' | 'surface';

export interface WorldgenAuditEvent {
  seq: number;
  step: string;
  kind: string;
  entityId?: string;
  rngStateBefore?: number;
  rngStateAfter?: number;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  note?: string;
  warning?: string;
}

export type WorldgenAuditEventInput = Omit<WorldgenAuditEvent, 'seq'>;

export type WorldgenAuditSink = (event: WorldgenAuditEventInput) => void;

export interface WorldgenAuditLog {
  schemaVersion: number;
  mode: WorldgenAuditMode;
  meta: {
    scenarioId: string;
    scenarioTitle?: string;
    seed: number;
    topology: string;
    radius: number;
    systemCountRequested: number;
    systemCountGenerated: number;
    minimumSystemSpacingLy: number;
    surfaceGeneratorVersion: number;
    rngStartState: number;
    rngEndState: number;
  };
  inputs: {
    generation: {
      systemCount: number;
      radius: number;
      topology: string;
      minimumSystemSpacingLy?: number;
      surfaceGeneratorVersion?: number;
      settlements?: {
        neutralOutpostChance?: number;
        neutralOutpostRuinsChance?: number;
        developmentBias?: number;
      };
      staticSystems?: Array<{
        id: string;
        name: string;
        position: Vec3;
        resourceType: ResourceType;
        planets?: Array<{
          id?: string;
          name?: string;
          bodyType: PlanetBodyType;
          class: PlanetClass;
          size?: number;
          ownerFactionId?: string | null;
        }>;
      }>;
    };
    setup: {
      startingDistribution: string;
      territoryAllocation?: {
        type: 'percentages';
        byFactionId: Record<string, number>;
        neutralShare?: number;
        contiguity?: 'clustered';
      };
      factions: Array<{
        id: string;
        name: string;
        colorHex: string;
        isPlayable: boolean;
        aiProfile?: string;
      }>;
      initialFleetsCount: number;
    };
  };
  events: WorldgenAuditEvent[];
  summaries: {
    systems: {
      total: number;
      staticCount: number;
      proceduralCount: number;
      homeworldCount: number;
      byResourceType: Record<string, number>;
      byOwnerFactionId: Record<string, number>;
      spacingFallbacks: {
        fallbackUsed: number;
        bestEffortUsed: number;
      };
    };
    astro: {
      total: number;
      missingAstroCount: number;
      starCountHistogram: Record<string, number>;
      planetCountStats: { min: number; max: number; avg: number };
    };
    planets: {
      totalBodies: number;
      planets: number;
      moons: number;
      solids: number;
      fallbackBodies: number;
      overrideCount: number;
    };
    surfaces?: {
      total: number;
      bySurfaceClass: Record<string, number>;
      settlementTotals: {
        total: number;
        byType: Record<string, number>;
        byStatus?: Record<string, number>;
      };
    };
  };
}

export interface WorldgenAuditCollector {
  mode: WorldgenAuditMode;
  log: WorldgenAuditLog;
  emit: WorldgenAuditSink;
}

// ============================================================
// Shared utilities (was: shared/shared.ts, shared/shared.ts, shared/shared.ts)
// ============================================================

const envMeta =
  typeof import.meta !== 'undefined'
    ? (import.meta as ImportMeta & { env?: { DEV?: boolean; VITE_LOG_LEVEL?: string } })
    : undefined;

type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4
};

const parseLogLevel = (value?: string): LogLevel | null => {
  if (!value) return null;
  const normalized = value.toLowerCase() as LogLevel;
  return normalized in LEVEL_ORDER ? normalized : null;
};

const defaultLevel: LogLevel = envMeta?.env?.DEV ? 'debug' : 'warn';

const processEnvLogLevel =
  typeof process !== 'undefined' && typeof process.env?.VITE_LOG_LEVEL === 'string'
    ? process.env.VITE_LOG_LEVEL
    : undefined;

let currentLevel: LogLevel = parseLogLevel(envMeta?.env?.VITE_LOG_LEVEL ?? processEnvLogLevel) ?? defaultLevel;

const shouldLog = (level: LogLevel) => LEVEL_ORDER[level] <= LEVEL_ORDER[currentLevel];

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

const logWithLevel =
  (level: LogLevel, method: ConsoleMethod) =>
  (...args: unknown[]) => {
    if (shouldLog(level)) {
      // Some environments may not implement console.debug explicitly.
      const fallbackMethod = console[method] ?? console.log;
      fallbackMethod(...args);
    }
  };

export const logger = {
  error: logWithLevel('error', 'error'),
  warn: logWithLevel('warn', 'warn'),
  info: logWithLevel('info', 'info'),
  debug: logWithLevel('debug', 'debug')
};

// Backward-compatible helpers
export const devLog = (...args: Parameters<typeof console.log>) => logger.debug(...args);
export const devWarn = (...args: Parameters<typeof console.warn>) => logger.warn(...args);
export const devError = (...args: Parameters<typeof console.error>) => logger.error(...args);

export const sorted = <T>(items: readonly T[], compareFn?: (a: T, b: T) => number): T[] => {
  // eslint-disable-next-line no-restricted-syntax -- the copy ensures callers keep immutability
  return [...items].sort(compareFn);
};

/**
 * Parses the unique ID format (prefix_hash) to return a displayable short code.
 * Handles cases where the ID might not follow the expected format.
 */
export const shortId = (id: string): string => {
  if (!id) return '???';
  const parts = id.split('_');
  const suffix = parts[parts.length - 1];
  if (!suffix) return '???';

  const uuidSegment = suffix.includes('-') ? suffix.split('-')[0] : suffix;
  if (!uuidSegment) return '???';

  const normalized = uuidSegment.replace(/[^a-zA-Z0-9]/g, '');
  if (!normalized) return '???';

  return normalized.slice(0, 8).toUpperCase();
};
