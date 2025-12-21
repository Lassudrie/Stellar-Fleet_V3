import assert from 'node:assert';
import { deepFreezeDev } from '../state/immutability';

interface TestCase {
  name: string;
  run: () => void;
}

const tests: TestCase[] = [
  {
    name: 'deepFreezeDev freeze l état en environnement de test et bloque les mutations',
    run: () => {
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'test';

      try {
        const state = { level1: { level2: 42 } };
        const frozen = deepFreezeDev(state);

        assert.ok(Object.isFrozen(frozen), 'L objet racine doit être gelé en environnement de test');
        assert.ok(Object.isFrozen(frozen.level1), 'Les objets imbriqués doivent être gelés également');

        assert.throws(
          () => {
            (frozen as any).level1.level2 = 7;
          },
          { name: 'TypeError' },
          'Les mutations doivent être bloquées sur les objets gelés'
        );
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
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
