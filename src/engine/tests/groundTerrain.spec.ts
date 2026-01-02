import assert from 'node:assert';
import { generateStellarSystem } from '../worldgen/stellarSystem';
import { buildPlanetBodies } from '../planets';
import { createPlanetSurfaceDescriptor, generateSurfaceMapForState } from '../planetSurface';
import { deriveTerrainType } from '../ground';
import type { FactionState, GameState, PlanetBody } from '../../shared/types';

interface TestCase { name: string; run: () => void; }

const factions: FactionState[] = [{ id: 'blue', name: 'Blue', color: '#3b82f6', isPlayable: true }];

const createStateWithSurface = (seed: number, systemId: string): { state: GameState; body: PlanetBody } => {
  const astro = generateStellarSystem({ worldSeed: seed, systemId });
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
  const descriptor = createPlanetSurfaceDescriptor({ gameSeed: seed, systemId, body });
  const state: GameState = {
    scenarioId: 'test',
    playerFactionId: 'blue',
    factions,
    seed,
    rngState: seed,
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
    planetSurfaceDescriptorsByBodyId: { [body.id]: descriptor },
    groundBuildings: [],
    objectives: { conditions: [] },
    rules: { fogOfWar: false, aiEnabled: false, useAdvancedCombat: true, totalWar: false, unlimitedFuel: false }
  };
  return { state, body };
};

const tests: TestCase[] = [
  {
    name: 'deriveTerrainType returns Urban for building tiles',
    run: () => {
      const { state: base, body } = createStateWithSurface(101, 'sys-terrain');
      const map = generateSurfaceMapForState(base, body.id)!;
      const { w } = map.descriptor.config;
      // pick first passable tile
      const idx = map.tiles.findIndex(t => t.biome !== 'ocean');
      assert.ok(idx >= 0);
      const q = idx % w;
      const r = Math.floor(idx / w);
      const state: GameState = {
        ...base,
        groundBuildings: [{ id: 'b', factionId: 'blue', type: 'outpost', surfacePos: { bodyId: body.id, q, r } }]
      };
      const terrain = deriveTerrainType(state, body.id, { q, r });
      assert.strictEqual(terrain, 'Urban');
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
const failures = results.filter(r => !r.success);
results.forEach(r => {
  if (r.success) console.log(`✅ ${r.name}`);
  else { console.error(`❌ ${r.name}`); console.error(r.error); }
});
if (failures.length > 0) process.exitCode = 1;
else console.log(`All tests passed (${results.length}/${results.length}).`);

