import assert from 'node:assert';
import { handlePlayerCommandResult } from '../ui/commandFeedback';

const successCalls: string[] = [];
const errorMessages: string[] = [];

const successHandled = handlePlayerCommandResult(
  { ok: true },
  {
    onSuccess: () => successCalls.push('success'),
    onError: msg => errorMessages.push(msg),
    formatError: msg => `formatted:${msg ?? 'none'}`
  }
);

assert.strictEqual(successHandled, true, 'Success path should return true');
assert.deepStrictEqual(successCalls, ['success'], 'onSuccess should be invoked for successful commands');
assert.deepStrictEqual(errorMessages, [], 'onError should not be called for successful commands');

const failureHandled = handlePlayerCommandResult(
  { ok: false, error: 'blocked' },
  {
    onSuccess: () => successCalls.push('unexpected'),
    onError: msg => errorMessages.push(msg),
    formatError: msg => `formatted:${msg ?? 'none'}`
  }
);

assert.strictEqual(failureHandled, false, 'Failed commands should return false');
assert.deepStrictEqual(
  errorMessages,
  ['formatted:blocked'],
  'Formatted error should be forwarded to the error handler'
);
assert.deepStrictEqual(successCalls, ['success'], 'onSuccess should not be invoked for failures');

console.log('Command feedback handler tests passed');
