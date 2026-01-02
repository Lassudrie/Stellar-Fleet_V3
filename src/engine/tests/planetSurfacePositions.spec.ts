import assert from 'node:assert';
import { applyCommand } from '../commands';
import { RNG } from '../rng';
import { generateStellarSystem } from '../worldgen/stellar';
import { buildPlanetBodies } from '../planets';
import { createPlanetSurfaceDescriptor } from '../planetSurface/descriptor';
import { generateSurfaceMapForState } from '../planetSurface/access';
import { deserializeGameState, serializeGameState } from '../serialization';
import { ArmyState, FleetState, ShipType, type FactionState, type Fleet, type GameState, type PlanetBody } from '../../shared/types';
import { phaseMovement } from '../runTurn';

interface TestCase {
  name: string;
  run: () => void;
}

const factions: FactionState[] = [
  { id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true }
];

const createArmy = (params: {
  id: string;
  factionId: string;
  members: number;
  state: ArmyState;
  containerId: string;
  surfacePos?: { bodyId: string; q: number; r: number };
}): any => ({
  id: params.id,
  factionId: params.factionId,
  unitType: 'mechanized_infantry',
  posture: 'normal',
  maxMembers: params.members,
  members: params.members,
  attack: 1,
  defense: 1,
  condition: 1,
  state: params.state,
  containerId: params.containerId,
  ...(params.surfacePos ? { surfacePos: params.surfacePos } : {})
});

const createStateWithOneSurface = (worldSeed: number, systemId: string): { state: GameState; body: PlanetBody } => {
  const astro = generateStellarSystem({ worldSeed, systemId });
  const system = {
    id: systemId,
    name: systemId,
    position: { x: 0, y: 0, z: 0 },
    color: '#ffffff',
    size: 1,
    ownerFactionId: 'blue',
    resourceType: 'none' as const,
    isHomeworld: false,
    astro,
    planets: [] as PlanetBody[]
  };

  system.planets = buildPlanetBodies({ id: system.id, name: system.name, ownerFactionId: system.ownerFactionId }, astro, []);
  const body = system.planets.find(p => p.isSolid && p.bodyType === 'planet')!;
  assert.ok(body, 'Expected a solid planet body');

  const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });

  const state: GameState = {
    scenarioId: 'test',
    scenarioTitle: 'Test',
    playerFactionId: 'blue',
    factions,
    seed: worldSeed,
    rngState: worldSeed,
    startYear: 0,
    day: 1,
    systems: [system],
    fleets: [],
    stations: [],
    armies: [],
    lasers: [],
    battles: [],
    logs: [],
    messages: [],
    selectedFleetId: null,
    winnerFactionId: null,
    planetSurfaceDescriptorsByBodyId: {
      [body.id]: descriptor
    },
    groundBuildings: [],
    objectives: { conditions: [] },
    rules: { fogOfWar: false, aiEnabled: true, useAdvancedCombat: true, totalWar: false, unlimitedFuel: false }
  };

  return { state, body };
};

const pickAnyTile = (state: GameState, bodyId: string, predicate: (biome: string) => boolean): { q: number; r: number } => {
  const map = generateSurfaceMapForState(state, bodyId);
  assert.ok(map, 'Expected surface map');
  const { w } = map.descriptor.config;
  for (let i = 0; i < map.tiles.length; i += 1) {
    const t = map.tiles[i];
    if (!predicate(t.biome)) continue;
    return { q: i % w, r: Math.floor(i / w) };
  }
  throw new Error('No matching tile found');
};

const isWater = (biome: string): boolean => biome === 'ocean' || biome === 'coast' || biome === 'lake';

const tests: TestCase[] = [
  {
    name: 'save/load preserves valid army.surfacePos and groundBuildings.surfacePos',
    run: () => {
      const { state: base, body } = createStateWithOneSurface(42, 'sys_surface_pos');

      const land = pickAnyTile(base, body.id, b => !isWater(b));
      const buildingSpot = pickAnyTile(base, body.id, b => !isWater(b) && b !== 'mountain' && b !== 'ice');

      const withEntities: GameState = {
        ...base,
        armies: [createArmy({
          id: 'army-1',
          factionId: 'blue',
          members: 10000,
          state: ArmyState.DEPLOYED,
          containerId: body.id,
          surfacePos: { bodyId: body.id, q: land.q, r: land.r }
        })],
        groundBuildings: [{
          id: 'bld-1',
          factionId: 'blue',
          type: 'outpost',
          surfacePos: { bodyId: body.id, q: buildingSpot.q, r: buildingSpot.r }
        }]
      };

      const roundTrip = deserializeGameState(serializeGameState(withEntities));
      assert.deepStrictEqual(roundTrip.armies[0].surfacePos, withEntities.armies[0].surfacePos);
      assert.deepStrictEqual(roundTrip.groundBuildings?.[0].surfacePos, withEntities.groundBuildings?.[0].surfacePos);
    }
  },
  {
    name: 'BUILD_AT rejects water tiles and rejects already-occupied building tiles',
    run: () => {
      const { state: base, body } = createStateWithOneSurface(7, 'sys_build');
      const water = pickAnyTile(base, body.id, b => isWater(b));
      const land = pickAnyTile(base, body.id, b => !isWater(b) && b !== 'mountain' && b !== 'ice');

      const rng = new RNG(1);
      const fail = applyCommand(base, { type: 'BUILD_AT', factionId: 'blue', buildingType: 'outpost', at: { bodyId: body.id, q: water.q, r: water.r } }, rng);
      assert.ok(!fail.ok, 'Expected BUILD_AT on water to fail');

      const ok1 = applyCommand(base, { type: 'BUILD_AT', factionId: 'blue', buildingType: 'outpost', at: { bodyId: body.id, q: land.q, r: land.r } }, new RNG(2));
      assert.ok(ok1.ok, 'Expected BUILD_AT on land to succeed');
      assert.ok(ok1.state.groundBuildings && ok1.state.groundBuildings.length === 1);

      const ok2 = applyCommand(ok1.state, { type: 'BUILD_AT', factionId: 'blue', buildingType: 'mine', at: { bodyId: body.id, q: land.q, r: land.r } }, new RNG(3));
      assert.ok(!ok2.ok, 'Expected second building on same tile to fail');
    }
  },
  {
    name: 'MOVE_ARMY_ON_SURFACE rejects non-passable tiles and updates position on success',
    run: () => {
      const { state: base, body } = createStateWithOneSurface(11, 'sys_move');
      const landA = pickAnyTile(base, body.id, b => !isWater(b));
      const map = generateSurfaceMapForState(base, body.id)!;
      const { w } = map.descriptor.config;
      let landB: { q: number; r: number } | null = null;
      for (let i = 0; i < map.tiles.length; i += 1) {
        const t = map.tiles[i];
        if (isWater(t.biome)) continue;
        const q = i % w;
        const r = Math.floor(i / w);
        if (q === landA.q && r === landA.r) continue;
        landB = { q, r };
        break;
      }
      if (!landB) landB = landA;
      const water = pickAnyTile(base, body.id, b => isWater(b));

      const state: GameState = {
        ...base,
        armies: [createArmy({
          id: 'army-1',
          factionId: 'blue',
          members: 10000,
          state: ArmyState.DEPLOYED,
          containerId: body.id,
          surfacePos: { bodyId: body.id, q: landA.q, r: landA.r }
        })]
      };

      const fail = applyCommand(state, { type: 'MOVE_ARMY_ON_SURFACE', armyId: 'army-1', to: { bodyId: body.id, q: water.q, r: water.r } }, new RNG(5));
      assert.ok(!fail.ok, 'Expected move onto water to fail');

      const ok = applyCommand(state, { type: 'MOVE_ARMY_ON_SURFACE', armyId: 'army-1', to: { bodyId: body.id, q: landB.q, r: landB.r } }, new RNG(6));
      assert.ok(ok.ok, 'Expected move onto land to succeed');
      assert.deepStrictEqual(ok.state.armies[0].surfacePos, { bodyId: body.id, q: landB.q, r: landB.r });
    }
  },
  {
    name: 'Invalid positions are deterministically relocalized on load',
    run: () => {
      const { state: base, body } = createStateWithOneSurface(99, 'sys_reloc');
      const save = JSON.parse(serializeGameState({
        ...base,
        armies: [createArmy({
          id: 'army-1',
          factionId: 'blue',
          members: 10000,
          state: ArmyState.DEPLOYED,
          containerId: body.id,
          surfacePos: { bodyId: body.id, q: 9999, r: 9999 } // out of bounds
        })]
      }));

      const restoredA = deserializeGameState(JSON.stringify(save));
      const restoredB = deserializeGameState(JSON.stringify(save));
      assert.deepStrictEqual(restoredA.armies[0].surfacePos, restoredB.armies[0].surfacePos, 'Relocation should be deterministic');

      // Must be inside grid and passable after relocalization.
      const map = generateSurfaceMapForState(restoredA, body.id)!;
      const { w, h } = map.descriptor.config;
      const pos = restoredA.armies[0].surfacePos!;
      assert.ok(pos.q >= 0 && pos.q < w && pos.r >= 0 && pos.r < h);
      const biome = map.tiles[pos.r * w + pos.q].biome;
      assert.ok(!isWater(biome), `Relocated biome must be passable, got ${biome}`);
    }
  },
  {
    name: 'Movement phase assigns surfacePos to armies auto-deployed during invasion',
    run: () => {
      const { state: base, body } = createStateWithOneSurface(1234, 'sys_invade');

      // Turn the system/planet into an enemy-held world to make it eligible for invasion.
      const system = base.systems[0];
      const enemySystem = {
        ...system,
        ownerFactionId: 'red',
        planets: system.planets.map(p => ({ ...p, ownerFactionId: 'red' }))
      };

      // Ensure defenders exist so the invasion prioritization logic has a target.
      const defenderLand = pickAnyTile(base, body.id, b => !isWater(b));
      const defenderArmy = createArmy({
        id: 'army-def',
        factionId: 'red',
        members: 9000,
        state: ArmyState.DEPLOYED,
        containerId: body.id,
        surfacePos: { bodyId: body.id, q: defenderLand.q, r: defenderLand.r }
      });

      const attackerArmyId = 'army-atk';
      const fleetId = 'fleet-inv';

      const attackerArmy = createArmy({
        id: attackerArmyId,
        factionId: 'blue',
        members: 10000,
        state: ArmyState.EMBARKED,
        containerId: fleetId
      });

      const fleet: Fleet = {
        id: fleetId,
        factionId: 'blue',
        ships: [{
          id: 'ship-1',
          type: ShipType.TRANSPORTER,
          hp: 100,
          maxHp: 100,
          fuel: 100,
          carriedArmyId: attackerArmyId
        }],
        position: enemySystem.position,
        state: FleetState.MOVING,
        targetSystemId: enemySystem.id,
        targetPosition: enemySystem.position,
        radius: 1,
        stateStartTurn: base.day,
        invasionTargetSystemId: enemySystem.id,
        invasionTargetPlanetId: body.id
      };

      const state: GameState = {
        ...base,
        systems: [enemySystem],
        fleets: [fleet],
        armies: [defenderArmy, attackerArmy]
      };

      const next = phaseMovement(state, { turn: state.day, rng: new RNG(2) });
      const landed = next.armies.find(a => a.id === attackerArmyId);
      assert.ok(landed, 'Expected attacker army to exist after movement phase');
      assert.strictEqual(landed.state, ArmyState.DEPLOYED, 'Expected attacker army to be deployed by invasion logic');
      assert.strictEqual(landed.containerId, body.id, 'Expected attacker army to be deployed onto the target body');
      assert.ok(landed.surfacePos, 'Expected normalizeSurfacePositions to assign surfacePos');

      const map = generateSurfaceMapForState(next, body.id)!;
      const { w, h } = map.descriptor.config;
      const pos = landed.surfacePos!;
      assert.ok(pos.q >= 0 && pos.q < w && pos.r >= 0 && pos.r < h, 'surfacePos should be inside the grid');
      const biome = map.tiles[pos.r * w + pos.q].biome;
      assert.ok(!isWater(biome), `surfacePos should be passable, got biome '${biome}'`);
    }
  }
];

const results: { name: string; success: boolean; error?: Error }[] = [];

for (const test of tests) {
  try {
    test.run();
    results.push({ name: test.name, success: true });
  } catch (error) {
    results.push({ name: test.name, success: false, error: error as Error });
  }
}

const successes = results.filter(r => r.success).length;
const failures = results.length - successes;

results.forEach(result => {
  if (result.success) {
    console.log(`✅ ${result.name}`);
  } else {
    console.error(`❌ ${result.name}`);
    console.error(result.error);
  }
});

if (failures > 0) {
  console.error(`Tests failed: ${failures}/${results.length}`);
  process.exitCode = 1;
} else {
  console.log(`All tests passed (${successes}/${results.length}).`);
}

