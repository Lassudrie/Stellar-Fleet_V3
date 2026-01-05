import {
  GameState,
  StarSystem,
  Fleet,
  ShipType,
  Army,
  ArmyState,
  FleetState,
  FactionState,
  ResourceType,
  WorldgenAuditCollector,
  WorldgenAuditLog,
  WorldgenAuditMode,
  devLog,
  devWarn,
  sorted
} from '../../shared/shared';
import { RNG } from '../rng';
import { GameScenario } from '../../content/scenarios';
import { createArmy, MIN_ARMY_CREATION_MEMBERS } from '../army';
import { createShip } from '../world';
import { computeFleetRadius } from '../fleetDerived';
import { vec3, clone, Vec3, distSq } from '../math/vec3';
import { SHIP_STATS } from '../../content/data/static';
import { generateStellarSystem } from './stellarSystem';
import { buildPlanetBodies, getSolidPlanets, PlanetBodySeed } from '../planets';
import { createPlanetSurfaceDescriptor, normalizeSurfacePositions, DEFAULT_PLANET_SURFACE_GENERATOR_VERSION } from '../planetSurface';

const CLUSTER_NEIGHBOR_COUNT = 4; // Number of extra systems for 'cluster' starting distribution

// --- World Gen Constraints ---
// Default requirement: ensure systems are not closer than 5 ly to avoid visual overlaps.
// Can be overridden / disabled per scenario via generation.minimumSystemSpacingLy (0 = disabled).
const DEFAULT_MINIMUM_SYSTEM_SPACING_LY = 5;

// Attempt budgets (defensive: avoid infinite loops on extreme/invalid configs).
const PRIMARY_POSITION_ATTEMPTS = 200;
const FALLBACK_POSITION_ATTEMPTS = 2000;
const BEST_EFFORT_FALLBACK_SAMPLES = 250;

type WorldgenProgressDetail = { current: number; total: number };

const deriveResourceTypeFromAstro = (astro?: StarSystem['astro']): ResourceType => {
  if (!astro) return 'none';
  const snowLineAu = astro.derived?.snowLineAu ?? 0;
  const planets = astro.planets ?? [];
  const hasGasRich =
    planets.some(p => p.type === 'GasGiant' || p.type === 'IceGiant') ||
    planets.some(p => p.type === 'SubNeptune' && p.semiMajorAxisAu > snowLineAu * 0.9);
  const hasVolatiles = planets.some(p => p.type === 'Dwarf' && p.semiMajorAxisAu > snowLineAu * 1.1);
  return hasGasRich || hasVolatiles ? 'gas' : 'none';
};
type WorldgenProgressUpdate = { stage: 'worldgen'; progress: number; detail?: WorldgenProgressDetail };
export type WorldgenProgressReporter = (update: WorldgenProgressUpdate) => void;
export type GenerateWorldOptions = { onProgress?: WorldgenProgressReporter; audit?: WorldgenAuditCollector };

export const createWorldgenAuditCollector = (
  scenario: GameScenario,
  mode: WorldgenAuditMode = 'summary'
): WorldgenAuditCollector => {
  const minimumSystemSpacingLyRaw = scenario.generation.minimumSystemSpacingLy;
  const minimumSystemSpacingLy =
    (typeof minimumSystemSpacingLyRaw === 'number' && Number.isFinite(minimumSystemSpacingLyRaw))
      ? Math.max(0, minimumSystemSpacingLyRaw)
      : DEFAULT_MINIMUM_SYSTEM_SPACING_LY;
  const surfaceGeneratorVersion =
    scenario.generation.surfaceGeneratorVersion ?? DEFAULT_PLANET_SURFACE_GENERATOR_VERSION;

  const staticSystems = scenario.generation.staticSystems
    ? sorted(scenario.generation.staticSystems, (a, b) => a.id.localeCompare(b.id)).map(def => ({
        id: def.id,
        name: def.name,
        position: vec3(def.position.x, def.position.y, def.position.z),
        resourceType: def.resourceType,
        planets: def.planets?.map(planet => ({
          id: planet.id,
          name: planet.name,
          bodyType: planet.bodyType,
          class: planet.class,
          size: planet.size,
          ownerFactionId: planet.ownerFactionId ?? null
        }))
      }))
    : [];

  const log: WorldgenAuditLog = {
    schemaVersion: 1,
    mode,
    meta: {
      scenarioId: scenario.id,
      scenarioTitle: scenario.meta.title,
      seed: scenario.seed,
      topology: scenario.generation.topology,
      radius: scenario.generation.radius,
      systemCountRequested: scenario.generation.systemCount,
      systemCountGenerated: 0,
      minimumSystemSpacingLy,
      surfaceGeneratorVersion,
      rngStartState: new RNG(scenario.seed).getState(),
      rngEndState: 0
    },
    inputs: {
      generation: {
        systemCount: scenario.generation.systemCount,
        radius: scenario.generation.radius,
        topology: scenario.generation.topology,
        minimumSystemSpacingLy: scenario.generation.minimumSystemSpacingLy,
        surfaceGeneratorVersion: scenario.generation.surfaceGeneratorVersion,
        settlements: scenario.generation.settlements,
        staticSystems: staticSystems.length > 0 ? staticSystems : undefined
      },
      setup: {
        startingDistribution: scenario.setup.startingDistribution,
        territoryAllocation: scenario.setup.territoryAllocation,
        factions: scenario.setup.factions.map(f => ({
          id: f.id,
          name: f.name,
          colorHex: f.colorHex,
          isPlayable: f.isPlayable,
          aiProfile: f.aiProfile
        })),
        initialFleetsCount: scenario.setup.initialFleets.length
      }
    },
    events: [],
    summaries: {
      systems: {
        total: 0,
        staticCount: 0,
        proceduralCount: 0,
        homeworldCount: 0,
        byResourceType: {
          gas: 0,
          none: 0
        },
        byOwnerFactionId: {},
        spacingFallbacks: {
          fallbackUsed: 0,
          bestEffortUsed: 0
        }
      },
      astro: {
        total: 0,
        missingAstroCount: 0,
        starCountHistogram: {},
        planetCountStats: { min: 0, max: 0, avg: 0 }
      },
      planets: {
        totalBodies: 0,
        planets: 0,
        moons: 0,
        solids: 0,
        fallbackBodies: 0,
        overrideCount: 0
      }
    }
  };

  let seq = 0;
  const emit: WorldgenAuditCollector['emit'] = event => {
    log.events.push({ seq, ...event });
    seq += 1;
  };

  return { mode, log, emit };
};

export const generateWorld = (
  scenario: GameScenario,
  options: GenerateWorldOptions = {}
): { state: GameState; rng: RNG } => {
  const rng = new RNG(scenario.seed);
  const audit = options.audit;
  const emit = audit?.emit;
  if (audit) {
    audit.log.meta.rngStartState = rng.getState();
  }
  const onProgress = options.onProgress;
  const clampProgress = (value: number) => Math.max(0, Math.min(1, value));
  const reportProgress = (progress: number, detail?: WorldgenProgressDetail) => {
    if (!onProgress) return;
    onProgress({ stage: 'worldgen', progress: clampProgress(progress), detail });
  };

  type WorldgenStep =
    | 'factions'
    | 'systems'
    | 'astro'
    | 'territories'
    | 'planets'
    | 'surface'
    | 'fleets'
    | 'garrisons'
    | 'finalize';

  const stepWeights: Record<WorldgenStep, number> = {
    factions: 0.05,
    systems: 0.25,
    astro: 0.15,
    territories: 0.1,
    planets: 0.15,
    surface: 0.1,
    fleets: 0.1,
    garrisons: 0.07,
    finalize: 0.03
  };

  const stepOrder: WorldgenStep[] = [
    'factions',
    'systems',
    'astro',
    'territories',
    'planets',
    'surface',
    'fleets',
    'garrisons',
    'finalize'
  ];

  const stepOffsets = stepOrder.reduce<Record<WorldgenStep, number>>((acc, step, index) => {
    if (index === 0) {
      acc[step] = 0;
      return acc;
    }
    const prev = stepOrder[index - 1];
    acc[step] = acc[prev] + stepWeights[prev];
    return acc;
  }, {} as Record<WorldgenStep, number>);

  const reportStep = (step: WorldgenStep, progress: number, detail?: WorldgenProgressDetail) => {
    reportProgress(stepOffsets[step] + stepWeights[step] * clampProgress(progress), detail);
  };

  const shouldReport = (index: number, total: number, every: number) =>
    index === 0 || index === total - 1 || index % every === 0;

  // --- 0. INITIALIZE FACTIONS ---
  const factions: FactionState[] = scenario.setup.factions.map(f => ({
      id: f.id,
      name: f.name,
      color: f.colorHex,
      isPlayable: f.isPlayable,
      aiProfile: f.aiProfile
  }));

  // Default player faction is the first playable one, or just the first one if none marked playable
  const playerFaction = factions.find(f => f.isPlayable) || factions[0];
  const playerFactionId = playerFaction.id;
  emit?.({
    step: 'factions',
    kind: 'factions_initialized',
    outputs: {
      playerFactionId,
      factions: factions.map(f => ({
        id: f.id,
        name: f.name,
        color: f.color,
        isPlayable: f.isPlayable,
        aiProfile: f.aiProfile
      }))
    }
  });
  reportStep('factions', 1);

  // --- 1. GENERATE SYSTEMS ---
  const systems: StarSystem[] = [];
  const radius = scenario.generation.radius;

  // --- 1.0 MINIMUM SYSTEM SPACING (Optional, Data-Driven) ---
  // Default: 5 (enabled). To disable for a specific scenario: set generation.minimumSystemSpacingLy = 0
  const minimumSystemSpacingLyRaw = scenario.generation.minimumSystemSpacingLy;
  const minimumSystemSpacingLy =
      (typeof minimumSystemSpacingLyRaw === 'number' && Number.isFinite(minimumSystemSpacingLyRaw))
          ? Math.max(0, minimumSystemSpacingLyRaw)
          : DEFAULT_MINIMUM_SYSTEM_SPACING_LY;

  const enforceMinimumSystemSpacing = minimumSystemSpacingLy > 0;
  const minimumSystemSpacingSq = minimumSystemSpacingLy * minimumSystemSpacingLy;
  if (audit) {
    audit.log.meta.minimumSystemSpacingLy = minimumSystemSpacingLy;
  }
  emit?.({
    step: 'systems',
    kind: 'system_spacing_config',
    outputs: {
      minimumSystemSpacingLy,
      enforceMinimumSystemSpacing
    }
  });
  
  // 1a. Static Systems (Overrides)
  const staticDefs = scenario.generation.staticSystems || [];
  const staticPlanetOverrides = new Map<string, PlanetBodySeed[]>();
  const staticNames = new Set<string>();
  const staticSystemIds = new Set<string>(staticDefs.map(def => def.id));

  staticDefs.forEach(def => {
    systems.push({
      id: def.id, // Use provided ID
      name: def.name,
      position: vec3(def.position.x, def.position.y, def.position.z),
      color: '#ffffff', // Will be updated if owned later
      size: 1.5, // Static systems are usually significant
      ownerFactionId: null,
      resourceType: def.resourceType,
      isHomeworld: false,
      planets: []
    });
    emit?.({
      step: 'systems',
      kind: 'static_system_added',
      entityId: def.id,
      outputs: {
        name: def.name,
        position: { x: def.position.x, y: def.position.y, z: def.position.z },
        resourceType: def.resourceType,
        planetsOverrideCount: def.planets?.length ?? 0
      }
    });
    staticNames.add(def.name);
    if (def.planets && def.planets.length > 0) {
      staticPlanetOverrides.set(def.id, def.planets);
    }
  });

  // Validate static systems spacing (static positions are not auto-adjusted).
  if (enforceMinimumSystemSpacing && systems.length > 1) {
    for (let a = 0; a < systems.length; a++) {
      for (let b = a + 1; b < systems.length; b++) {
        const d2 = distSq(systems[a].position, systems[b].position);
        if (d2 < minimumSystemSpacingSq) {
          const d = Math.sqrt(d2);
          devWarn(
            `[WorldGen] Static systems '${systems[a].name}' and '${systems[b].name}' are only ${d.toFixed(2)} ly apart (< ${minimumSystemSpacingLy}). ` +
            `Static positions are not auto-adjusted; consider updating scenario.generation.staticSystems.`
          );
          emit?.({
            step: 'systems',
            kind: 'static_spacing_violation',
            inputs: {
              systemAId: systems[a].id,
              systemBId: systems[b].id,
              distanceLy: d,
              minimumSystemSpacingLy
            }
          });
        }
      }
    }
  }

  // 1b. Procedural Systems
  const systemsToGenerate = Math.max(0, scenario.generation.systemCount - systems.length);
  
  // Prepare Topology Logic
  const topology = scenario.generation.topology;
  
  // For 'cluster' map topology, pre-calculate centers
  const mapClusterCenters: Vec3[] = [];
  if (topology === 'cluster') {
    const rngStateBefore = rng.getState();
    const clusterCount = rng.int(3, 5);
    for(let k=0; k<clusterCount; k++) {
        const r = rng.range(radius * 0.3, radius * 0.8);
        const theta = rng.next() * Math.PI * 2;
        mapClusterCenters.push(vec3(Math.cos(theta) * r, 0, Math.sin(theta) * r));
    }
    const rngStateAfter = rng.getState();
    emit?.({
      step: 'systems',
      kind: 'cluster_centers_generated',
      rngStateBefore,
      rngStateAfter,
      outputs: {
        count: clusterCount,
        centers: mapClusterCenters.map(center => ({ x: center.x, y: center.y, z: center.z }))
      }
    });
  }

  // Helper: Position Generator
  const getProceduralPosition = (index: number): Vec3 => {
      // 1. Spiral
      if (topology === 'spiral') {
          const armCount = 2 + (scenario.generation.systemCount > 60 ? 1 : 0); // 2 or 3 arms
          const armIndex = index % armCount;
          const armOffset = (armIndex * (Math.PI * 2)) / armCount;
          
          // Distribution along arm (biased towards center slightly)
          const d = Math.pow(rng.next(), 0.8) * radius; 
          
          // Twist calculation (tightness)
          const twist = 4.0; 
          const angle = armOffset + (d / radius) * twist + rng.range(-0.3, 0.3); // Add scatter to angle
          
          // Add scatter to radius (width of arm)
          const scatter = rng.gaussian() * (radius * 0.05);

          return vec3(
              Math.cos(angle) * (d + scatter),
              rng.range(-2, 2), // Slight verticality
              Math.sin(angle) * (d + scatter)
          );
      }

      // 2. Ring (Donut)
      if (topology === 'ring') {
          const r = rng.range(radius * 0.6, radius);
          const theta = rng.next() * Math.PI * 2;
          return vec3(
              Math.cos(theta) * r,
              rng.range(-1, 1),
              Math.sin(theta) * r
          );
      }

      // 3. Map Clusters (distinct blobs)
      if (topology === 'cluster') {
          const center = rng.pick(mapClusterCenters);
          // Safety guard: if no cluster centers exist, fall back to scattered
          if (!center) {
              devWarn('[WorldGen] No cluster centers available, falling back to scattered position');
              const r = Math.sqrt(rng.next()) * radius;
              const theta = rng.next() * Math.PI * 2;
              return vec3(Math.cos(theta) * r, rng.range(-5, 5), Math.sin(theta) * r);
          }
          // Gaussian distribution around center
          const spread = radius * 0.15;
          return vec3(
              center.x + rng.gaussian() * spread,
              rng.range(-1, 1),
              center.z + rng.gaussian() * spread
          );
      }

      // 4. Scattered (Default / Disk)
      // Uniform distribution in a circle requires sqrt of random for radius
      const r = Math.sqrt(rng.next()) * radius;
      const theta = rng.next() * Math.PI * 2;
      return vec3(
          Math.cos(theta) * r,
          rng.range(-5, 5), // More verticality for scattered
          Math.sin(theta) * r
      );
  };

  let spacingFallbackUsed = 0;
  let spacingBestEffortUsed = 0;

  type PositionPlacementMethod = 'topology' | 'fallback' | 'best_effort' | 'no_spacing';
  type PositionPlacement = {
      method: PositionPlacementMethod;
      primaryAttempts?: number;
      fallbackAttempts?: number;
      bestEffortSamples?: number;
      nearestDistanceLy?: number;
  };
  type PositionPlacementResult = { position: Vec3; placement: PositionPlacement };

  // --- Minimum System Spacing Helpers ---
  const getFallbackScatteredPosition = (): Vec3 => {
      // Uniform distribution in a circle requires sqrt of random for radius
      const r = Math.sqrt(rng.next()) * radius;
      const theta = rng.next() * Math.PI * 2;
      return vec3(
          Math.cos(theta) * r,
          rng.range(-5, 5),
          Math.sin(theta) * r
      );
  };

  const getMinDistSqToExistingSystems = (pos: Vec3): number => {
      if (systems.length === 0) return Infinity;

      let min = Infinity;
      for (const sys of systems) {
          const d2 = distSq(pos, sys.position);
          if (d2 < min) min = d2;

          // Early exit: already invalid
          if (min < minimumSystemSpacingSq) return min;
      }
      return min;
  };

  const isPositionValidWithSpacing = (pos: Vec3): boolean => {
      if (!enforceMinimumSystemSpacing) return true;
      return getMinDistSqToExistingSystems(pos) >= minimumSystemSpacingSq;
  };

  const getProceduralPositionWithMinSpacing = (index: number): PositionPlacementResult => {
      if (!enforceMinimumSystemSpacing) {
        return { position: getProceduralPosition(index), placement: { method: 'no_spacing' } };
      }

      // 1) Primary attempts: keep the requested topology
      for (let attempt = 0; attempt < PRIMARY_POSITION_ATTEMPTS; attempt++) {
          const p = getProceduralPosition(index);
          if (isPositionValidWithSpacing(p)) {
            const minDistSq = getMinDistSqToExistingSystems(p);
            return {
              position: p,
              placement: {
                method: 'topology',
                primaryAttempts: attempt + 1,
                nearestDistanceLy: Math.sqrt(Math.max(0, minDistSq))
              }
            };
          }
      }

      // 2) Fallback attempts: escape local density by sampling the full disk
      for (let attempt = 0; attempt < FALLBACK_POSITION_ATTEMPTS; attempt++) {
          const p = getFallbackScatteredPosition();
          if (isPositionValidWithSpacing(p)) {
              const minDistSq = getMinDistSqToExistingSystems(p);
              spacingFallbackUsed += 1;
              devWarn(
                  `[WorldGen] Minimum spacing fallback used for system #${index} ` +
                  `after ${PRIMARY_POSITION_ATTEMPTS} failed primary attempts (minSpacing=${minimumSystemSpacingLy}).`
              );
              return {
                position: p,
                placement: {
                  method: 'fallback',
                  primaryAttempts: PRIMARY_POSITION_ATTEMPTS,
                  fallbackAttempts: attempt + 1,
                  nearestDistanceLy: Math.sqrt(Math.max(0, minDistSq))
                }
              };
          }
      }

      // 3) Best-effort: pick the candidate that maximizes distance to the nearest neighbor
      let bestPos: Vec3 = getFallbackScatteredPosition();
      let bestMinDistSq = getMinDistSqToExistingSystems(bestPos);

      for (let sample = 0; sample < BEST_EFFORT_FALLBACK_SAMPLES; sample++) {
          const p = getFallbackScatteredPosition();
          const d2 = getMinDistSqToExistingSystems(p);
          if (d2 > bestMinDistSq) {
              bestMinDistSq = d2;
              bestPos = p;
              if (bestMinDistSq >= minimumSystemSpacingSq) break;
          }
      }

      const bestDist = Math.sqrt(Math.max(0, bestMinDistSq));
      spacingBestEffortUsed += 1;
      devWarn(
          `[WorldGen] Failed to place a system with minimum spacing of ${minimumSystemSpacingLy} ly. ` +
          `Placing best-effort candidate with nearest distance=${bestDist.toFixed(2)} ly. ` +
          `If overlaps are unacceptable, increase radius, reduce systemCount, or set minimumSystemSpacingLy=0 to disable.`
      );

      return {
        position: bestPos,
        placement: {
          method: 'best_effort',
          primaryAttempts: PRIMARY_POSITION_ATTEMPTS,
          fallbackAttempts: FALLBACK_POSITION_ATTEMPTS,
          bestEffortSamples: BEST_EFFORT_FALLBACK_SAMPLES,
          nearestDistanceLy: bestDist
        }
      };
  };

  // Name Generator
  const generateName = (): string => {
      const prefixes = ['Al', 'Bet', 'Gam', 'Del', 'Eps', 'Zet', 'Eta', 'The', 'Iot', 'Kap', 'Lam', 'Mu', 'Nu', 'Xi', 'Omi', 'Pi', 'Rho', 'Sig', 'Tau', 'Ups', 'Phi', 'Chi', 'Psi', 'Ome', 'Cor', 'Vak', 'Ril'];
      const suffixes = ['pha', 'ta', 'ma', 'da', 'lon', 'ra', 'na', 'ka', 'la', 'mi', 'ni', 'xi', 'cron', 'pi', 'rho', 'ma', 'tau', 'lon', 'phi', 'chi', 'psi', 'ga', 'tis', 'nus'];
      const p = rng.pick(prefixes);
      const s = rng.pick(suffixes);
      return `${p}${s}`;
  };

  const usedNames = new Set<string>(staticNames);

  for (let i = 0; i < systemsToGenerate; i++) {
    const rngStateBefore = rng.getState();
    let name = generateName();
    let attempts = 0;
    while(usedNames.has(name) && attempts < 20) {
        name = generateName() + (attempts > 5 ? ` ${rng.int(1, 99)}` : ""); // Fallback numbering
        attempts++;
    }
    usedNames.add(name);
    const nameAttempts = attempts;
    const id = rng.id('sys');
    const placement = getProceduralPositionWithMinSpacing(i);
    const size = rng.range(0.8, 1.2);
    const resourceType = rng.next() > 0.75 ? 'gas' : 'none';
    const system: StarSystem = {
      id,
      name,
      position: placement.position,
      color: '#ffffff',
      size,
      ownerFactionId: null,
      resourceType,
      isHomeworld: false,
      planets: []
    };
    const rngStateAfter = rng.getState();
    systems.push(system);
    emit?.({
      step: 'systems',
      kind: 'system_generated',
      entityId: id,
      rngStateBefore,
      rngStateAfter,
      inputs: {
        index: i,
        topology
      },
      outputs: {
        name,
        nameAttempts,
        position: { x: system.position.x, y: system.position.y, z: system.position.z },
        size,
        resourceType,
        placement: placement.placement
      }
    });
    if (systemsToGenerate > 0) {
      const reportEvery = Math.max(1, Math.floor(systemsToGenerate / 50));
      if (shouldReport(i, systemsToGenerate, reportEvery)) {
        reportStep('systems', (i + 1) / systemsToGenerate, { current: i + 1, total: systemsToGenerate });
      }
    }
  }
  if (systemsToGenerate === 0) {
    reportStep('systems', 1);
  }

  // 1c. Procedural astro payload (isolated per system by derived seed).
  // WHY: Strict determinism requirement. This must not consume the global world RNG.
  const astroTotal = systems.length;
  const astroReportEvery = Math.max(1, Math.floor(astroTotal / 50));
  for (let i = 0; i < systems.length; i++) {
    const sys = systems[i];
    sys.astro = generateStellarSystem({
      worldSeed: scenario.seed,
      systemId: sys.id,
      systemPosition: sys.position,
      galacticRadius: scenario.generation.radius,
      audit: emit
    });
    if (!sys.astro) {
      devWarn(`[WorldGen] Generated system '${sys.id}' is missing astro payload; regenerating with deterministic seed.`);
      emit?.({
        step: 'astro',
        kind: 'astro_missing',
        entityId: sys.id,
        warning: 'missing_astro_payload'
      });
      sys.astro = generateStellarSystem({
        worldSeed: scenario.seed,
        systemId: sys.id,
        systemPosition: sys.position,
        galacticRadius: scenario.generation.radius,
        audit: emit
      });
    }
    if (astroTotal > 0 && shouldReport(i, astroTotal, astroReportEvery)) {
      reportStep('astro', (i + 1) / astroTotal, { current: i + 1, total: astroTotal });
    }
  }
  if (astroTotal === 0) {
    reportStep('astro', 1);
  }

  // 1d. Resource assignment from astro (non-static systems only).
  systems.forEach(system => {
    if (staticSystemIds.has(system.id)) return;
    const planets = system.astro?.planets ?? [];
    const snowLineAu = system.astro?.derived?.snowLineAu ?? 0;
    const hasGasGiant = planets.some(p => p.type === 'GasGiant');
    const hasIceGiant = planets.some(p => p.type === 'IceGiant');
    const hasSubNeptune = planets.some(p => p.type === 'SubNeptune' && p.semiMajorAxisAu > snowLineAu * 0.9);
    const hasVolatileBelt = planets.some(p => p.type === 'Dwarf' && p.semiMajorAxisAu > snowLineAu * 1.1);
    const derivedResource = deriveResourceTypeFromAstro(system.astro);
    if (system.resourceType !== derivedResource) {
      const previous = system.resourceType;
      system.resourceType = derivedResource;
      emit?.({
        step: 'systems',
        kind: 'system_resource_assigned',
        entityId: system.id,
        inputs: {
          previous
        },
        outputs: {
          resourceType: derivedResource,
          hasGasGiant,
          hasIceGiant,
          hasSubNeptune,
          hasVolatileBelt
        }
      });
    }
  });

  // --- 2. FACTIONS & TERRITORIES ---
  reportStep('territories', 0);
  const homeSystems = new Map<string, StarSystem>(); // FactionID -> System
  const distMode = scenario.setup.startingDistribution;

  if (distMode !== 'none') {
      const usedIndices = new Set<number>();
      
      // A. Assign Home Systems
      factions.forEach((faction, idx) => {
          let bestIdx = -1;
          const rngStateBefore = idx === 0 ? rng.getState() : undefined;
          let selectionMethod = idx === 0 ? 'random' : 'max_distance';
          let candidateCount = 0;
          
          if (idx === 0) {
              // First faction: Pick random non-static system preferably
              const candidates = systems.map((s, i) => ({s, i})).filter(x => !staticNames.has(x.s.name));
              candidateCount = candidates.length;
              if (candidates.length > 0) {
                  const picked = rng.pick(candidates);
                  bestIdx = picked ? picked.i : rng.int(0, systems.length - 1);
              } else {
                  bestIdx = rng.int(0, systems.length - 1);
              }
          } else {
             // Maximize distance from existing homes
             let maxDist = -1;
             candidateCount = systems.length - usedIndices.size;
             
             systems.forEach((sys, sysIdx) => {
                 if (usedIndices.has(sysIdx)) return;
                 // Avoid static systems for homes if possible
                 if (staticNames.has(sys.name)) return;

                 let minDistToOthers = Infinity;
                 homeSystems.forEach(home => {
                     const d = distSq(sys.position, home.position);
                     if (d < minDistToOthers) minDistToOthers = d;
                 });
                 
                 if (minDistToOthers > maxDist) {
                     maxDist = minDistToOthers;
                     bestIdx = sysIdx;
                 }
             });
          }
          
          if (bestIdx !== -1) {
              usedIndices.add(bestIdx);
              const sys = systems[bestIdx];
              sys.ownerFactionId = faction.id;
              sys.color = faction.color; // IMMEDIATE COLOR UPDATE
              sys.isHomeworld = true;
              homeSystems.set(faction.id, sys);
              const rngStateAfter = idx === 0 ? rng.getState() : undefined;
              emit?.({
                step: 'territories',
                kind: 'homeworld_assigned',
                entityId: sys.id,
                rngStateBefore,
                rngStateAfter,
                inputs: {
                  factionId: faction.id,
                  method: selectionMethod,
                  candidateCount
                },
                outputs: {
                  systemId: sys.id,
                  systemName: sys.name
                }
              });
          }
      });

      // B. Apply Cluster Distribution (Expand Territory)
      if (distMode === 'cluster') {
          factions.forEach(faction => {
              const home = homeSystems.get(faction.id);
              if (!home) return;

              // Find N nearest unowned neighbors
              const neighbors = sorted(
                  systems
                      .filter(s => !s.ownerFactionId && s.id !== home.id && !staticSystemIds.has(s.id))
                      .map(s => ({ sys: s, dist: distSq(s.position, home.position) })),
                  (a, b) => a.dist - b.dist
              ).slice(0, CLUSTER_NEIGHBOR_COUNT);

              neighbors.forEach(n => {
                  n.sys.ownerFactionId = faction.id;
                  n.sys.color = faction.color; // IMMEDIATE COLOR UPDATE
              });
              emit?.({
                step: 'territories',
                kind: 'cluster_territory_assigned',
                entityId: home.id,
                inputs: {
                  factionId: faction.id,
                  homeSystemId: home.id
                },
                outputs: {
                  systemIds: neighbors.map(n => n.sys.id)
                }
              });
          });
      }

      // C. Optional Target Allocation (Percentages)
      // If the scenario declares a territoryAllocation, we grow contiguous territory from each home
      // until the target system counts are reached. Remaining systems stay neutral.
      const ta = (scenario.setup as any).territoryAllocation as
        | { type: 'percentages'; byFactionId: Record<string, number>; neutralShare?: number; contiguity?: 'clustered' }
        | undefined;

      if (ta && ta.type === 'percentages') {
          // Compute targets based on TOTAL systemCount (including static). We generally keep static systems neutral.
          const total = systems.length;
          const targets = new Map<string, number>();
          const territoryAssignments: Array<{ factionId: string; systemId: string }> = [];

          // Determine target counts per faction with controlled rounding.
          // We floor each target then distribute the remainder by largest fractional parts.
          const raw: Array<{ id: string; raw: number; base: number; frac: number }> = [];
          for (const [fid, share] of Object.entries(ta.byFactionId || {})) {
              const r = total * share;
              const b = Math.floor(r);
              raw.push({ id: fid, raw: r, base: b, frac: r - b });
          }
          const orderedRaw = sorted(raw, (a, b) => b.frac - a.frac);

          let allocated = orderedRaw.reduce((acc, x) => acc + x.base, 0);
          // Neutral share defaults to remaining systems
          const neutralTarget = ta.neutralShare !== undefined
              ? Math.max(0, Math.round(total * ta.neutralShare))
              : Math.max(0, total - allocated);

          // Ensure we don't over-allocate (can happen with neutralShare rounding)
          const maxFactionTotal = Math.max(0, total - neutralTarget);

          // Start with floored targets
          orderedRaw.forEach(x => targets.set(x.id, x.base));

          // Distribute remainder up to maxFactionTotal
          let remainder = maxFactionTotal - allocated;
          let idx = 0;
          while (remainder > 0 && orderedRaw.length > 0) {
              const pick = orderedRaw[idx % orderedRaw.length];
              targets.set(pick.id, (targets.get(pick.id) || 0) + 1);
              remainder--;
              idx++;
          }

          // Helper: count currently owned systems for a faction
          const ownedCount = (fid: string) => systems.filter(s => s.ownerFactionId === fid).length;

          // Helper: get nearest unowned system to a given set of owned systems (contiguous growth)
          const getNextGrowCandidate = (owned: StarSystem[]): StarSystem | null => {
              let best: { sys: StarSystem; dist: number } | null = null;
              for (const sys of systems) {
                  if (sys.ownerFactionId) continue;
                  if (staticSystemIds.has(sys.id)) continue; // Keep static systems neutral

                  let min = Infinity;
                  for (const o of owned) {
                      const d = distSq(sys.position, o.position);
                      if (d < min) min = d;
                  }
                  if (best === null || min < best.dist) {
                      best = { sys, dist: min };
                  }
              }
              return best ? best.sys : null;
          };

          // Grow each faction territory independently, alternating growth to reduce collision.
          const growOrder = factions.map(f => f.id).filter(fid => targets.has(fid));
          let safety = 0;
          while (safety < 5000) {
              safety++;
              let progressed = false;

              for (const fid of growOrder) {
                  const target = targets.get(fid) || 0;
                  const current = ownedCount(fid);
                  if (current >= target) continue;

                  const owned = systems.filter(s => s.ownerFactionId === fid);
                  if (owned.length === 0) continue;

                  const candidate = getNextGrowCandidate(owned);
                  if (!candidate) continue;

                  const factionDef = factions.find(f => f.id === fid);
                  if (!factionDef) continue;
                  candidate.ownerFactionId = fid;
                  candidate.color = factionDef.color; // IMMEDIATE COLOR UPDATE
                  progressed = true;
                  territoryAssignments.push({ factionId: fid, systemId: candidate.id });
              }

              if (!progressed) break; // No more unowned candidates

              // Stop if all faction targets are satisfied
              const allDone = growOrder.every(fid => ownedCount(fid) >= (targets.get(fid) || 0));
              if (allDone) break;
          }

          const targetsRecord: Record<string, number> = {};
          sorted(Array.from(targets.entries()), (a, b) => a[0].localeCompare(b[0]))
            .forEach(([fid, count]) => {
              targetsRecord[fid] = count;
            });
          emit?.({
            step: 'territories',
            kind: 'territory_allocation',
            inputs: {
              totalSystems: total,
              neutralTarget,
              targets: targetsRecord
            },
            outputs: {
              assignments: territoryAssignments
            }
          });
      }
  }
  reportStep('territories', 1);

  // --- 2.5. BUILD PLANETARY BODIES (from astro + scenario overrides) ---
  const planetSystemsTotal = systems.length;
  const planetReportEvery = Math.max(1, Math.floor(planetSystemsTotal / 50));
  systems.forEach((system, index) => {
    const overrides = staticPlanetOverrides.get(system.id) ?? [];
    system.planets = buildPlanetBodies(
      { id: system.id, name: system.name, ownerFactionId: system.ownerFactionId },
      system.astro,
      overrides
    );
    emit?.({
      step: 'planets',
      kind: 'planet_bodies_built',
      entityId: system.id,
      inputs: {
        overridesCount: overrides.length
      },
      outputs: {
        bodyIds: system.planets.map(body => body.id),
        planetCount: system.planets.filter(body => body.bodyType === 'planet').length,
        moonCount: system.planets.filter(body => body.bodyType === 'moon').length,
        solidCount: system.planets.filter(body => body.isSolid).length,
        fallbackBodies: system.planets.filter(body => body.id.startsWith(`planet-${system.id}-fallback`)).length
      }
    });
    if (planetSystemsTotal > 0 && shouldReport(index, planetSystemsTotal, planetReportEvery)) {
      reportStep('planets', (index + 1) / planetSystemsTotal, { current: index + 1, total: planetSystemsTotal });
    }
  });
  if (planetSystemsTotal === 0) {
    reportStep('planets', 1);
  }

  // --- 2.6. INITIALIZE PLANET SURFACE DESCRIPTORS (lightweight, persisted) ---
  const planetSurfaceDescriptorsByBodyId: Record<string, import('../../shared/shared').PlanetSurfaceDescriptor> = {};
  const surfaceGeneratorVersion =
    scenario.generation?.surfaceGeneratorVersion ?? DEFAULT_PLANET_SURFACE_GENERATOR_VERSION;
  const surfaceBodiesTotal = systems.reduce((total, system) => total + system.planets.filter(body => body.isSolid).length, 0);
  const surfaceReportEvery = Math.max(1, Math.floor(surfaceBodiesTotal / 50));
  let surfaceBodiesDone = 0;
  systems.forEach(system => {
    system.planets.forEach(body => {
      if (!body.isSolid) return;
      const descriptor = createPlanetSurfaceDescriptor({
        gameSeed: scenario.seed,
        systemId: system.id,
        body,
        generatorVersion: surfaceGeneratorVersion,
        settlementConfig: scenario.generation.settlements
      });
      planetSurfaceDescriptorsByBodyId[body.id] = descriptor;
      emit?.({
        step: 'surface',
        kind: 'surface_descriptor_created',
        entityId: body.id,
        inputs: {
          systemId: system.id,
          bodyId: body.id,
          generatorVersion: surfaceGeneratorVersion
        },
        outputs: {
          seed: descriptor.seed,
          config: descriptor.config,
          astroRef: descriptor.astroRef,
          settlementConfig: descriptor.settlementConfig
        }
      });
      if (surfaceBodiesTotal > 0) {
        surfaceBodiesDone += 1;
        if (shouldReport(surfaceBodiesDone - 1, surfaceBodiesTotal, surfaceReportEvery)) {
          reportStep('surface', surfaceBodiesDone / surfaceBodiesTotal, { current: surfaceBodiesDone, total: surfaceBodiesTotal });
        }
      }
    });
  });
  if (surfaceBodiesTotal === 0) {
    reportStep('surface', 1);
  }

  // --- 3. GENERATE FLEETS & ARMIES ---
  const fleets: Fleet[] = [];
  const armies: Army[] = [];

  const fleetTotal = scenario.setup.initialFleets.length;
  const fleetReportEvery = Math.max(1, Math.floor(fleetTotal / 50));
  scenario.setup.initialFleets.forEach((def, index) => {
      const factionId = def.ownerFactionId;
      // Ensure the fleet belongs to a valid faction
      const factionDef = factions.find(f => f.id === factionId);
      if (!factionDef) {
          devWarn(`Scenario references unknown faction '${factionId}' in initialFleets. Skipping.`);
          return;
      }

      let position = vec3(0, 0, 0);
      let state = FleetState.ORBIT;
      let targetPosition: Vec3 | null = null;
      let targetSystemId: string | null = null;
      
      // Determine Spawn Location
      if (def.spawnLocation === 'home_system') {
          const home = homeSystems.get(factionId);
          if (home) {
              position = clone(home.position);
          } else {
              // Fallback
              const randomSys = rng.pick(systems);
              if (randomSys) {
                  position = clone(randomSys.position);
              } else {
                  devWarn(`[WorldGen] No systems available for fleet spawn, using origin`);
                  position = vec3(0, 0, 0);
              }
          }
      } else if (def.spawnLocation === 'random') {
          const ownedSystems = systems.filter(s => s.ownerFactionId === factionId);
          const neutralSystems = systems.filter(s => !s.ownerFactionId);
          const candidatePool = ownedSystems.length > 0
              ? ownedSystems
              : neutralSystems.length > 0
              ? neutralSystems
              : systems;

          const randomSys = rng.pick(candidatePool);
          if (randomSys) {
              position = clone(randomSys.position);
          } else {
              devWarn(`[WorldGen] No systems available for random fleet spawn, using origin`);
              position = vec3(0, 0, 0);
          }
      } else {
          // Deep Space Spawn ({x,y,z})
          position = vec3(def.spawnLocation.x, def.spawnLocation.y, def.spawnLocation.z);
          const nearestSystem = systems.reduce<{ system: StarSystem; distanceSq: number } | null>((nearest, system) => {
              const distanceSq = distSq(position, system.position);

              if (!nearest || distanceSq < nearest.distanceSq) {
                  return { system, distanceSq };
              }

              return nearest;
          }, null);

          if (nearestSystem) {
              state = FleetState.MOVING;
              targetSystemId = nearestSystem.system.id;
              targetPosition = clone(nearestSystem.system.position);
          } else {
              state = FleetState.ORBIT;
          }
      }

      // Create Ships with validation and fallback
      const ships = def.ships.map(typeStr => {
          const type = typeStr as ShipType;
          if (!SHIP_STATS[type]) {
              const fallbackType = ShipType.FRIGATE;
              devWarn(
                  `[WorldGen] Unknown ship type '${typeStr}' for faction '${factionId}'. ` +
                  `Replacing with '${fallbackType}'.`
              );
              return createShip(fallbackType, rng);
          }

          return createShip(type, rng);
      });

      const fleet: Fleet = {
          id: rng.id('fleet'),
          factionId: factionId,
          ships: ships,
          position: position,
          state: state,
          targetSystemId: targetSystemId,
          targetPosition: targetPosition,
          radius: computeFleetRadius(ships.length),
          stateStartTurn: 0
      };

      // Generate Embarked Armies
      if (def.withArmies) {
          fleet.ships.forEach(ship => {
              if (ship.type === ShipType.TRANSPORTER) {
                  const army = createArmy(
                      factionId,
                      'mechanized_infantry',
                      MIN_ARMY_CREATION_MEMBERS,
                      fleet.id,
                      ArmyState.EMBARKED,
                      rng
                  );
                  if (army) {
                      ship.carriedArmyId = army.id;
                      armies.push(army);
                  }
              }
          });
      }

      fleets.push(fleet);
      if (fleetTotal > 0 && shouldReport(index, fleetTotal, fleetReportEvery)) {
        reportStep('fleets', (index + 1) / fleetTotal, { current: index + 1, total: fleetTotal });
      }
  });
  if (fleetTotal === 0) {
    reportStep('fleets', 1);
  }

  // --- 4. GARRISONS (Ground Defenses) ---
  const garrisonTotal = systems.length;
  const garrisonReportEvery = Math.max(1, Math.floor(garrisonTotal / 50));
  systems.forEach((sys, index) => {
      if (sys.ownerFactionId) {
          const isCapital = sys.isHomeworld;

          // Capital gets 3 armies, other owned territory gets 1
          const garrisonCount = isCapital ? 3 : 1;
          const occupiablePlanets = getSolidPlanets(sys);
          if (occupiablePlanets.length === 0) {
              return;
          }

          for (let i = 0; i < garrisonCount; i++) {
              const targetPlanet = occupiablePlanets[i % occupiablePlanets.length];
              const army = createArmy(
                  sys.ownerFactionId,
                  'mechanized_infantry',
                  MIN_ARMY_CREATION_MEMBERS,
                  targetPlanet.id,
                  ArmyState.DEPLOYED,
                  rng
              );
              if (army) {
                  armies.push(army);
                  if (!targetPlanet.ownerFactionId) {
                      targetPlanet.ownerFactionId = sys.ownerFactionId;
                  }
              }
          }
      }
      if (garrisonTotal > 0 && shouldReport(index, garrisonTotal, garrisonReportEvery)) {
        reportStep('garrisons', (index + 1) / garrisonTotal, { current: index + 1, total: garrisonTotal });
      }
  });
  if (garrisonTotal === 0) {
    reportStep('garrisons', 1);
  }

  const spacingLabel = enforceMinimumSystemSpacing ? `${minimumSystemSpacingLy}ly` : 'disabled';
  devLog(`[WorldGen] Generated ${systems.length} systems (Topology: ${topology}, MinSpacing: ${spacingLabel}), ${fleets.length} fleets, ${armies.length} armies. Player: ${playerFactionId}`);

  // --- 5. ASSEMBLE STATE ---
  reportStep('finalize', 0);
  const state: GameState = {
      scenarioId: scenario.id,
      scenarioTitle: scenario.meta.title,
      playerFactionId,
      factions,
      seed: scenario.seed,
      rngState: rng.getState(),
      startYear: 2300,
      day: 1,
      systems,
      fleets,
      stations: [],
      armies,
      lasers: [],
      battles: [],
      logs: [{
          id: rng.id('log'),
          day: 1,
          text: `Simulation initialized. Seed: ${scenario.seed}. Topology: ${topology}`,
          type: 'info'
      }],
      messages: [],
      selectedFleetId: null,
      winnerFactionId: null,
      planetSurfaceDescriptorsByBodyId,
      groundBuildings: [],
      objectives: {
          conditions: scenario.objectives.win,
          maxTurns: scenario.objectives.maxTurns
      },
      rules: scenario.rules,
      aiState: undefined 
  };

  const normalizedState = normalizeSurfacePositions(state);
  if (audit) {
    audit.log.meta.systemCountGenerated = normalizedState.systems.length;
    audit.log.meta.rngEndState = rng.getState();
    audit.log.meta.surfaceGeneratorVersion = surfaceGeneratorVersion;

    const byResourceType: Record<string, number> = { gas: 0, none: 0 };
    const ownerCounts = new Map<string, number>();
    let homeworldCount = 0;
    normalizedState.systems.forEach(system => {
      byResourceType[system.resourceType] = (byResourceType[system.resourceType] ?? 0) + 1;
      const ownerKey = system.ownerFactionId ?? '__neutral__';
      ownerCounts.set(ownerKey, (ownerCounts.get(ownerKey) ?? 0) + 1);
      if (system.isHomeworld) homeworldCount += 1;
    });

    const byOwnerFactionId: Record<string, number> = {};
    sorted(Array.from(ownerCounts.entries()), (a, b) => a[0].localeCompare(b[0]))
      .forEach(([ownerId, count]) => {
        byOwnerFactionId[ownerId] = count;
      });

    const starCountHistogram: Record<string, number> = {};
    const starCountEntries = new Map<number, number>();
    const planetCounts: number[] = [];
    let missingAstroCount = 0;
    normalizedState.systems.forEach(system => {
      if (!system.astro) {
        missingAstroCount += 1;
        return;
      }
      const starCount = system.astro.starCount;
      starCountEntries.set(starCount, (starCountEntries.get(starCount) ?? 0) + 1);
      planetCounts.push(system.astro.planets?.length ?? 0);
    });
    sorted(Array.from(starCountEntries.entries()), (a, b) => a[0] - b[0])
      .forEach(([count, value]) => {
        starCountHistogram[String(count)] = value;
      });

    let planetCountMin = 0;
    let planetCountMax = 0;
    let planetCountAvg = 0;
    if (planetCounts.length > 0) {
      planetCountMin = Math.min(...planetCounts);
      planetCountMax = Math.max(...planetCounts);
      planetCountAvg = planetCounts.reduce((acc, value) => acc + value, 0) / planetCounts.length;
    }

    let totalBodies = 0;
    let planetsCount = 0;
    let moonsCount = 0;
    let solidsCount = 0;
    let fallbackBodies = 0;
    normalizedState.systems.forEach(system => {
      system.planets.forEach(body => {
        totalBodies += 1;
        if (body.bodyType === 'planet') planetsCount += 1;
        if (body.bodyType === 'moon') moonsCount += 1;
        if (body.isSolid) solidsCount += 1;
        if (body.id.startsWith(`planet-${system.id}-fallback`)) fallbackBodies += 1;
      });
    });

    const overrideCount = Array.from(staticPlanetOverrides.values())
      .reduce((acc, overrides) => acc + overrides.length, 0);

    audit.log.summaries.systems = {
      total: normalizedState.systems.length,
      staticCount: staticDefs.length,
      proceduralCount: normalizedState.systems.length - staticDefs.length,
      homeworldCount,
      byResourceType,
      byOwnerFactionId,
      spacingFallbacks: {
        fallbackUsed: spacingFallbackUsed,
        bestEffortUsed: spacingBestEffortUsed
      }
    };

    audit.log.summaries.astro = {
      total: normalizedState.systems.length,
      missingAstroCount,
      starCountHistogram,
      planetCountStats: {
        min: planetCountMin,
        max: planetCountMax,
        avg: planetCountAvg
      }
    };

    audit.log.summaries.planets = {
      totalBodies,
      planets: planetsCount,
      moons: moonsCount,
      solids: solidsCount,
      fallbackBodies,
      overrideCount
    };
  }
  reportStep('finalize', 1);
  return { state: normalizedState, rng };
};
