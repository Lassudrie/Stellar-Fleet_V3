import assert from 'node:assert';
import { RNG } from '../rng';
import { shortId } from '../idUtils';
import { RNG_SEED_1_SEQUENCE } from './fixtures/rngSequence';
import { RNG_GAUSSIAN_SEED_1_SEQUENCE } from './fixtures/rngGaussianSequence';

interface TestCase {
  name: string;
  run: () => void;
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const tests: TestCase[] = [
  {
    name: 'Mulberry32 sequence remains bit-for-bit stable for seed 1',
    run: () => {
      const rng = new RNG(1);
      const outputs = Array.from({ length: RNG_SEED_1_SEQUENCE.length }, () => rng.nextUint32());
      assert.deepStrictEqual(outputs, RNG_SEED_1_SEQUENCE);
    }
  },
  {
    name: 'Gaussian approximation remains stable for seed 1',
    run: () => {
      const rng = new RNG(1);
      const outputs = Array.from({ length: RNG_GAUSSIAN_SEED_1_SEQUENCE.length }, () => rng.gaussian());
      const epsilon = 1e-12;
      outputs.forEach((value, index) => {
        const expected = RNG_GAUSSIAN_SEED_1_SEQUENCE[index];
        assert.ok(
          Math.abs(value - expected) < epsilon,
          `Gaussian output at index ${index} diverged: expected ${expected}, got ${value}`
        );
      });
    }
  },
  {
    name: 'State normalization keeps increments within uint32 range',
    run: () => {
      const rng = new RNG(0xffffffff);
      rng.nextUint32();
      assert.strictEqual(rng.getState(), 0x6d2b79f4, 'State should wrap after uint32 overflow');

      rng.nextUint32();
      assert.strictEqual(rng.getState(), 0xda56f3e9, 'State should remain normalized across subsequent steps');
    }
  },
  {
    name: 'State round-trip preserves zero',
    run: () => {
      const rng = new RNG(123);
      rng.setState(0);
      assert.strictEqual(rng.getState(), 0, 'State should preserve zero');
      rng.setState(rng.getState());
      assert.strictEqual(rng.getState(), 0, 'State round-trip should be idempotent');
    }
  },
  {
    name: 'id() returns RFC4122 UUID v4 with deterministic prefix',
    run: () => {
      const rng = new RNG(1);
      const ids = Array.from({ length: 3 }, () => rng.id('fleet'));
      const expected = [
        'fleet_f3ea87a0-c949-4300-abc4-0687fd2726fb',
        'fleet_2b9de7f7-3066-4647-b001-e39c5c9f82b8',
        'fleet_7007016d-71b7-4cfe-8aa6-8c742e3b217d'
      ];
      assert.deepStrictEqual(ids, expected, 'UUID sequence for seed 1 should remain stable');
      ids.forEach(id => {
        const [, uuid] = id.split('_');
        assert.ok(UUID_V4_REGEX.test(uuid), `ID ${id} must include a valid UUID v4`);
      });
    }
  },
  {
    name: 'id() remains deterministic for identical seeds',
    run: () => {
      const rngA = new RNG(12345);
      const rngB = new RNG(12345);
      const sequenceA = Array.from({ length: 5 }, () => rngA.id('ship'));
      const sequenceB = Array.from({ length: 5 }, () => rngB.id('ship'));
      assert.deepStrictEqual(sequenceA, sequenceB, 'ID sequences should match for identical seeds');
    }
  },
  {
    name: 'id() generates unique UUIDs over a reasonable sequence',
    run: () => {
      const rng = new RNG(99);
      const count = 10_000;
      const seen = new Set<string>();

      for (let i = 0; i < count; i++) {
        const id = rng.id('x');
        const [, uuid] = id.split('_');
        if (seen.has(id)) {
          throw new Error(`Duplicate ID generated at iteration ${i}: ${id}`);
        }
        assert.ok(UUID_V4_REGEX.test(uuid), `Generated ID does not match UUID v4 format: ${id}`);
        seen.add(id);
      }

      assert.strictEqual(seen.size, count, 'All generated IDs should be unique');
    }
  },
  {
    name: 'shortId() returns a stable truncated segment for UUID-based IDs',
    run: () => {
      const id = 'fleet_550e8400-e29b-41d4-a716-446655440000';
      assert.strictEqual(shortId(id), '550E8400', 'shortId should return the first UUID segment in uppercase');
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
