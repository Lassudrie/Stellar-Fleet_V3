import assert from 'node:assert';
import type { PlanetBody, PlanetData } from '../../shared/types';
import { generateStellarSystem } from '../worldgen/stellarSystem';
import { buildPlanetBodies } from '../planets';
import { createPlanetSurfaceDescriptor, deriveSurfaceParamsFromPlanet, fnv1a32, generateSurfaceMap } from '../planetSurface';

interface TestCase {
  name: string;
  run: () => void;
}

const hashSurface = (map: ReturnType<typeof generateSurfaceMap>): number => {
  // Stable hash of the essential generated output.
  let h = fnv1a32(`${map.bodyId}|${map.systemId}|${map.seaLevelElev}|${map.descriptor.seed}`);
  for (const t of map.tiles) {
    h = fnv1a32(`${h}|${t.elev}|${t.tempC2}|${t.moist}|${t.biome}|${t.featureBits}`);
  }
  for (const s of map.settlements) {
    h = fnv1a32(`${h}|${s.id}|${s.type}|${s.factionId ?? ''}|${s.coord.q},${s.coord.r}|${s.population}|${s.isCapital ? 1 : 0}`);
  }
  return h >>> 0;
};

const getFirstSolidPlanet = (worldSeed: number, systemId: string): {
  body: PlanetBody;
  planetData: PlanetData;
} => {
  const astro = generateStellarSystem({ worldSeed, systemId });
  const system = { id: systemId, name: 'Test', ownerFactionId: null as any };
  const bodies = buildPlanetBodies(system, astro, []);
  const first = bodies.find(b => b.isSolid && b.bodyType === 'planet');
  assert.ok(first, 'Expected at least one solid planet body');

  // body ID scheme is planet-${systemId}-${planetIndex+1}
  const match = new RegExp(`^planet-${systemId}-(\\d+)$`).exec(first.id);
  assert.ok(match, `Expected a canonical planet id, got ${first.id}`);
  const planetIndex = Number(match[1]) - 1;
  assert.ok(Number.isFinite(planetIndex) && planetIndex >= 0);
  const planetData = astro.planets[planetIndex];
  assert.ok(planetData, 'Expected matching planet data');
  return { body: first, planetData };
};

const tests: TestCase[] = [
  {
    name: 'Planet surface generation is deterministic for same descriptor + astro inputs',
    run: () => {
      const worldSeed = 42;
      const systemId = 'sys_surface_test';
      const { body, planetData } = getFirstSolidPlanet(worldSeed, systemId);

      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });
      const a = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: 'blue' });
      const b = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: 'blue' });
      assert.strictEqual(hashSurface(a), hashSurface(b));
    }
  },
  {
    name: 'Generated surface respects grid dimensions and tile count',
    run: () => {
      const worldSeed = 7;
      const systemId = 'sys_surface_dims';
      const { body, planetData } = getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      assert.ok(map.tiles.length === descriptor.config.w * descriptor.config.h);
    }
  },
  {
    name: 'Settlements never spawn on water tiles',
    run: () => {
      const worldSeed = 99;
      const systemId = 'sys_surface_settlements';
      const { body, planetData } = getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: 'blue' });

      const w = descriptor.config.w;
      for (const s of map.settlements) {
        const idx = s.coord.r * w + s.coord.q;
        const biome = map.tiles[idx].biome;
        assert.ok(biome !== 'ocean' && biome !== 'coast' && biome !== 'lake', `Settlement spawned on water biome '${biome}'`);
      }
    }
  },
  {
    name: 'Water fraction roughly matches derived waterFraction (quantile sea level invariant)',
    run: () => {
      const worldSeed = 123;
      const systemId = 'sys_surface_water';
      const { body, planetData } = getFirstSolidPlanet(worldSeed, systemId);
      const descriptor = createPlanetSurfaceDescriptor({ gameSeed: worldSeed, systemId, body });
      const map = generateSurfaceMap({ systemId, bodyId: body.id, descriptor, planetData, ownerFactionId: null });

      const params = deriveSurfaceParamsFromPlanet(planetData);
      const water = map.tiles.filter(t => t.biome === 'ocean' || t.biome === 'coast' || t.biome === 'lake').length;
      const frac = water / map.tiles.length;

      assert.ok(Math.abs(frac - params.waterFraction) < 0.08, `Water fraction ${frac} deviates from expected ${params.waterFraction}`);
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

const successes = results.filter(result => result.success).length;
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

