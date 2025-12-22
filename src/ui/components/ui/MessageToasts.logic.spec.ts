import assert from 'node:assert';
import { computeHiddenToastState } from './MessageToasts';

{
  const initial = new Set<string>();
  const { next, changed } = computeHiddenToastState(initial, 'm1');
  assert.strictEqual(changed, true, 'First hide should be reported as changed');
  assert.ok(next.has('m1'), 'Toast id should be added to hidden set');
}

{
  const initial = new Set<string>(['m1']);
  const { next, changed } = computeHiddenToastState(initial, 'm1');
  assert.strictEqual(changed, false, 'Hiding the same toast twice should be ignored');
  assert.strictEqual(next, initial, 'Hidden set should be reused when nothing changes');
}

console.log('MessageToasts logic tests passed');
