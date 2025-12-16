import { GameState, StarSystem, Fleet, FactionId, ShipType, Army, ArmyState, FleetState, FactionState } from '../../types';
import { RNG } from '../../engine/rng';
import { GameScenario } from '../../scenarios/types';
import { createArmy, MIN_ARMY_CREATION_STRENGTH } from '../../engine/army';
import { createShip } from '../../engine/world';
import { computeFleetRadius } from '../../engine/fleetDerived';
import { vec3, clone, Vec3, distSq } from '../../engine/math/vec3';

const CLUSTER_NEIGHBOR_COUNT = 4; // Number of extra systems for 'cluster' starting distribution

// --- World Gen Constraints ---
// Default requirement: ensure systems are not closer than 5 ly to avoid visual overlaps.
// Can be overridden / disabled per scenario via generation.minimumSystemSpacingLy (0 = disabled).
const DEFAULT_MINIMUM_SYSTEM_SPACING_LY = 5;

// Attempt budgets (defensive: avoid infinite loops on extreme/invalid configs).
const PRIMARY_POSITION_ATTEMPTS = 200;
const FALLBACK_POSITION_ATTEMPTS = 2000;
const BEST_EFFORT_FALLBACK_SAMPLES = 250;

export const generateWorld = (scenario: GameScenario): { state: GameState; rng: RNG } => {
  const rng = new RNG(scenario.seed);

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
  
  // 1a. Static Systems (Overrides)
  const staticDefs = scenario.generation.staticSystems || [];
  const staticNames = new Set<string>();

  staticDefs.forEach(def => {
    systems.push({
      id: def.id, // Use provided ID
      name: def.name,
      position: vec3(def.position.x, def.position.y, def.position.z),
      color: '#ffffff', // Will be updated if owned later
      size: 1.5, // Static systems are usually significant
      ownerFactionId: null,
      resourceType: def.resourceType,
      isHomeworld: false
    });
    staticNames.add(def.name);
  });

  // Validate static systems spacing (static positions are not auto-adjusted).
  if (enforceMinimumSystemSpacing && systems.length > 1) {
      for (let a = 0; a < systems.length; a++) {
          for (let b = a + 1; b < systems.length; b++) {
              const d2 = distSq(systems[a].position, systems[b].position);
              if (d2 < minimumSystemSpacingSq) {
                  const d = Math.sqrt(d2);
                  console.warn(
                      `[WorldGen] Static systems '${systems[a].name}' and '${systems[b].name}' are only ${d.toFixed(2)} ly apart (< ${minimumSystemSpacingLy}). ` +
                      `Static positions are not auto-adjusted; consider updating scenario.generation.staticSystems.`
                  );
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
    const clusterCount = rng.int(3, 5);
    for(let k=0; k<clusterCount; k++) {
        const r = rng.range(radius * 0.3, radius * 0.8);
        const theta = rng.next() * Math.PI * 2;
        mapClusterCenters.push(vec3(Math.cos(theta) * r, 0, Math.sin(theta) * r));
    }
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

  const getProceduralPositionWithMinSpacing = (index: number): Vec3 => {
      if (!enforceMinimumSystemSpacing) return getProceduralPosition(index);

      // 1) Primary attempts: keep the requested topology
      for (let attempt = 0; attempt < PRIMARY_POSITION_ATTEMPTS; attempt++) {
          const p = getProceduralPosition(index);
          if (isPositionValidWithSpacing(p)) return p;
      }

      // 2) Fallback attempts: escape local density by sampling the full disk
      for (let attempt = 0; attempt < FALLBACK_POSITION_ATTEMPTS; attempt++) {
          const p = getFallbackScatteredPosition();
          if (isPositionValidWithSpacing(p)) {
              console.warn(
                  `[WorldGen] Minimum spacing fallback used for system #${index} ` +
                  `after ${PRIMARY_POSITION_ATTEMPTS} failed primary attempts (minSpacing=${minimumSystemSpacingLy}).`
              );
              return p;
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
      console.warn(
          `[WorldGen] Failed to place a system with minimum spacing of ${minimumSystemSpacingLy} ly. ` +
          `Placing best-effort candidate with nearest distance=${bestDist.toFixed(2)} ly. ` +
          `If overlaps are unacceptable, increase radius, reduce systemCount, or set minimumSystemSpacingLy=0 to disable.`
      );

      return bestPos;
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
    let name = generateName();
    let attempts = 0;
    while(usedNames.has(name) && attempts < 20) {
        name = generateName() + (attempts > 5 ? ` ${rng.int(1, 99)}` : ""); // Fallback numbering
        attempts++;
    }
    usedNames.add(name);

    systems.push({
      id: rng.id('sys'),
      name: name,
      position: getProceduralPositionWithMinSpacing(i),
      color: '#ffffff',
      size: rng.range(0.8, 1.2),
      ownerFactionId: null,
      resourceType: rng.next() > 0.75 ? 'gas' : 'none',
      isHomeworld: false
    });
  }

  // --- 2. FACTIONS & TERRITORIES ---
  const homeSystems = new Map<string, StarSystem>(); // FactionID -> System
  const distMode = scenario.setup.startingDistribution;
  const staticSystemIds = new Set<string>((scenario.generation.staticSystems || []).map(s => s.id));

  if (distMode !== 'none') {
      const usedIndices = new Set<number>();
      
      // A. Assign Home Systems
      factions.forEach((faction, idx) => {
          let bestIdx = -1;
          
          if (idx === 0) {
              // First faction: Pick random non-static system preferably
              const candidates = systems.map((s, i) => ({s, i})).filter(x => !staticNames.has(x.s.name));
              if (candidates.length > 0) {
                  bestIdx = rng.pick(candidates).i;
              } else {
                  bestIdx = rng.int(0, systems.length - 1);
              }
          } else {
             // Maximize distance from existing homes
             let maxDist = -1;
             
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
          }
      });

      // B. Apply Cluster Distribution (Expand Territory)
      if (distMode === 'cluster') {
          factions.forEach(faction => {
              const home = homeSystems.get(faction.id);
              if (!home) return;

              // Find N nearest unowned neighbors
              const neighbors = systems
                  .filter(s => !s.ownerFactionId && s.id !== home.id)
                  .map(s => ({ sys: s, dist: distSq(s.position, home.position) }))
                  .sort((a, b) => a.dist - b.dist)
                  .slice(0, CLUSTER_NEIGHBOR_COUNT);

              neighbors.forEach(n => {
                  n.sys.ownerFactionId = faction.id;
                  n.sys.color = faction.color; // IMMEDIATE COLOR UPDATE
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

          // Determine target counts per faction with controlled rounding.
          // We floor each target then distribute the remainder by largest fractional parts.
          const raw: Array<{ id: string; raw: number; base: number; frac: number }> = [];
          for (const [fid, share] of Object.entries(ta.byFactionId || {})) {
              const r = total * share;
              const b = Math.floor(r);
              raw.push({ id: fid, raw: r, base: b, frac: r - b });
          }
          raw.sort((a, b) => b.frac - a.frac);

          let allocated = raw.reduce((acc, x) => acc + x.base, 0);
          // Neutral share defaults to remaining systems
          const neutralTarget = ta.neutralShare !== undefined
              ? Math.max(0, Math.round(total * ta.neutralShare))
              : Math.max(0, total - allocated);

          // Ensure we don't over-allocate (can happen with neutralShare rounding)
          const maxFactionTotal = Math.max(0, total - neutralTarget);

          // Start with floored targets
          raw.forEach(x => targets.set(x.id, x.base));

          // Distribute remainder up to maxFactionTotal
          let remainder = maxFactionTotal - allocated;
          let idx = 0;
          while (remainder > 0 && raw.length > 0) {
              const pick = raw[idx % raw.length];
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
              }

              if (!progressed) break; // No more unowned candidates

              // Stop if all faction targets are satisfied
              const allDone = growOrder.every(fid => ownedCount(fid) >= (targets.get(fid) || 0));
              if (allDone) break;
          }
      }
  }

  // --- 3. GENERATE FLEETS & ARMIES ---
  const fleets: Fleet[] = [];
  const armies: Army[] = [];

  scenario.setup.initialFleets.forEach(def => {
      const factionId = def.ownerFactionId;
      // Ensure the fleet belongs to a valid faction
      const factionDef = factions.find(f => f.id === factionId);
      if (!factionDef) {
          console.warn(`Scenario references unknown faction '${factionId}' in initialFleets. Skipping.`);
          return;
      }

      let position = vec3(0, 0, 0);
      let sysId: string | null = null;
      let state = FleetState.ORBIT;
      
      // Determine Spawn Location
      if (def.spawnLocation === 'home_system') {
          const home = homeSystems.get(factionId);
          if (home) {
              position = clone(home.position);
              sysId = home.id;
          } else {
              // Fallback
              const randomSys = rng.pick(systems);
              position = clone(randomSys.position);
              sysId = randomSys.id;
          }
      } else if (def.spawnLocation === 'random') {
          const randomSys = rng.pick(systems);
          position = clone(randomSys.position);
          sysId = randomSys.id;
      } else {
          // Deep Space Spawn ({x,y,z})
          position = vec3(def.spawnLocation.x, def.spawnLocation.y, def.spawnLocation.z);
          state = FleetState.MOVING; 
      }

      // Create Ships
      const ships = def.ships.map(typeStr => {
          const type = typeStr as ShipType; 
          return createShip(type, rng);
      });

      const fleet: Fleet = {
          id: rng.id('fleet'),
          factionId: factionId,
          ships: ships,
          position: position,
          state: state,
          targetSystemId: null,
          targetPosition: null,
          radius: computeFleetRadius(ships.length),
          stateStartTurn: 0
      };

      // Generate Embarked Armies
      if (def.withArmies) {
          fleet.ships.forEach(ship => {
              if (ship.type === ShipType.TROOP_TRANSPORT) {
                  const army = createArmy(
                      factionId,
                      MIN_ARMY_CREATION_STRENGTH,
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
  });

  // --- 4. GARRISONS (Ground Defenses) ---
  systems.forEach(sys => {
      if (sys.ownerFactionId) {
          const isCapital = sys.isHomeworld;

          // Capital gets 3 armies, other owned territory gets 1
          const garrisonCount = isCapital ? 3 : 1;

          for (let i = 0; i < garrisonCount; i++) {
              const army = createArmy(
                  sys.ownerFactionId,
                  MIN_ARMY_CREATION_STRENGTH,
                  sys.id, // Container is System ID
                  ArmyState.DEPLOYED,
                  rng
              );
              if (army) {
                  armies.push(army);
              }
          }
      }
  });

  const spacingLabel = enforceMinimumSystemSpacing ? `${minimumSystemSpacingLy}ly` : 'disabled';
  console.log(`[WorldGen] Generated ${systems.length} systems (Topology: ${topology}, MinSpacing: ${spacingLabel}), ${fleets.length} fleets, ${armies.length} armies. Player: ${playerFactionId}`);

  // --- 5. ASSEMBLE STATE ---
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
      armies,
      lasers: [],
      battles: [],
      logs: [{
          id: rng.id('log'),
          day: 1,
          text: `Simulation initialized. Seed: ${scenario.seed}. Topology: ${topology}`,
          type: 'info'
      }],
      selectedFleetId: null,
      winnerFactionId: null,
      objectives: {
          conditions: scenario.objectives.win,
          maxTurns: scenario.objectives.maxTurns
      },
      rules: scenario.rules,
      aiState: undefined 
  };

  return { state, rng };
};

