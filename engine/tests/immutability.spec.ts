import assert from 'node:assert';
import { deepFreezeDev } from '../state/immutability';

interface TestCase {
  name: string;
  run: () => void;
}

const withNodeEnv = (value: string | undefined, run: () => void) => {
  const previous = process.env.NODE_ENV;

  if (typeof value === 'undefined') {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }

  try {
    run();
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
};

const tests: TestCase[] = [
  {
    name: 'deepFreezeDev freezes objects and blocks mutations in test environment',
    run: () =>
      withNodeEnv('test', () => {
        const state = { nested: { value: 1 }, list: [1, 2, 3] } as const;

        deepFreezeDev(state);

        assert(Object.isFrozen(state), 'root object should be frozen in test env');
        assert(Object.isFrozen(state.nested), 'nested object should be frozen in test env');
        assert(Object.isFrozen(state.list), 'arrays should also be frozen in test env');

        assert.throws(() => {
          (state as any).nested.value = 2;
        }, TypeError);
      })
  },
  {
    name: 'deepFreezeDev is inert outside dev/test environments',
    run: () =>
      withNodeEnv('production', () => {
        const state = { counter: 0, nested: { value: 1 } };

        deepFreezeDev(state);

        assert(!Object.isFrozen(state), 'root object should remain unfrozen in production');
        state.counter += 1;
        state.nested.value = 5;

        assert.strictEqual(state.counter, 1);
        assert.strictEqual(state.nested.value, 5);
      })
  }
];

tests.forEach(test => {
  try {
    test.run();
    console.log(`✅ ${test.name}`);
  } catch (error) {
    console.error(`❌ ${test.name}`);
    console.error(error);
    process.exitCode = 1;
  }
});
