import assert from 'node:assert';
import { applyToastDismissal } from '../ui/MessageToasts';

const initialHidden = new Set<string>();

const firstDismissal = applyToastDismissal(initialHidden, 'toast-1');
assert.strictEqual(firstDismissal.shouldNotify, true, 'First dismissal should notify consumers');
assert.ok(firstDismissal.nextHidden.has('toast-1'), 'Dismissed toast should be tracked as hidden');

const secondDismissal = applyToastDismissal(firstDismissal.nextHidden, 'toast-1');
assert.strictEqual(secondDismissal.shouldNotify, false, 'Repeated dismissal should not notify again');
assert.strictEqual(
  secondDismissal.nextHidden,
  firstDismissal.nextHidden,
  'Hidden set should be reused when no changes occur'
);

console.log('MessageToasts dismissal helper tests passed');
