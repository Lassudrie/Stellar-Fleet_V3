import assert from 'node:assert';
import { RNG } from '../rng';
import { RNG_SEED_12345_GAUSSIAN } from './fixtures/rngGaussianSnapshot';

interface TestCase {
  name: string;
  run: () => void;
}

const almostEqual = (a: number, b: number, epsilon = 1e-12) => Math.abs(a - b) <= epsilon;

const tests: TestCase[] = [
  {
    name: 'Gaussian approximation is stable for seed 12345',
    run: () => {
      const rng = new RNG(12345);
      const outputs = Array.from({ length: RNG_SEED_12345_GAUSSIAN.length }, () => rng.gaussian());

      outputs.forEach((value, idx) => {
        const expected = RNG_SEED_12345_GAUSSIAN[idx];
        assert.ok(
          almostEqual(value, expected),
          `Index ${idx} drifted: expected ${expected}, got ${value}`
        );
      });
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
