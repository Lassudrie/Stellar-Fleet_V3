import assert from 'node:assert';
import { RNG } from '../rng';
import { RNG_SEED_1_SEQUENCE } from './fixtures/rngSequence';

interface TestCase {
  name: string;
  run: () => void;
}

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
    name: 'State normalization keeps increments within uint32 range',
    run: () => {
      const rng = new RNG(0xffffffff);
      rng.nextUint32();
      assert.strictEqual(rng.getState(), 0x6d2b79f4, 'State should wrap after uint32 overflow');

      rng.nextUint32();
      assert.strictEqual(rng.getState(), 0xda56f3e9, 'State should remain normalized across subsequent steps');
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
