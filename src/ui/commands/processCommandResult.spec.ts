import assert from 'node:assert';
import { dispatchAndProcess, processCommandResult } from './processCommandResult';

const createNotifier = () => {
  const calls: string[] = [];
  const notify = (message: string) => {
    calls.push(message);
  };
  return { calls, notify };
};

{
  const { calls, notify } = createNotifier();
  const result = processCommandResult({ ok: true }, notify);
  assert.strictEqual(result, true, 'processCommandResult should return true for ok results');
  assert.deepStrictEqual(calls, [], 'No error should be reported on success');
}

{
  const { calls, notify } = createNotifier();
  const result = processCommandResult({ ok: false, error: 'Blocked' }, notify);
  assert.strictEqual(result, false, 'processCommandResult should return false on error');
  assert.deepStrictEqual(calls, ['Blocked'], 'Error message should be forwarded to notifier');
}

{
  const { calls, notify } = createNotifier();
  const result = processCommandResult(
    {
      ok: false,
      error: { code: 'INSUFFICIENT_FUEL', message: 'Insufficient fuel details', shortages: [] }
    },
    notify
  );
  assert.strictEqual(result, false, 'processCommandResult should return false on structured errors');
  assert.deepStrictEqual(calls, ['Insufficient fuel details'], 'Structured error messages should be forwarded');
}

{
  const { calls, notify } = createNotifier();
  const mockEngine = {
    dispatchPlayerCommand: () => ({ ok: false, error: 'Out of range', state: {} as any })
  };
  const processed = dispatchAndProcess(
    mockEngine,
    { type: 'MOVE_FLEET', fleetId: 'f1', targetSystemId: 's1' } as any,
    notify
  );
  assert.strictEqual(processed, false, 'dispatchAndProcess should return false when engine rejects command');
  assert.deepStrictEqual(calls, ['Out of range']);
}

console.log('processCommandResult tests passed');
