import assert from 'node:assert';
import { interpretCommandResult } from '../commandOutcome';

const translate = (key: string, params?: Record<string, unknown>) => {
  if (key === 'msg.commandFailed') {
    return `Failed: ${params?.error ?? 'Unknown'}`;
  }
  if (typeof params?.defaultValue === 'string') {
    return params.defaultValue;
  }
  return key;
};

const okOutcome = interpretCommandResult({ ok: true }, translate);
assert.strictEqual(okOutcome.shouldClosePicker, true, 'Successful commands should close pickers');
assert.strictEqual(okOutcome.feedback, undefined, 'Successful commands should not create feedback');

const errorOutcome = interpretCommandResult({ ok: false, error: 'Not allowed' }, translate);
assert.strictEqual(errorOutcome.shouldClosePicker, false, 'Failed commands must keep pickers open');
assert.ok(errorOutcome.feedback);
assert.ok(errorOutcome.feedback?.message.includes('Not allowed'));
