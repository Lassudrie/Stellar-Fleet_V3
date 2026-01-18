
import {
  GameState,
  Fleet,
  StarSystem,
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
  ResourceType,
  StarSystemAstro,
  StarOrbit,
  GameMessage,
  PlanetBody,
  Station,
  StationType,
  PlanetSurfaceDescriptor,
  SettlementGenerationConfig,
  GroundBuilding,
  GroundBuildingType,
  GroundBuildingTag,
  SurfacePos,
  GroundAttackOrder,
  GroundLandOrder,
  GroundMoveOrder,
  GroundOrder,
  GroundOrders,
  GroundPosture,
  GroundUnitType,
  HexCoord,
  SettlementControlState,
  VictoryType,
  PlanetData,
  MoonData,
  logger,
  MS_PER_DAY
} from '../shared/shared';
import { Vec3, vec3 } from './math/vec3';
import { getAiFactionIds, getLegacyAiFactionId } from './ai';
import { COLORS, SHIP_STATS } from '../content/data/static';
import { GROUND_UNIT_STATS } from '../content/data/groundUnits';
import { RNG } from './rng';
import {
  drawCompanionOrbits,
  deriveSeed32,
  generateStellarSystem,
  generatePlanetOrbitParams,
  computePlanetClimate,
  computeMoonClimate,
  computePlanetSeasonalDeltaK,
  computeMoonSeasonalDeltaK,
  drawMoonOrbitParams
} from './worldgen/stellarSystem';
import { normalizePlanetBodies } from './planets';
import { quantizeFuel } from './logistics/fuel';
import { createPlanetSurfaceDescriptor, getSurfaceTileCount, normalizeSurfacePositions, resolveSurfaceTileId } from './planetSurface';
import { BREAK_THRESHOLD, RALLY_THRESHOLD } from './ground';

// ============================================================
// Save format + DTOs (was: engine/saveFormat.ts)
// ============================================================

export const SAVE_VERSION = 7 as const;

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
  timeMs: number;
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
  transferBusyUntilTimeMs?: number;
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
  stateStartTimeMs: number;
  retreating?: boolean;
  invasionTargetSystemId?: string | null;
  invasionTargetPlanetId?: string | null;
  loadTargetSystemId?: string | null;
  unloadTargetSystemId?: string | null;
}

export interface StationDTO {
  id: string;
  systemId: string;
  factionId: string;
  type: StationType;
  name?: string;
  anchorBodyId?: string | null;
  slotIndex?: number;
}

export interface ArmyDTO {
  id: string;
  factionId: string; // Renamed
  // Legacy V3 fields (read-only migration)
  strength?: number;
  maxStrength?: number;
  morale?: number;

  // V4 fields
  unitType?: string;
  maxMembers?: number;
  members?: number;
  attack?: number;
  defense?: number;
  condition?: number;
  fatigue?: number;
  routed?: boolean;
  rangeMin?: number;
  rangeMax?: number;
  projectionRange?: number;

  posture?: 'normal' | 'prepared_defense';
  postureSetTimeMs?: number;
  groundOrder?: any;
  groundOrders?: any;
  landingOrder?: any;
  lastDeployedTimeMs?: number;
  lastCombatTimeMs?: number;
  state: ArmyState;
  containerId: string;
  surfacePos?: SurfacePos;
}

export type GroundBuildingDTO = GroundBuilding;

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
  timeCreatedMs: number;
  timeResolvedMs?: number;
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
  timeSeenMs: number;
  estimatedPower: number;
  confidence: number;
  lastUpdateTimeMs?: number;
}

export interface AIStateDTO {
  sightings: Record<string, EnemySightingDTO>;
  targetPriorities: Record<string, number>;
  systemLastSeenTimeMs: Record<string, number>;
  lastOwnerBySystemId?: Record<string, string | null>;
  holdUntilTimeMsBySystemId?: Record<string, number>;
}

export interface VictoryConditionDTO {
  type: VictoryType;
  value?: number | string;
}

export interface GameObjectivesDTO {
  conditions: VictoryConditionDTO[];
  maxTimeMs?: number;
}

export interface GameMessageDTO {
  id: string;
  timeMs: number;
  type: string;
  priority: number;
  title: string;
  subtitle: string;
  lines: string[];
  payload: Record<string, unknown>;
  read: boolean;
  dismissed: boolean;
  createdAtTimeMs: number;
}

export interface GameStateDTO {
  scenarioId?: string;
  scenarioTitle?: string;

  // NEW V2 Fields
  playerFactionId: string;
  factions: FactionState[];

  seed: number;
  rngState?: number;
  idRngState?: number;
  startYear: number;
  timeMs: number;
  systems: StarSystemDTO[];
  fleets: FleetDTO[];
  stations?: StationDTO[];
  armies?: ArmyDTO[];
  battles?: BattleDTO[];
  logs?: LogEntry[];
  messages?: GameMessageDTO[];
  winnerFactionId: string | 'draw' | null; // Renamed

  objectives?: GameObjectivesDTO;
  rules?: GameplayRules;
  aiState?: AIStateDTO;
  aiStates?: Record<string, AIStateDTO>;
  planetSurfaceDescriptorsByBodyId?: Record<string, PlanetSurfaceDescriptor>;
  groundBuildings?: GroundBuildingDTO[];
  settlementControl?: Record<string, SettlementControlState>;
  bombardedTilesByBodyId?: Record<string, number[]>;
  bombardedHexesByBodyId?: Record<string, HexCoord[]>;
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

export interface SaveFileV4 {
  version: 4;
  createdAt: string;
  state: GameStateDTO;
}

export interface SaveFileV5 {
  version: 5;
  createdAt: string;
  state: GameStateDTO;
}

export interface SaveFileV6 {
  version: 6;
  createdAt: string;
  state: GameStateDTO;
}

export interface SaveFileV7 {
  version: 7;
  createdAt: string;
  state: GameStateDTO;
}

export type SaveFile = SaveFileV2 | SaveFileV3 | SaveFileV4 | SaveFileV5 | SaveFileV6 | SaveFileV7;

export type DeserializeProgressDetail = { current: number; total: number };
export type DeserializeProgressUpdate = {
  stage: 'deserialize';
  progress: number;
  detail?: DeserializeProgressDetail;
};
export type DeserializeProgressReporter = (update: DeserializeProgressUpdate) => void;
export type DeserializeOptions = { onProgress?: DeserializeProgressReporter };

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

const estimateGalacticRadius = (systemsDto: unknown): number | undefined => {
  if (!Array.isArray(systemsDto)) return undefined;
  let maxR = 0;
  for (const s of systemsDto) {
    if (!s || typeof s !== 'object') continue;
    const p = (s as any).position;
    if (!p || typeof p !== 'object') continue;
    const x = (p as any).x;
    const z = (p as any).z;
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const r = Math.sqrt(x * x + z * z);
    if (r > maxR) maxR = r;
  }
  return maxR > 0 ? maxR : undefined;
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
const STATION_TYPES = new Set<StationType>(['shipyard', 'mining', 'defense', 'relay', 'outpost']);
const BATTLE_STATUSES = new Set<BattleStatus>(['scheduled', 'resolved']);
const STELLAR_AGE_CLASSES = new Set(['young', 'mid', 'old']);

const isEnumValue = <T>(set: Set<T>, value: unknown): value is T => set.has(value as T);
const normalizeShipType = (value: unknown): ShipType | null => {
  if (value === 'troop_transport') return ShipType.TRANSPORTER;
  return isEnumValue(SHIP_TYPES, value) ? (value as ShipType) : null;
};

const clampText = (value: unknown, maxLength: number, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
};

const clampArray = <T>(
  items: T[],
  max: number,
  label: string,
  sliceFromEnd = false,
  logLevel: 'warn' | 'info' = 'warn'
): T[] => {
  if (items.length <= max) return items;
  const log = logLevel === 'info' ? logger.info : logger.warn;
  log(`[Serialization] ${label} truncated from ${items.length} to ${max}.`);
  return sliceFromEnd ? items.slice(-max) : items.slice(0, max);
};

const isStarOrbitCore = (orbit: unknown): orbit is StarOrbit => {
  if (!orbit || typeof orbit !== 'object') return false;
  const o: any = orbit;
  return isFiniteNumber(o.semiMajorAxisAu)
    && isFiniteNumber(o.periodDays)
    && isFiniteNumber(o.phaseDeg)
    && isFiniteNumber(o.inclinationDeg)
    && isFiniteNumber(o.ascendingNodeDeg);
};

const needsStarOrbitNormalization = (orbit: StarOrbit | undefined): boolean => (
  !orbit
  || !isFiniteNumber(orbit.argPeriapsisDeg)
  || !isFiniteNumber(orbit.meanAnomalyAtEpochDeg)
  || (orbit.eccentricity !== undefined && !isFiniteNumber(orbit.eccentricity))
);

const needsMoonOrbitNormalization = (moon: MoonData): boolean => (
  !isFiniteNumber(moon.orbitEccentricity)
  || !isFiniteNumber(moon.orbitInclinationDeg)
  || !isFiniteNumber(moon.orbitAscendingNodeDeg)
  || !isFiniteNumber(moon.argPeriapsisDeg)
  || !isFiniteNumber(moon.meanAnomalyAtEpochDeg)
);

const normalizeMoonOrbitParams = (moon: MoonData, rng: RNG): MoonData => {
  if (!needsMoonOrbitNormalization(moon)) return moon;
  const orbitDistanceRp = isFiniteNumber(moon.orbitDistanceRp) ? moon.orbitDistanceRp : 20;
  const defaults = drawMoonOrbitParams(rng, moon.type, orbitDistanceRp);
  return {
    ...moon,
    orbitEccentricity: isFiniteNumber(moon.orbitEccentricity) ? moon.orbitEccentricity : defaults.orbitEccentricity,
    orbitInclinationDeg: isFiniteNumber(moon.orbitInclinationDeg) ? moon.orbitInclinationDeg : defaults.orbitInclinationDeg,
    orbitAscendingNodeDeg: isFiniteNumber(moon.orbitAscendingNodeDeg) ? moon.orbitAscendingNodeDeg : defaults.orbitAscendingNodeDeg,
    argPeriapsisDeg: isFiniteNumber(moon.argPeriapsisDeg) ? moon.argPeriapsisDeg : defaults.argPeriapsisDeg,
    meanAnomalyAtEpochDeg: isFiniteNumber(moon.meanAnomalyAtEpochDeg)
      ? moon.meanAnomalyAtEpochDeg
      : defaults.meanAnomalyAtEpochDeg
  };
};

const needsPlanetOrbitNormalization = (planet: PlanetData): boolean => (
  !isFiniteNumber(planet.orbitInclinationDeg)
  || !isFiniteNumber(planet.orbitAscendingNodeDeg)
  || !isFiniteNumber(planet.argPeriapsisDeg)
  || !isFiniteNumber(planet.meanAnomalyAtEpochDeg)
  || !isFiniteNumber(planet.axialTiltDeg)
  || (Array.isArray(planet.moons) && planet.moons.some(needsMoonOrbitNormalization))
);

const normalizePlanetOrbitParams = (
  planet: PlanetData,
  planetIndex: number,
  seed: number,
  defaults: {
    orbitInclinationDeg: number;
    orbitAscendingNodeDeg: number;
    argPeriapsisDeg: number;
    meanAnomalyAtEpochDeg: number;
    axialTiltDeg: number;
  }
): PlanetData => {
  if (!needsPlanetOrbitNormalization(planet)) return planet;
  const moonOrbitRng = new RNG(deriveSeed32(seed, 'moon_orbits', planetIndex));
  const moonsSource = Array.isArray(planet.moons) ? planet.moons : [];
  const moons = moonsSource.map(moon => normalizeMoonOrbitParams(moon, moonOrbitRng));

  return {
    ...planet,
    orbitInclinationDeg: isFiniteNumber(planet.orbitInclinationDeg) ? planet.orbitInclinationDeg : defaults.orbitInclinationDeg,
    orbitAscendingNodeDeg: isFiniteNumber(planet.orbitAscendingNodeDeg) ? planet.orbitAscendingNodeDeg : defaults.orbitAscendingNodeDeg,
    argPeriapsisDeg: isFiniteNumber(planet.argPeriapsisDeg) ? planet.argPeriapsisDeg : defaults.argPeriapsisDeg,
    meanAnomalyAtEpochDeg: isFiniteNumber(planet.meanAnomalyAtEpochDeg)
      ? planet.meanAnomalyAtEpochDeg
      : defaults.meanAnomalyAtEpochDeg,
    axialTiltDeg: isFiniteNumber(planet.axialTiltDeg) ? planet.axialTiltDeg : defaults.axialTiltDeg,
    moons
  };
};

const needsMoonSeasonalNormalization = (moon: MoonData): boolean => !isFiniteNumber(moon.seasonalDeltaK);

const normalizeMoonSeasonalDelta = (
  moon: MoonData,
  planet: PlanetData,
  luminosityTotalLSun: number
): MoonData => {
  if (!needsMoonSeasonalNormalization(moon)) return moon;
  const seasonalDeltaK = computeMoonSeasonalDeltaK({
    luminosityTotalLSun,
    hostSemiMajorAxisAu: planet.semiMajorAxisAu,
    hostEccentricity: planet.eccentricity,
    orbitEccentricity: isFiniteNumber(moon.orbitEccentricity) ? moon.orbitEccentricity : 0,
    orbitDistanceRp: moon.orbitDistanceRp,
    albedo: moon.albedo,
    teqK: moon.teqK,
    tidalBonusK: moon.tidalBonusK,
    airMassIndex: moon.airMassIndex
  });
  return {
    ...moon,
    seasonalDeltaK
  };
};

const needsPlanetSeasonalNormalization = (planet: PlanetData): boolean => (
  !isFiniteNumber(planet.seasonalDeltaK)
  || (Array.isArray(planet.moons) && planet.moons.some(needsMoonSeasonalNormalization))
);

const normalizePlanetSeasonalDelta = (
  planet: PlanetData,
  luminosityTotalLSun: number
): PlanetData => {
  if (!needsPlanetSeasonalNormalization(planet)) return planet;
  const seasonalDeltaK = isFiniteNumber(planet.seasonalDeltaK)
    ? planet.seasonalDeltaK
    : computePlanetSeasonalDeltaK({
        luminosityTotalLSun,
        semiMajorAxisAu: planet.semiMajorAxisAu,
        eccentricity: planet.eccentricity,
        albedo: planet.albedo,
        teqK: planet.teqK,
        axialTiltDeg: isFiniteNumber(planet.axialTiltDeg) ? planet.axialTiltDeg : 0,
        airMassIndex: planet.airMassIndex
      });
  const moonsSource = Array.isArray(planet.moons) ? planet.moons : [];
  const moons = moonsSource.map(moon => normalizeMoonSeasonalDelta(moon, planet, luminosityTotalLSun));

  return {
    ...planet,
    seasonalDeltaK,
    moons
  };
};

const needsMoonClimateNormalization = (moon: MoonData): boolean => (
  !isFiniteNumber(moon.climateK)
  || !isFiniteNumber(moon.greenhouseK)
  || !isFiniteNumber(moon.airMassIndex)
  || !isFiniteNumber(moon.temperatureK)
);

const normalizeMoonClimate = (moon: MoonData): MoonData => {
  const needsClimate = !isFiniteNumber(moon.climateK) && !isFiniteNumber(moon.temperatureK);
  const needsAirMass = !isFiniteNumber(moon.airMassIndex);
  const computed = needsClimate || needsAirMass
    ? computeMoonClimate({
        teqK: moon.teqK,
        atmosphere: moon.atmosphere,
        pressureBar: moon.pressureBar,
        tidalBonusK: moon.tidalBonusK
      })
    : undefined;

  const climateK = isFiniteNumber(moon.climateK)
    ? moon.climateK
    : isFiniteNumber(moon.temperatureK)
      ? moon.temperatureK
      : computed!.climateK;
  const greenhouseK = isFiniteNumber(moon.greenhouseK)
    ? moon.greenhouseK
    : Math.max(0, climateK - moon.teqK - (moon.tidalBonusK ?? 0));
  const airMassIndex = isFiniteNumber(moon.airMassIndex)
    ? moon.airMassIndex
    : computed!.airMassIndex;
  const temperatureK = isFiniteNumber(moon.temperatureK) ? moon.temperatureK : climateK;

  if (
    climateK === moon.climateK
    && greenhouseK === moon.greenhouseK
    && airMassIndex === moon.airMassIndex
    && temperatureK === moon.temperatureK
  ) {
    return moon;
  }

  return {
    ...moon,
    climateK,
    greenhouseK,
    airMassIndex,
    temperatureK
  };
};

const needsPlanetClimateNormalization = (planet: PlanetData): boolean => (
  !isFiniteNumber(planet.climateK)
  || !isFiniteNumber(planet.greenhouseK)
  || !isFiniteNumber(planet.airMassIndex)
  || !isFiniteNumber(planet.temperatureK)
  || (Array.isArray(planet.moons) && planet.moons.some(needsMoonClimateNormalization))
);

const normalizePlanetClimate = (planet: PlanetData): PlanetData => {
  const needsClimate = !isFiniteNumber(planet.climateK) && !isFiniteNumber(planet.temperatureK);
  const needsAirMass = !isFiniteNumber(planet.airMassIndex);
  const computed = needsClimate || needsAirMass
    ? computePlanetClimate({
        teqK: planet.teqK,
        atmosphere: planet.atmosphere,
        pressureBar: planet.pressureBar
      })
    : undefined;

  const climateK = isFiniteNumber(planet.climateK)
    ? planet.climateK
    : isFiniteNumber(planet.temperatureK)
      ? planet.temperatureK
      : computed!.climateK;
  const greenhouseK = isFiniteNumber(planet.greenhouseK)
    ? planet.greenhouseK
    : Math.max(0, climateK - planet.teqK);
  const airMassIndex = isFiniteNumber(planet.airMassIndex)
    ? planet.airMassIndex
    : computed!.airMassIndex;
  const temperatureK = isFiniteNumber(planet.temperatureK) ? planet.temperatureK : climateK;

  const moonsSource = Array.isArray(planet.moons) ? planet.moons : [];
  const moons = moonsSource.some(needsMoonClimateNormalization)
    ? moonsSource.map(moon => (needsMoonClimateNormalization(moon) ? normalizeMoonClimate(moon) : moon))
    : moonsSource;

  if (
    climateK === planet.climateK
    && greenhouseK === planet.greenhouseK
    && airMassIndex === planet.airMassIndex
    && temperatureK === planet.temperatureK
    && moons === planet.moons
  ) {
    return planet;
  }

  return {
    ...planet,
    climateK,
    greenhouseK,
    airMassIndex,
    temperatureK,
    moons
  };
};

const normalizeStarSystemAstro = (astro: StarSystemAstro): StarSystemAstro => {
  if (!Array.isArray(astro.stars) || astro.stars.length === 0) return astro;
  const primaryMassSun = isFiniteNumber(astro.stars[0]?.massSun) ? astro.stars[0].massSun : 1;
  const companionStars = astro.stars.slice(1);
  const needsOrbit = companionStars.some(star => !isStarOrbitCore(star?.orbit) || needsStarOrbitNormalization(star?.orbit));
  const needsPlanetOrbit = astro.planets.some(needsPlanetOrbitNormalization);
  const needsPlanetClimate = astro.planets.some(needsPlanetClimateNormalization);
  const needsPlanetSeasonal = astro.planets.some(needsPlanetSeasonalNormalization);
  if (!needsOrbit && !needsPlanetOrbit && !needsPlanetClimate && !needsPlanetSeasonal) return astro;

  const orbitRng = new RNG(deriveSeed32(astro.seed, 'star_orbits'));
  const companionMasses = companionStars.map(star => (isFiniteNumber(star?.massSun) ? star.massSun : 1));
  const companionOrbits = drawCompanionOrbits(orbitRng, primaryMassSun, companionMasses);
  const normalizedStars = astro.stars.map((star, index) => {
    if (index === 0) return star;
    const orbitDefaults = companionOrbits[index - 1];
    if (!orbitDefaults) return star;
    if (!isStarOrbitCore(star.orbit)) {
      return { ...star, orbit: orbitDefaults };
    }
    if (!needsStarOrbitNormalization(star.orbit)) return star;
    return {
      ...star,
      orbit: {
        ...star.orbit,
        eccentricity: isFiniteNumber(star.orbit.eccentricity)
          ? star.orbit.eccentricity
          : orbitDefaults.eccentricity ?? 0,
        argPeriapsisDeg: isFiniteNumber(star.orbit.argPeriapsisDeg) ? star.orbit.argPeriapsisDeg : orbitDefaults.argPeriapsisDeg,
        meanAnomalyAtEpochDeg: isFiniteNumber(star.orbit.meanAnomalyAtEpochDeg)
          ? star.orbit.meanAnomalyAtEpochDeg
          : orbitDefaults.meanAnomalyAtEpochDeg
      }
    };
  });
  const orbitDefaults = needsPlanetOrbit
    ? generatePlanetOrbitParams(astro.seed, astro.planets.map(planet => planet.type))
    : [];
  const normalizedPlanets = astro.planets.map((planet, index) => {
    const defaults = orbitDefaults[index] ?? {
      orbitInclinationDeg: 0,
      orbitAscendingNodeDeg: 0,
      argPeriapsisDeg: 0,
      meanAnomalyAtEpochDeg: 0,
      axialTiltDeg: 0
    };
    const withOrbits = needsPlanetOrbit ? normalizePlanetOrbitParams(planet, index, astro.seed, defaults) : planet;
    const withClimate = needsPlanetClimateNormalization(withOrbits)
      ? normalizePlanetClimate(withOrbits)
      : withOrbits;
    return needsPlanetSeasonalNormalization(withClimate)
      ? normalizePlanetSeasonalDelta(withClimate, astro.derived.luminosityTotalLSun)
      : withClimate;
  });

  return {
    ...astro,
    starCount: normalizedStars.length,
    stars: normalizedStars,
    planets: normalizedPlanets
  };
};

const sanitizeStarSystemAstro = (astro: unknown): StarSystemAstro | undefined => {
  if (!astro || typeof astro !== 'object') return undefined;
  const a: any = astro;

  if (!isFiniteNumber(a.seed)) return undefined;
  if (typeof a.primarySpectralType !== 'string') return undefined;
  if (!isFiniteNumber(a.starCount)) return undefined;
  if (!isFiniteNumber(a.metallicityFeH)) return undefined;
  if (a.stellarAgeGyr !== undefined && !isFiniteNumber(a.stellarAgeGyr)) return undefined;
  if (a.stellarAgeClass !== undefined && !STELLAR_AGE_CLASSES.has(a.stellarAgeClass)) return undefined;
  if (!a.derived || typeof a.derived !== 'object') return undefined;
  if (!isFiniteNumber(a.derived.luminosityTotalLSun)) return undefined;
  if (!isFiniteNumber(a.derived.snowLineAu)) return undefined;
  if (!isFiniteNumber(a.derived.hzInnerAu)) return undefined;
  if (!isFiniteNumber(a.derived.hzOuterAu)) return undefined;
  if (!Array.isArray(a.stars)) return undefined;
  if (!Array.isArray(a.planets)) return undefined;

  return normalizeStarSystemAstro(a as StarSystemAstro);
};

const restoreAstro = (
  astro: unknown,
  worldSeed: number | undefined,
  systemId: string | undefined,
  systemPosition: Vec3 | undefined,
  galacticRadius: number | undefined
): StarSystemAstro | undefined => {
  const sanitized = sanitizeStarSystemAstro(astro);
  if (sanitized) return sanitized;
  if (isFiniteNumber(worldSeed) && typeof systemId === 'string' && systemId.length > 0) {
    if (astro) {
      console.warn(`[Serialization] Astro data for system '${systemId}' was invalid; regenerating from seed.`);
    }
    return generateStellarSystem({
      worldSeed,
      systemId,
      systemPosition,
      galacticRadius
    });
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
      timeMs: isFiniteNumber(entry?.timeMs)
        ? entry.timeMs
        : isFiniteNumber(entry?.day)
          ? entry.day * MS_PER_DAY
          : isFiniteNumber(entry?.turn)
            ? entry.turn * MS_PER_DAY
            : 0,
      targetId: typeof entry?.targetId === 'string' ? entry.targetId : 'unknown',
      targetType: normalizeShipType(entry?.targetType) ?? ShipType.FRIGATE,
      targetFactionId: entry?.targetFactionId ?? 'unknown'
    }))
    .filter((entry): entry is ShipKillRecord => Boolean(entry.targetId));
};

const sanitizeLogEntry = (entry: any, index: number): LogEntry | null => {
  const id = typeof entry?.id === 'string' ? entry.id : `log-${index}`;
  const timeMs = isFiniteNumber(entry?.timeMs)
    ? entry.timeMs
    : isFiniteNumber(entry?.day)
      ? entry.day * MS_PER_DAY
      : isFiniteNumber(entry?.turn)
        ? entry.turn * MS_PER_DAY
        : 0;
  const text = clampText(entry?.text, MAX_LOG_TEXT_LENGTH, '');
  const type = entry?.type;
  const normalizedType = type === 'info' || type === 'combat' || type === 'move' || type === 'ai'
    ? type
    : 'info';

  if (!text) return null;

  return { id, timeMs, text, type: normalizedType };
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

const sanitizeSettlementControl = (
  value: unknown,
  validFactionIds: Set<FactionId>
): Record<string, SettlementControlState> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error("Field 'settlementControl' must be an object.");
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, SettlementControlState> = {};
  Object.entries(record).forEach(([key, entry]) => {
    if (!entry || typeof entry !== 'object') return;
    const raw: any = entry;
    const factionId =
      raw.factionId === null
        ? null
        : (typeof raw.factionId === 'string' && validFactionIds.has(raw.factionId) ? raw.factionId : null);
    const lastCaptureTimeMs = isFiniteNumber(raw.lastCaptureTimeMs)
      ? Math.max(0, Math.floor(raw.lastCaptureTimeMs))
      : isFiniteNumber(raw.lastCaptureTurn)
        ? Math.max(0, Math.floor(raw.lastCaptureTurn)) * MS_PER_DAY
        : 0;
    out[key] = { factionId, lastCaptureTimeMs };
  });
  return Object.keys(out).length > 0 ? out : undefined;
};

const GROUND_BUILDING_TYPES = new Set<GroundBuildingType>(['city', 'outpost', 'factory', 'mine', 'fortification', 'bunker']);
const GROUND_BUILDING_TAGS = new Set<GroundBuildingTag>(['supply_node', 'fortification_light', 'bunker', 'anti_orbital']);

const sanitizeBombardedHexesByBodyId = (
  value: unknown,
  validBodyIds: Set<string>
): Record<string, HexCoord[]> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error("Field 'bombardedHexesByBodyId' must be an object.");
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, HexCoord[]> = {};
  Object.entries(record).forEach(([bodyId, entry]) => {
    if (!validBodyIds.has(bodyId)) return;
    if (!Array.isArray(entry)) return;
    const coords: HexCoord[] = [];
    entry.forEach(raw => {
      if (!raw || typeof raw !== 'object') return;
      const p: any = raw;
      if (!isFiniteNumber(p.q) || !isFiniteNumber(p.r)) return;
      coords.push({ q: Math.floor(p.q), r: Math.floor(p.r) });
    });
    if (coords.length > 0) {
      out[bodyId] = coords;
    }
  });
  return Object.keys(out).length > 0 ? out : undefined;
};

const sanitizeBombardedTilesByBodyId = (
  value: unknown,
  validBodyIds: Set<string>,
  descriptors?: Record<string, PlanetSurfaceDescriptor>
): Record<string, number[]> | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error("Field 'bombardedTilesByBodyId' must be an object.");
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, number[]> = {};
  Object.entries(record).forEach(([bodyId, entry]) => {
    if (!validBodyIds.has(bodyId)) return;
    if (!Array.isArray(entry)) return;
    const descriptor = descriptors?.[bodyId];
    const maxCount = descriptor ? getSurfaceTileCount(descriptor) : null;
    const tiles: number[] = [];
    entry.forEach(raw => {
      if (!isFiniteNumber(raw)) return;
      const tileId = Math.floor(raw);
      if (tileId < 0) return;
      if (typeof maxCount === 'number' && tileId >= maxCount) return;
      tiles.push(tileId);
    });
    if (tiles.length > 0) {
      out[bodyId] = tiles;
    }
  });
  return Object.keys(out).length > 0 ? out : undefined;
};

const convertBombardedHexesToTiles = (
  legacy: Record<string, HexCoord[]> | undefined,
  descriptors?: Record<string, PlanetSurfaceDescriptor>
): Record<string, number[]> | undefined => {
  if (!legacy || !descriptors) return undefined;
  const out: Record<string, number[]> = {};
  Object.entries(legacy).forEach(([bodyId, coords]) => {
    const descriptor = descriptors[bodyId];
    if (!descriptor) return;
    const tiles: number[] = [];
    coords.forEach(coord => {
      const tileId = resolveSurfaceTileId(descriptor, { bodyId, q: coord.q, r: coord.r });
      if (tileId === null) return;
      tiles.push(tileId);
    });
    if (tiles.length > 0) {
      out[bodyId] = tiles;
    }
  });
  return Object.keys(out).length > 0 ? out : undefined;
};

const sanitizeSurfacePos = (value: unknown, validBodyIds: Set<string>): SurfacePos | null => {
  if (!value || typeof value !== 'object') return null;
  const p: any = value;
  if (typeof p.bodyId !== 'string' || !validBodyIds.has(p.bodyId)) return null;
  const tileId = isFiniteNumber(p.tileId) ? Math.floor(p.tileId) : undefined;
  const q = isFiniteNumber(p.q) ? Math.floor(p.q) : undefined;
  const r = isFiniteNumber(p.r) ? Math.floor(p.r) : undefined;
  const hasQr = q !== undefined && r !== undefined;
  if (tileId === undefined && !hasQr) return null;
  if ((q !== undefined) !== (r !== undefined)) return null;
  return {
    bodyId: p.bodyId,
    ...(tileId !== undefined ? { tileId } : {}),
    ...(hasQr ? { q, r } : {})
  };
};

const GROUND_UNIT_TYPES = new Set<GroundUnitType>([
  'light_infantry',
  'mechanized_infantry',
  'heavy_armor',
  'artillery'
]);

const GROUND_POSTURES = new Set<GroundPosture>(['normal', 'prepared_defense']);

const sanitizeGroundMoveOrder = (
  value: unknown,
  validBodyIds: Set<string>
): GroundMoveOrder | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const o: any = value;
  const to = sanitizeSurfacePos(o.to, validBodyIds);
  if (!to) return undefined;
  return { type: 'move', to };
};

const sanitizeGroundAttackOrder = (value: unknown): GroundAttackOrder | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const o: any = value;
  if (typeof o.targetArmyId !== 'string' || o.targetArmyId.length === 0) return undefined;
  return { type: 'attack', targetArmyId: o.targetArmyId };
};

const sanitizeGroundLandOrder = (
  value: unknown,
  validBodyIds: Set<string>
): GroundLandOrder | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const o: any = value;
  const to = sanitizeSurfacePos(o.to, validBodyIds);
  if (!to) return undefined;
  return { type: 'land', to };
};

const sanitizeGroundOrders = (
  value: unknown,
  validBodyIds: Set<string>
): GroundOrders | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return undefined;
  const raw: any = value;
  const move = sanitizeGroundMoveOrder(raw.move, validBodyIds);
  const attack = sanitizeGroundAttackOrder(raw.attack);
  if (!move && !attack) return undefined;
  return { ...(move ? { move } : {}), ...(attack ? { attack } : {}) };
};

const sanitizeGroundOrder = (
  value: unknown,
  validBodyIds: Set<string>
): GroundOrder | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return undefined;
  const o: any = value;
  if (o.type === 'move') {
    return sanitizeGroundMoveOrder(o, validBodyIds);
  }
  if (o.type === 'attack') {
    return sanitizeGroundAttackOrder(o);
  }
  return undefined;
};

const toGroundOrders = (order: GroundOrder | undefined): GroundOrders | undefined => {
  if (!order) return undefined;
  return order.type === 'move' ? { move: order } : { attack: order };
};

const sanitizeGroundBuildings = (
  value: unknown,
  validBodyIds: Set<string>,
  validFactionIds: Set<FactionId>
): GroundBuilding[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Field 'groundBuildings' must be an array.");
  }
  const out: GroundBuilding[] = [];
  value.forEach((entry: any, index: number) => {
    if (typeof entry?.id !== 'string') {
      console.warn(`[Serialization] GroundBuilding entry at index ${index} missing id; skipping.`);
      return;
    }
    if (typeof entry.factionId !== 'string' || !validFactionIds.has(entry.factionId)) return;
    if (!GROUND_BUILDING_TYPES.has(entry.type)) return;
    const surfacePos = sanitizeSurfacePos(entry.surfacePos, validBodyIds);
    if (!surfacePos) return;
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((tag: unknown): tag is GroundBuildingTag => typeof tag === 'string' && GROUND_BUILDING_TAGS.has(tag as GroundBuildingTag))
      : undefined;
    const antiOrbital = isFiniteNumber(entry.antiOrbital) ? Math.max(0, entry.antiOrbital) : undefined;

    out.push({
      id: entry.id,
      factionId: entry.factionId,
      type: entry.type,
      surfacePos,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(antiOrbital !== undefined ? { antiOrbital } : {})
    });
  });
  return out.length > 0 ? out : undefined;
};

const sanitizeSettlementConfig = (value: unknown): SettlementGenerationConfig | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw: any = value;
  const out: SettlementGenerationConfig = {};
  const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));

  if (isFiniteNumber(raw.neutralOutpostChance)) {
    out.neutralOutpostChance = clamp(raw.neutralOutpostChance, 0, 1);
  }
  if (isFiniteNumber(raw.neutralOutpostRuinsChance)) {
    out.neutralOutpostRuinsChance = clamp(raw.neutralOutpostRuinsChance, 0, 1);
  }
  if (isFiniteNumber(raw.developmentBias)) {
    out.developmentBias = clamp(raw.developmentBias, -1, 1);
  }

  return Object.keys(out).length > 0 ? out : undefined;
};

const sanitizePlanetSurfaceDescriptor = (value: unknown): PlanetSurfaceDescriptor | null => {
  if (!value || typeof value !== 'object') return null;
  const d: any = value;

  if (!isFiniteNumber(d.seed)) return null;
  const config = d.config;
  if (!config || typeof config !== 'object') return null;

  const gridKind = (config as any).gridKind;
  const frequency = (config as any).frequency;
  const w = (config as any).w;
  const h = (config as any).h;
  const wrapX = (config as any).wrapX;
  const generatorVersion = (config as any).generatorVersion;
  if (!isFiniteNumber(generatorVersion) || generatorVersion <= 0) return null;
  if (gridKind === 'geodesic') {
    if (!isFiniteNumber(frequency) || frequency <= 0) return null;
  } else {
    if (!isFiniteNumber(w) || w <= 0) return null;
    if (!isFiniteNumber(h) || h <= 0) return null;
    if (typeof wrapX !== 'boolean') return null;
  }

  const astroRef = d.astroRef;
  if (!astroRef || typeof astroRef !== 'object') return null;
  const planetIndex = (astroRef as any).planetIndex;
  const moonIndex = (astroRef as any).moonIndex;
  if (!isFiniteNumber(planetIndex) || planetIndex < 0) return null;
  if (moonIndex !== undefined && (!isFiniteNumber(moonIndex) || moonIndex < 0)) return null;

  const settlementConfig = sanitizeSettlementConfig(d.settlementConfig);

  return {
    seed: (d.seed >>> 0),
    config: {
      ...(gridKind === 'geodesic'
        ? { gridKind: 'geodesic', frequency: Math.floor(frequency) }
        : { w: Math.floor(w), h: Math.floor(h), wrapX }),
      generatorVersion: Math.floor(generatorVersion)
    },
    astroRef: {
      planetIndex: Math.floor((astroRef as any).planetIndex),
      moonIndex: (astroRef as any).moonIndex !== undefined ? Math.floor((astroRef as any).moonIndex) : undefined
    },
    settlementConfig: settlementConfig ?? undefined
  };
};

const sanitizePlanetSurfaceDescriptorRecord = (
  value: unknown,
  validBodyIds: Set<string>
): Record<string, PlanetSurfaceDescriptor> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const out: Record<string, PlanetSurfaceDescriptor> = {};

  Object.entries(record).forEach(([bodyId, entry]) => {
    if (!validBodyIds.has(bodyId)) {
      console.warn(`[Serialization] Surface descriptor references unknown body '${bodyId}'; skipping.`);
      return;
    }
    const desc = sanitizePlanetSurfaceDescriptor(entry);
    if (!desc) {
      console.warn(`[Serialization] Surface descriptor for body '${bodyId}' was invalid; skipping.`);
      return;
    }
    out[bodyId] = desc;
  });

  return Object.keys(out).length > 0 ? out : undefined;
};

/**
 * Backfill missing planet surface descriptors.
 *
 * Why this exists:
 * - Older save files (or debug fixtures) may predate the introduction of
 *   `planetSurfaceDescriptorsByBodyId`.
 * - Surface operations and validations require descriptors to exist.
 *
 * We can reconstruct missing descriptors deterministically from (seed, systemId, bodyId)
 * without consuming RNG.
 */
const ensurePlanetSurfaceDescriptors = (params: {
  seed: number;
  systems: StarSystem[];
  existing?: Record<string, PlanetSurfaceDescriptor>;
}): Record<string, PlanetSurfaceDescriptor> | undefined => {
  const out: Record<string, PlanetSurfaceDescriptor> = { ...(params.existing ?? {}) };

  let created = 0;
  for (const system of params.systems) {
    for (const body of system.planets) {
      if (!body.isSolid) continue;
      if (out[body.id]) continue;
      out[body.id] = createPlanetSurfaceDescriptor({
        gameSeed: params.seed,
        systemId: system.id,
        body
      });
      created += 1;
    }
  }

  if (created > 0) {
    logger.info(
      `[Serialization] Backfilled ${created} missing planet surface descriptor(s). ` +
        'This save was likely created by an older version.'
    );
  }

  return Object.keys(out).length > 0 ? out : undefined;
};

const serializeAiState = (aiState?: AIState): AIStateDTO | undefined => {
  if (!aiState) return undefined;

  const sightings: Record<string, EnemySightingDTO> = {};
  Object.entries(aiState.sightings).forEach(([key, s]) => {
    sightings[key] = {
      ...s,
      lastUpdateTimeMs: s.lastUpdateTimeMs ?? s.timeSeenMs,
      position: serializeVector3(s.position)
    };
  });

  return {
    sightings,
    targetPriorities: aiState.targetPriorities,
    systemLastSeenTimeMs: aiState.systemLastSeenTimeMs,
    lastOwnerBySystemId: aiState.lastOwnerBySystemId,
    holdUntilTimeMsBySystemId: aiState.holdUntilTimeMsBySystemId
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

    const timeSeenMs = isFiniteNumber(s.timeSeenMs)
      ? s.timeSeenMs
      : isFiniteNumber(s.daySeen)
        ? s.daySeen * MS_PER_DAY
        : undefined;

    if (!isFiniteNumber(timeSeenMs) || !isFiniteNumber(s.estimatedPower) || !isFiniteNumber(s.confidence)) {
      return;
    }

    const systemId = typeof s.systemId === 'string' ? s.systemId : null;
    const confidence = Math.max(0, Math.min(1, s.confidence));
    const lastUpdateTimeMs = isFiniteNumber(s.lastUpdateTimeMs)
      ? s.lastUpdateTimeMs
      : isFiniteNumber(s.lastUpdateDay)
        ? s.lastUpdateDay * MS_PER_DAY
        : timeSeenMs;

    sightings[key] = {
      ...s,
      factionId,
      fleetId: typeof s.fleetId === 'string' ? s.fleetId : key,
      systemId,
      timeSeenMs,
      estimatedPower: s.estimatedPower,
      confidence,
      lastUpdateTimeMs,
      position: deserializeVector3(s.position, `AI sighting '${key}' position`)
    };
  });

  const holdSource =
    aiStateDto.holdUntilTimeMsBySystemId ?? (aiStateDto as any).holdUntilTurnBySystemId;
  const sanitizedHold = sanitizeNumberRecord(holdSource);
  if (!aiStateDto.holdUntilTimeMsBySystemId && (aiStateDto as any).holdUntilTurnBySystemId) {
    Object.keys(sanitizedHold).forEach(key => {
      sanitizedHold[key] = sanitizedHold[key] * MS_PER_DAY;
    });
  }
  Object.keys(sanitizedHold).forEach(key => {
    if (sanitizedHold[key] < 0) {
      delete sanitizedHold[key];
    }
  });

  return {
    sightings,
    targetPriorities: sanitizeNumberRecord(aiStateDto.targetPriorities),
    systemLastSeenTimeMs: (() => {
      const source = aiStateDto.systemLastSeenTimeMs ?? (aiStateDto as any).systemLastSeen;
      const sanitized = sanitizeNumberRecord(source);
      if (!aiStateDto.systemLastSeenTimeMs && (aiStateDto as any).systemLastSeen) {
        Object.keys(sanitized).forEach(key => {
          sanitized[key] = sanitized[key] * MS_PER_DAY;
        });
      }
      return sanitized;
    })(),
    lastOwnerBySystemId: sanitizeOwnerRecord(aiStateDto.lastOwnerBySystemId, validFactionIds),
    holdUntilTimeMsBySystemId: sanitizedHold
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

  const stationsDto = state.stations?.map((station) => ({
    id: station.id,
    systemId: station.systemId,
    factionId: station.factionId,
    type: station.type,
    name: station.name,
    anchorBodyId: station.anchorBodyId ?? null,
    slotIndex: Number.isFinite(station.slotIndex) ? station.slotIndex : undefined
  }));

  const stateDto: GameStateDTO = {
    scenarioId: state.scenarioId,
    scenarioTitle: state.scenarioTitle,
    playerFactionId: state.playerFactionId,
    factions: state.factions,
    seed: state.seed,
    rngState: state.rngState,
    idRngState: state.idRngState ?? state.rngState,
    startYear: state.startYear,
    timeMs: state.timeMs,
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
      invasionTargetPlanetId: f.invasionTargetPlanetId ?? null,
      loadTargetSystemId: f.loadTargetSystemId ?? null,
      unloadTargetSystemId: f.unloadTargetSystemId ?? null,
      ships: f.ships.map(s => ({
          id: s.id,
          type: s.type,
          hp: s.hp,
          maxHp: s.maxHp,
          fuel: s.fuel,
          carriedArmyId: s.carriedArmyId || null,
          transferBusyUntilTimeMs: Number.isFinite(s.transferBusyUntilTimeMs) ? s.transferBusyUntilTimeMs : undefined,
          consumables: extractConsumables(s, s.type),
          offensiveMissilesLeft: s.offensiveMissilesLeft ?? s.consumables?.offensiveMissiles,
          torpedoesLeft: s.torpedoesLeft ?? s.consumables?.torpedoes,
          interceptorsLeft: s.interceptorsLeft ?? s.consumables?.interceptors,
          killHistory: sanitizeKillHistory(s.killHistory)
      }))
    })),
    stations: stationsDto && stationsDto.length > 0 ? stationsDto : undefined,
    armies: state.armies.map(a => ({
      id: a.id,
      factionId: a.factionId,
      unitType: a.unitType,
      posture: a.posture ?? 'normal',
      postureSetTimeMs: Number.isFinite(a.postureSetTimeMs) ? a.postureSetTimeMs : undefined,
      groundOrders: a.groundOrders,
      landingOrder: a.landingOrder,
      maxMembers: a.maxMembers,
      members: a.members,
      attack: a.attack,
      defense: a.defense,
      condition: a.condition,
      morale: a.morale,
      routed: a.routed ? true : undefined,
      fatigue: a.fatigue,
      rangeMin: a.rangeMin,
      rangeMax: a.rangeMax,
      projectionRange: a.projectionRange,
      lastDeployedTimeMs: Number.isFinite(a.lastDeployedTimeMs) ? a.lastDeployedTimeMs : undefined,
      lastCombatTimeMs: Number.isFinite(a.lastCombatTimeMs) ? a.lastCombatTimeMs : undefined,
      state: a.state,
      containerId: a.containerId,
      surfacePos: a.surfacePos
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
    winnerFactionId: state.winnerFactionId,
    aiState: aiStateDto,
    aiStates: aiStatesDto,
    planetSurfaceDescriptorsByBodyId: state.planetSurfaceDescriptorsByBodyId,
    groundBuildings: state.groundBuildings,
    settlementControl: state.settlementControl,
    bombardedTilesByBodyId: state.bombardedTilesByBodyId,
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

export const deserializeGameState = (json: string, options: DeserializeOptions = {}): GameState => {
  const onProgress = options.onProgress;
  const clampProgress = (value: number) => Math.max(0, Math.min(1, value));
  const reportProgress = (progress: number, detail?: DeserializeProgressDetail) => {
    if (!onProgress) return;
    onProgress({ stage: 'deserialize', progress: clampProgress(progress), detail });
  };
  const shouldReport = (index: number, total: number, every: number) =>
    index === 0 || index === total - 1 || index % every === 0;

  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error("File is not valid JSON.");
  }
  reportProgress(0);

  const saveVersion: number | undefined = raw && typeof raw === 'object' && raw.version !== undefined
    ? Number(raw.version)
    : undefined;

  if (saveVersion === undefined) {
    throw new Error('Save file is missing the version field.');
  }
  if (!isFiniteNumber(raw.version)) {
    throw new Error('Save file version must be a number.');
  }
  if (raw.version < 2 || raw.version > SAVE_VERSION) {
    throw new Error(`Save file version ${raw.version} is not supported (expected <= ${SAVE_VERSION}).`);
  }
  if (!raw.state) {
    throw new Error('Save file is missing the state payload.');
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
    const galacticRadius = estimateGalacticRadius(systemsDto);

    const systemsTotal = systemsDto.length;
    const fleetsTotal = Array.isArray(dto.fleets) ? dto.fleets.length : 0;
    const stationsTotal = Array.isArray(dto.stations) ? dto.stations.length : 0;
    const armiesTotal = Array.isArray(dto.armies) ? Math.min(dto.armies.length, MAX_ARMY_ENTRIES) : 0;
    const battlesTotal = Array.isArray(dto.battles) ? Math.min(dto.battles.length, MAX_BATTLE_ENTRIES) : 0;
    const logsTotal = Array.isArray(dto.logs) ? Math.min(dto.logs.length, MAX_LOG_ENTRIES) : 0;
    const messagesTotal = Array.isArray(dto.messages) ? Math.min(dto.messages.length, MAX_MESSAGE_ENTRIES) : 0;
    const totalUnits = Math.max(
      1,
      systemsTotal +
        fleetsTotal +
        stationsTotal +
        armiesTotal +
        battlesTotal +
        logsTotal +
        messagesTotal
    );
    let processed = 0;
    const reportEvery = (total: number) => Math.max(1, Math.floor(total / 50));
    const reportLoopProgress = (index: number, total: number) => {
      if (!onProgress || total <= 0) return;
      if (!shouldReport(index, total, reportEvery(total))) return;
      reportProgress((processed + index + 1) / totalUnits, { current: index + 1, total });
    };

    const systems: StarSystem[] = systemsDto.map((s: any, index: number) => {
      reportLoopProgress(index, systemsTotal);
      if (typeof s.id !== 'string' || typeof s.name !== 'string') {
        throw new Error('System entry is missing a valid id or name.');
      }
      const position = deserializeVector3(s.position, `system '${s.id ?? 'unknown'}' position`);
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

      const astro = restoreAstro(s.astro, worldSeed, s.id, position, galacticRadius);
      const planets = normalizePlanetBodies(
        { id: s.id, name: s.name, ownerFactionId },
        s.planets,
        astro
      );

      return {
        id: s.id,
        name: s.name,
        position,
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

    const systemIds = new Set(systems.map(system => system.id));
    processed += systemsTotal;

    // Fleets
    const fleetsDto = Array.isArray(dto.fleets) ? dto.fleets : [];
    if (dto.fleets !== undefined && !Array.isArray(dto.fleets)) {
      throw new Error("Field 'fleets' must be an array.");
    }
    if (dto.armies !== undefined && !Array.isArray(dto.armies)) {
      throw new Error("Field 'armies' must be an array.");
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
      reportLoopProgress(index, fleetsTotal);
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
          const normalizedType = normalizeShipType(ship.type);
          if (!normalizedType) {
            console.warn(`[Serialization] Ship '${ship.id}' has invalid type '${ship.type}'; skipping.`);
            return null;
          }

          const shipType = normalizedType;
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
          const transferBusyUntilTimeMs = isFiniteNumber(ship.transferBusyUntilTimeMs)
            ? ship.transferBusyUntilTimeMs
            : isFiniteNumber(ship.transferBusyUntilDay)
              ? ship.transferBusyUntilDay * MS_PER_DAY
              : undefined;

          return {
            id: ship.id,
            type: shipType,
            hp,
            maxHp,
            fuel,
            carriedArmyId: typeof ship.carriedArmyId === 'string' ? ship.carriedArmyId : null,
            transferBusyUntilTimeMs,
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
      const stateStartTimeMs = isFiniteNumber(f.stateStartTimeMs)
        ? f.stateStartTimeMs
        : isFiniteNumber(f.stateStartTurn)
          ? f.stateStartTurn * MS_PER_DAY
          : 0;

      const baseFleet: Fleet = {
        id: f.id,
        factionId,
        position: deserializeVector3(f.position, `fleet '${f.id ?? 'unknown'}' position`),
        state: fleetState,
        targetSystemId,
        targetPosition,
        stateStartTimeMs,
        retreating: f.retreating ?? false,
        invasionTargetSystemId: f.invasionTargetSystemId ?? null,
        invasionTargetPlanetId: f.invasionTargetPlanetId ?? null,
        loadTargetSystemId: f.loadTargetSystemId ?? null,
        unloadTargetSystemId: f.unloadTargetSystemId ?? null,
        ships: sanitizedShips
      };

      return baseFleet;
    });

    const fleetIds = new Set(fleets.map(fleet => fleet.id));
    processed += fleetsTotal;
    const planetIds = new Set(systems.flatMap(system => system.planets.map(planet => planet.id)));
    const planetSurfaceDescriptorsByBodyIdFromSave = sanitizePlanetSurfaceDescriptorRecord(
      dto.planetSurfaceDescriptorsByBodyId,
      planetIds
    );
    const groundBuildings = sanitizeGroundBuildings(dto.groundBuildings, planetIds, validFactionIds);
    const settlementControl = sanitizeSettlementControl(dto.settlementControl, validFactionIds);
    const bombardedTilesByBodyId = sanitizeBombardedTilesByBodyId(
      dto.bombardedTilesByBodyId,
      planetIds,
      planetSurfaceDescriptorsByBodyIdFromSave
    );
    const legacyBombardedHexes = sanitizeBombardedHexesByBodyId(dto.bombardedHexesByBodyId, planetIds);
    const bombardedTilesFromLegacy = convertBombardedHexesToTiles(
      legacyBombardedHexes,
      planetSurfaceDescriptorsByBodyIdFromSave
    );
    const resolvedBombardedTiles = bombardedTilesByBodyId ?? bombardedTilesFromLegacy;

    const stationsDto: unknown[] = Array.isArray(dto.stations) ? dto.stations : [];
    if (dto.stations !== undefined && !Array.isArray(dto.stations)) {
      throw new Error("Field 'stations' must be an array.");
    }
    const stations: Station[] = stationsDto
      .map((entry: any, index: number): Station | null => {
        reportLoopProgress(index, stationsTotal);
        if (typeof entry?.id !== 'string') {
          console.warn(`[Serialization] Station entry at index ${index} missing id; skipping.`);
          return null;
        }
        if (typeof entry.systemId !== 'string' || !systemIds.has(entry.systemId)) {
          console.warn(`[Serialization] Station '${entry.id}' references unknown system; skipping.`);
          return null;
        }
        const factionId = typeof entry.factionId === 'string' ? entry.factionId : entry.faction;
        if (typeof factionId !== 'string' || (validFactionIds && !validFactionIds.has(factionId))) {
          console.warn(`[Serialization] Station '${entry.id}' references unknown faction; skipping.`);
          return null;
        }
        if (!isEnumValue(STATION_TYPES, entry.type)) {
          console.warn(`[Serialization] Station '${entry.id}' has invalid type '${entry.type}'; skipping.`);
          return null;
        }
        const anchorBodyId = typeof entry.anchorBodyId === 'string' ? entry.anchorBodyId : null;
        if (anchorBodyId && !planetIds.has(anchorBodyId)) {
          console.warn(`[Serialization] Station '${entry.id}' references unknown anchor body; keeping id for consumers.`);
        }
        const slotIndex = isFiniteNumber(entry.slotIndex) ? entry.slotIndex : undefined;

        return {
          id: entry.id,
          systemId: entry.systemId,
          factionId,
          type: entry.type,
          name: typeof entry.name === 'string' ? entry.name : undefined,
          anchorBodyId,
          slotIndex
        };
      })
      .filter((station): station is Station => Boolean(station));
    processed += stationsTotal;

    // Armies
    const armiesDto = Array.isArray(dto.armies) ? dto.armies : [];
    const clampedArmiesDto = clampArray(armiesDto, MAX_ARMY_ENTRIES, 'armies');
    const armies: Army[] = clampedArmiesDto
      .map((a: any, index: number) => {
        reportLoopProgress(index, armiesTotal);
        if (typeof a?.id !== 'string') {
          console.warn(`[Serialization] Army entry at index ${index} missing id; skipping.`);
          return null;
        }
        const factionId = typeof a.factionId === 'string' ? a.factionId : a.faction;
        if (typeof factionId !== 'string') return null;
        if (validFactionIds && !validFactionIds.has(factionId)) return null;
        if (!isEnumValue(ARMY_STATES, a.state)) return null;
        if (typeof a.containerId !== 'string') return null;

        // --- V4 ground unit fields (with V3 migration) ---
        const unitType: GroundUnitType =
          typeof a.unitType === 'string' && GROUND_UNIT_TYPES.has(a.unitType as GroundUnitType)
            ? (a.unitType as GroundUnitType)
            : 'light_infantry';
        const defaults = GROUND_UNIT_STATS[unitType];

        const legacyMaxStrength = isFiniteNumber(a.maxStrength)
          ? a.maxStrength
          : (isFiniteNumber(a.strength) ? a.strength : null);
        const legacyStrength = isFiniteNumber(a.strength) ? a.strength : legacyMaxStrength;
        const legacyMorale = isFiniteNumber(a.morale) ? Math.max(0, Math.min(1, a.morale)) : 1;

        const maxMembersRaw =
          isFiniteNumber(a.maxMembers) ? a.maxMembers : legacyMaxStrength ?? defaults.defaultMaxMembers;
        if (!Number.isFinite(maxMembersRaw) || maxMembersRaw < 0) return null;
        const maxMembers = Math.floor(maxMembersRaw);

        const membersRaw =
          isFiniteNumber(a.members) ? a.members : legacyStrength ?? maxMembers;
        const members = Math.min(Math.max(Math.floor(membersRaw), 0), maxMembers);

        const attack = isFiniteNumber(a.attack) ? a.attack : defaults.baseAttack;
        const defense = isFiniteNumber(a.defense) ? a.defense : defaults.baseDefense;
        const condition = isFiniteNumber(a.condition) ? Math.max(0, Math.min(1, a.condition)) : legacyMorale;
        const morale = isFiniteNumber(a.morale) ? Math.max(0, Math.min(1, a.morale)) : defaults.baseMorale;
        const fatigue = isFiniteNumber(a.fatigue) ? Math.max(0, Math.min(1, a.fatigue)) : defaults.baseFatigue;

        const routedRaw = typeof a.routed === 'boolean' ? a.routed : undefined;
        let routed = routedRaw ?? false;
        if (morale < BREAK_THRESHOLD) routed = true;
        if (routedRaw === true && morale >= RALLY_THRESHOLD) routed = false;
        const rangeMin = isFiniteNumber(a.rangeMin) ? Math.max(0, Math.floor(a.rangeMin)) : defaults.rangeMin;
        const rangeMaxRaw = isFiniteNumber(a.rangeMax) ? Math.max(0, Math.floor(a.rangeMax)) : defaults.rangeMax;
        const rangeMax = Math.max(rangeMin, rangeMaxRaw);
        const projectionRange = isFiniteNumber(a.projectionRange) ? Math.max(0, Math.floor(a.projectionRange)) : defaults.projectionRange;

        const posture: GroundPosture | undefined =
          typeof a.posture === 'string' && GROUND_POSTURES.has(a.posture as GroundPosture)
            ? (a.posture as GroundPosture)
            : undefined;

        if (a.state === ArmyState.DEPLOYED && !planetIds.has(a.containerId)) return null;
        if (a.state !== ArmyState.DEPLOYED && !fleetIds.has(a.containerId)) return null;

        const surfacePos =
          a.state === ArmyState.DEPLOYED
            ? sanitizeSurfacePos(a.surfacePos, planetIds)
            : null;
        const normalizedSurfacePos =
          surfacePos && surfacePos.bodyId === a.containerId
            ? surfacePos
            : undefined;

        const legacyGroundOrder = sanitizeGroundOrder(a.groundOrder, planetIds);
        const groundOrders = sanitizeGroundOrders(a.groundOrders, planetIds) ?? toGroundOrders(legacyGroundOrder);
        const landingOrder = sanitizeGroundLandOrder(a.landingOrder, planetIds);
        const lastDeployedTimeMs = isFiniteNumber(a.lastDeployedTimeMs)
          ? Math.max(0, Math.floor(a.lastDeployedTimeMs))
          : isFiniteNumber(a.lastDeployedTurn)
            ? Math.max(0, Math.floor(a.lastDeployedTurn)) * MS_PER_DAY
            : undefined;
        const lastCombatTimeMs = isFiniteNumber(a.lastCombatTimeMs)
          ? Math.max(0, Math.floor(a.lastCombatTimeMs))
          : isFiniteNumber(a.lastCombatTurn)
            ? Math.max(0, Math.floor(a.lastCombatTurn)) * MS_PER_DAY
            : undefined;
        const postureSetTimeMs = isFiniteNumber(a.postureSetTimeMs)
          ? Math.max(0, Math.floor(a.postureSetTimeMs))
          : isFiniteNumber(a.postureSetTurn)
            ? Math.max(0, Math.floor(a.postureSetTurn)) * MS_PER_DAY
            : undefined;

        const baseArmy: Army = {
          id: a.id,
          factionId,
          unitType,
          posture,
          ...(postureSetTimeMs !== undefined ? { postureSetTimeMs } : {}),
          groundOrders,
          landingOrder,
          maxMembers,
          members,
          attack,
          defense,
          condition,
          morale,
          fatigue,
          ...(routed ? { routed } : {}),
          rangeMin,
          rangeMax,
          projectionRange,
          state: a.state,
          containerId: a.containerId,
          ...(normalizedSurfacePos ? { surfacePos: normalizedSurfacePos } : {}),
          ...(lastDeployedTimeMs !== undefined ? { lastDeployedTimeMs } : {}),
          ...(lastCombatTimeMs !== undefined ? { lastCombatTimeMs } : {})
        };

        return baseArmy;
      })
      .filter((army): army is Army => Boolean(army));
    processed += armiesTotal;

    // Battles
    const battlesDto = Array.isArray(dto.battles) ? dto.battles : [];
    const clampedBattlesDto = clampArray(battlesDto, MAX_BATTLE_ENTRIES, 'battles');
    const battles: Battle[] = [];

    clampedBattlesDto.forEach((b: any, index: number) => {
      reportLoopProgress(index, battlesTotal);
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
      const clampedLogs = clampArray(logs, MAX_BATTLE_LOGS, `battle logs for ${b.id}`, true, 'info');

      const timeCreatedMs = isFiniteNumber(b.timeCreatedMs)
        ? b.timeCreatedMs
        : isFiniteNumber(b.turnCreated)
          ? b.turnCreated * MS_PER_DAY
          : 0;
      const rawTimeResolvedMs = isFiniteNumber(b.timeResolvedMs)
        ? b.timeResolvedMs
        : isFiniteNumber(b.turnResolved)
          ? b.turnResolved * MS_PER_DAY
          : undefined;
      const timeResolvedMs = b.status === 'resolved' ? (rawTimeResolvedMs ?? timeCreatedMs) : rawTimeResolvedMs;

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
        timeCreatedMs,
        timeResolvedMs,
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
    processed += battlesTotal;

    const logsDto: unknown[] = Array.isArray(dto.logs) ? dto.logs : [];
    const normalizedLogs = logsDto
      .map((entry: unknown, index: number) => {
        reportLoopProgress(index, logsTotal);
        return sanitizeLogEntry(entry, index);
      })
      .filter((entry): entry is LogEntry => Boolean(entry));
    const sanitizedLogs = clampArray<LogEntry>(normalizedLogs, MAX_LOG_ENTRIES, 'logs', true, 'info');
    processed += logsTotal;

    const messagesDto = Array.isArray(dto.messages) ? dto.messages : [];
    const clampedMessagesDto = clampArray(messagesDto, MAX_MESSAGE_ENTRIES, 'messages', true, 'info');
    const messages: GameMessage[] = clampedMessagesDto.map((m: any, index: number) => {
      reportLoopProgress(index, messagesTotal);
      const timeMs = isFiniteNumber(m.timeMs)
        ? m.timeMs
        : isFiniteNumber(m.day)
          ? m.day * MS_PER_DAY
          : 0;
      const createdAtTimeMs = isFiniteNumber(m.createdAtTimeMs)
        ? m.createdAtTimeMs
        : isFiniteNumber(m.createdAtTurn)
          ? m.createdAtTurn * MS_PER_DAY
          : timeMs;
      return {
        id: typeof m.id === 'string' ? m.id : `message-${index}`,
        timeMs,
        type: clampText(m.type, MAX_MESSAGE_TYPE_LENGTH, 'generic'),
        priority: isFiniteNumber(m.priority) ? m.priority : 0,
        title: clampText(m.title, MAX_MESSAGE_TITLE_LENGTH, 'Untitled message'),
        subtitle: clampText(m.subtitle, MAX_MESSAGE_SUBTITLE_LENGTH, ''),
        lines: sanitizeMessageLines(m.lines),
        payload: sanitizeMessagePayload(m.payload),
        read: Boolean(m.read),
        dismissed: Boolean(m.dismissed),
        createdAtTimeMs
      };
    });
    processed += messagesTotal;

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

    const normalizedIdRngStateSource = dto.idRngState ?? normalizedRngState;
    const normalizedIdRngState = Number(normalizedIdRngStateSource);
    if (!Number.isFinite(normalizedIdRngState)) {
      throw new Error("Field 'idRngState' must be a finite number or derive from a valid 'rngState'.");
    }

    const startYear = Number.isFinite(dto.startYear) ? dto.startYear : 0;
    const timeMs = Number.isFinite(dto.timeMs)
      ? dto.timeMs
      : Number.isFinite(dto.day)
        ? dto.day * MS_PER_DAY
        : 0;

    const defaultRules: GameplayRules = {
      fogOfWar: true,
      aiEnabled: true,
      useAdvancedCombat: true,
      totalWar: true,
      unlimitedFuel: false
    };

    const planetSurfaceDescriptorsByBodyId = ensurePlanetSurfaceDescriptors({
      seed: normalizedSeed,
      systems,
      existing: planetSurfaceDescriptorsByBodyIdFromSave
    });

    const rawObjectives = dto.objectives ?? { conditions: [] };
    const objectiveConditions = Array.isArray(rawObjectives.conditions) ? rawObjectives.conditions : [];
    const maxTimeMs = isFiniteNumber(rawObjectives.maxTimeMs)
      ? rawObjectives.maxTimeMs
      : isFiniteNumber(rawObjectives.maxTurns)
        ? rawObjectives.maxTurns * MS_PER_DAY
        : undefined;

    const state: GameState = {
      scenarioId: dto.scenarioId || 'unknown',
      scenarioTitle: dto.scenarioTitle,
      playerFactionId,
      factions,
      seed: normalizedSeed,
      rngState: normalizedRngState,
      idRngState: normalizedIdRngState,
      startYear,
      timeMs,
      systems,
      fleets,
      stations,
      armies,
      battles,
      logs: sanitizedLogs,
      messages,
      winnerFactionId: dto.winnerFactionId !== undefined ? dto.winnerFactionId : (dto.winner || null),
      aiStates: migratedAiStates,
      aiState: primaryAiState,
      planetSurfaceDescriptorsByBodyId,
      groundBuildings,
      settlementControl,
      bombardedTilesByBodyId: resolvedBombardedTiles,
      objectives: { conditions: objectiveConditions, maxTimeMs },
      rules: { ...defaultRules, ...(dto.rules ?? {}) }
    };

    reportProgress(1);
    return normalizeSurfacePositions(state);
  } catch (e) {
    throw new Error(`Error reconstructing game state: ${(e as Error).message}`);
  }
};
