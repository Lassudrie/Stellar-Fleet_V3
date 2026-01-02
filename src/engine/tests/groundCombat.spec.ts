import assert from 'node:assert';
import { resolveEngagement } from '../ground/combat';
import { rollTriangularCentered } from '../ground/random';
import { RNG } from '../rng';

import { ArmyState, type Army } from '../../shared/types';

interface TestCase {
  name: string;
  run: () => void;
}

const mkArmy = (overrides: Partial<Army> & Pick<Army, 'id' | 'factionId'>): Army => {
  const base: Army = {
    id: overrides.id,
    factionId: overrides.factionId,
    state: ArmyState.DEPLOYED,
    containerId: 'body-1',
    surfacePos: { bodyId: 'body-1', q: 0, r: 0 },
    unitType: 'mechanized_infantry',
    posture: 'normal',
    maxMembers: 10000,
    members: 10000,
    attack: 1,
    defense: 1,
    condition: 1
  };
  return { ...base, ...overrides };
};

const tests: TestCase[] = [
  {
    name: 'triangular RNG is bounded by epsilon',
    run: () => {
      const eps = 0.08;
      const rng = new RNG(123);
      for (let i = 0; i < 10000; i += 1) {
        const v = rollTriangularCentered(rng, eps);
        assert.ok(v >= 1 - eps && v <= 1 + eps, `Expected ${v} in [${1 - eps}, ${1 + eps}]`);
      }
    }
  },
  {
    name: 'engagement RNG is deterministic per (turn, attackerId, defenderId)',
    run: () => {
      const attacker = mkArmy({ id: 'a', factionId: 'blue', attack: 1.1 });
      const defender = mkArmy({ id: 'd', factionId: 'red', defense: 1.1 });

      const a = resolveEngagement(attacker, defender, { turn: 7, terrainType: 'Open' });
      const b = resolveEngagement(attacker, defender, { turn: 7, terrainType: 'Open' });
      assert.deepStrictEqual(a, b);
    }
  },
  {
    name: 'non-inversion guard math: if R0 <= 0.8519 then RNG cannot push above 1.0 (epsilon=0.08)',
    run: () => {
      const eps = 0.08;
      const maxRatio = (1 + eps) / (1 - eps);
      const threshold = 1 / maxRatio; // ~= 0.851851...
      assert.ok(Math.abs(threshold - 0.8518518518518519) < 1e-12);
      const r0 = threshold;
      const rMax = r0 * maxRatio;
      assert.ok(rMax <= 1.0 + 1e-12, `Expected rMax<=1, got ${rMax}`);
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

