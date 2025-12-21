import assert from 'node:assert';
import { buildScenario } from '../../scenarios';
import { generateWorld } from '../../services/world/worldGenerator';
import { SPIRAL_CONVERGENCE_SEED_4242_SNAPSHOT, WorldSnapshot } from './fixtures/worldGenerationSnapshot';

interface TestCase {
  name: string;
  run: () => void;
}

const round = (value: number) => Number(value.toFixed(6));
const roundVec = (v: { x: number; y: number; z: number }) => ({
  x: round(v.x),
  y: round(v.y),
  z: round(v.z)
});

const tests: TestCase[] = [
  {
    name: 'World generation is deterministic for spiral_convergence @ seed 4242',
    run: () => {
      const scenario = buildScenario('spiral_convergence', 4242);
      const { state } = generateWorld(scenario);

      const homeworlds: Record<string, string> = {};
      state.systems.forEach(sys => {
        if (sys.isHomeworld && sys.ownerFactionId) {
          homeworlds[sys.ownerFactionId] = sys.id;
        }
      });

      const snapshot: WorldSnapshot = {
        seed: scenario.seed,
        topology: scenario.generation.topology,
        systemCount: state.systems.length,
        sampleSystems: state.systems.slice(0, 8).map(sys => ({
          id: sys.id,
          name: sys.name,
          position: roundVec(sys.position),
          ownerFactionId: sys.ownerFactionId,
          resourceType: sys.resourceType,
          isHomeworld: sys.isHomeworld
        })),
        homeworlds
      };

      assert.deepStrictEqual(snapshot, SPIRAL_CONVERGENCE_SEED_4242_SNAPSHOT);
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
