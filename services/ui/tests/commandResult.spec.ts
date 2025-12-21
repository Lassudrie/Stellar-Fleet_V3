import assert from 'node:assert';
import { processCommandResult } from '../commandResult';

const run = () => {
  const successLog: string[] = [];
  const successResult = processCommandResult(
    { ok: true },
    {
      onSuccess: () => successLog.push('success'),
      onError: () => successLog.push('error'),
      formatError: (err) => `formatted:${err ?? 'none'}`
    }
  );

  assert.strictEqual(successResult, true);
  assert.deepStrictEqual(successLog, ['success']);

  const errorLog: string[] = [];
  const errorResult = processCommandResult(
    { ok: false, error: 'bad' },
    {
      onSuccess: () => errorLog.push('success'),
      onError: (msg) => errorLog.push(msg),
      formatError: (err) => `formatted:${err ?? 'none'}`
    }
  );

  assert.strictEqual(errorResult, false);
  assert.deepStrictEqual(errorLog, ['formatted:bad']);

  const fallbackLog: string[] = [];
  processCommandResult(
    { ok: false },
    {
      onError: (msg) => fallbackLog.push(msg),
    }
  );

  assert.deepStrictEqual(fallbackLog, ['Unknown error']);
};

run();
