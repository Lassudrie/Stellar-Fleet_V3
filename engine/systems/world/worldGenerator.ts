
import { GameState, StarSystem, Fleet, FactionId, ShipType, Army, ArmyState, FleetState, FactionState } from '../../../types';
import { RNG } from '../../rng';
import { GameScenario } from '../../../scenarios/types';
import { createArmy } from '../../army';
import { createShip } from '../../world';
import { computeFleetRadius } from '../../fleetDerived';
import { vec3, clone, Vec3, distSq } from '../../math/vec3';

const CLUSTER_NEIGHBOR_COUNT = 4; // Number of extra systems for 'cluster' starting distribution

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
      resourceType: def.resourceType
    });
    staticNames.add(def.name);
  });

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
      position: getProceduralPosition(i),
      color: '#ffffff',
      size: rng.range(0.8, 1.2),
      ownerFactionId: null,
      resourceType: rng.next() > 0.75 ? 'gas' : 'none'
    });
  }

  // --- 2. FACTIONS & TERRITORIES ---
  const homeSystems = new Map<string, StarSystem>(); // FactionID -> System
  const distMode = scenario.setup.startingDistribution;

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
                      10000,
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
          const factionHome = homeSystems.get(sys.ownerFactionId);
          const isCapital = factionHome && factionHome.id === sys.id;
          
          // Capital gets 3 armies, other owned territory gets 1
          const garrisonCount = isCapital ? 3 : 1;

          for (let i = 0; i < garrisonCount; i++) {
              const army = createArmy(
                  sys.ownerFactionId,
                  10000,
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

  console.log(`[WorldGen] Generated ${systems.length} systems (Topology: ${topology}), ${fleets.length} fleets, ${armies.length} armies. Player: ${playerFactionId}`);

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
