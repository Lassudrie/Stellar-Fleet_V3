import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { RNG } from '../rng';
import { generateWorld } from '../../services/world/worldGenerator';
import { GameScenario } from '../../scenarios/types';

interface TestCase {
  name: string;
  run: () => void;
}

const loadSnapshot = <T>(name: string): T => {
  const content = readFileSync(new URL(`./__snapshots__/${name}.json`, import.meta.url), 'utf-8');
  return JSON.parse(content) as T;
};

const gaussianSnapshot = loadSnapshot<{
  seed: number;
  values: number[];
  state: number;
}>('rng.gaussian');

const worldSnapshot = loadSnapshot<{
  systems: Array<{
    name: string;
    position: { x: number; y: number; z: number };
    ownerFactionId: string | null;
    isHomeworld: boolean;
    resourceType: string;
  }>;
  fleetCount: number;
  armyCount: number;
  rngState: number;
}>('worldgen.deterministic');

const deterministicScenario: GameScenario = {
  schemaVersion: 1,
  id: 'deterministic_snapshot',
  seed: 1337,
  meta: {
    title: 'Determinism Snapshot',
    description: 'Minimal scenario used to validate cross-runtime determinism.',
    difficulty: 1,
    tags: ['determinism', 'test']
  },
  generation: {
    systemCount: 10,
    radius: 55,
    topology: 'cluster',
    minimumSystemSpacingLy: 4
  },
  setup: {
    factions: [
      { id: 'lyra', name: 'Lyra Alliance', colorHex: '#38bdf8', isPlayable: true },
      { id: 'draco', name: 'Draco Pact', colorHex: '#f97316', isPlayable: false, aiProfile: 'balanced' }
    ],
    startingDistribution: 'cluster',
    initialFleets: []
  },
  objectives: {
    win: [{ type: 'elimination' }]
  },
  rules: {
    fogOfWar: true,
    useAdvancedCombat: true,
    aiEnabled: false,
    totalWar: true
  }
};

const tests: TestCase[] = [
  {
    name: 'Gaussian approximation is deterministic across runtimes',
    run: () => {
      const rng = new RNG(gaussianSnapshot.seed);
      const values = gaussianSnapshot.values.map(() => Number(rng.gaussian().toFixed(6)));

      assert.deepStrictEqual(values, gaussianSnapshot.values, 'Gaussian sequence must match snapshot values');
      assert.strictEqual(rng.getState(), gaussianSnapshot.state, 'RNG state progression must be stable');
    }
  },
  {
    name: 'World generation stays aligned with snapshot expectations',
    run: () => {
      const { state, rng } = generateWorld(deterministicScenario);
      const summary = {
        systems: state.systems.map(system => ({
          name: system.name,
          position: {
            x: Number(system.position.x.toFixed(3)),
            y: Number(system.position.y.toFixed(3)),
            z: Number(system.position.z.toFixed(3))
          },
          ownerFactionId: system.ownerFactionId,
          isHomeworld: system.isHomeworld,
          resourceType: system.resourceType
        })),
        fleetCount: state.fleets.length,
        armyCount: state.armies.length,
        rngState: rng.getState()
      };

      assert.deepStrictEqual(summary, worldSnapshot, 'Generated world should remain snapshot-identical');
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
