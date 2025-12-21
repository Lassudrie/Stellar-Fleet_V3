import assert from 'node:assert';
import { applyContestedUnloadRisk } from '../armyOps';
import { CONTESTED_DROP_FAILURE_THRESHOLD, CONTESTED_DROP_LOSS_FRACTION } from '../constants/armyOps';
import { Army, ArmyState } from '../../types';
import { RNG } from '../rng';

interface TestCase {
  name: string;
  run: () => void;
}

const createArmy = (strength: number): Army => ({
  id: 'army-1',
  factionId: 'blue',
  strength,
  maxStrength: strength,
  morale: 1,
  state: ArmyState.EMBARKED,
  containerId: 'fleet-1'
});

const tests: TestCase[] = [
  {
    name: 'Contested unload applies configured failure loss',
    run: () => {
      const armies = [createArmy(100)];
      const failingRoll = Math.max(0, CONTESTED_DROP_FAILURE_THRESHOLD - 0.01);
      const rng = new RNG(1);
      rng.next = () => failingRoll;
      rng.id = () => 'log-fail';

      const outcome = applyContestedUnloadRisk(armies, ['army-1'], 'Alpha', 'Beta', 0, rng);

      const expectedLoss = Math.max(1, Math.floor(100 * CONTESTED_DROP_LOSS_FRACTION));
      assert.strictEqual(outcome.armies[0].strength, 100 - expectedLoss, 'Army strength should reflect contested loss fraction');
      assert.strictEqual(outcome.logs.length, 1, 'A failure log should be recorded');
    }
  },
  {
    name: 'Contested unload succeeds when roll meets threshold',
    run: () => {
      const armies = [createArmy(40)];
      const successRoll = CONTESTED_DROP_FAILURE_THRESHOLD;
      const rng = new RNG(2);
      rng.next = () => successRoll;
      rng.id = () => 'log-success';

      const outcome = applyContestedUnloadRisk(armies, ['army-1'], 'Alpha', undefined, 0, rng);

      assert.strictEqual(outcome.armies[0].strength, 40, 'Army strength should remain unchanged on success');
      assert.strictEqual(outcome.logs.length, 1, 'A success log should be recorded');
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

console.log(`armyOps.spec.ts: ${successes} successful, ${failures} failed.`);
if (failures > 0) {
  results
    .filter(result => !result.success)
    .forEach(result => console.error(`- ${result.name}: ${(result.error as Error).message}`));
}
