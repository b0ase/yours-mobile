import { describe, expect, test } from 'bun:test';
import { makeResilientTransport } from './resilientChromeTransport';

type Answer = { lastError?: string; response?: unknown; throws?: string };
const fakeRuntime = (answers: Answer[]) => {
  const calls: unknown[] = [];
  const rt = {
    id: 'ext',
    lastError: undefined as { message: string } | undefined,
    sendMessage: (msg: unknown, cb: (r: unknown) => void) => {
      calls.push(msg);
      const a = answers.shift() ?? { response: { success: true, data: 'late' } };
      if (a.throws) throw new Error(a.throws);
      rt.lastError = a.lastError ? { message: a.lastError } : undefined;
      cb(a.response);
      rt.lastError = undefined;
    },
  };
  return { rt, calls };
};
const noWait = () => Promise.resolve();

describe('resilient chrome transport', () => {
  test('retries once when the worker never got the message', async () => {
    const { rt, calls } = fakeRuntime([
      { lastError: 'Could not establish connection. Receiving end does not exist.' },
      { response: { success: true, data: { txid: 'x' } } },
    ]);
    const t = makeResilientTransport(() => rt, noWait);
    expect(await t('createAction', {})).toEqual({ txid: 'x' });
    expect(calls.length).toBe(2);
  });
  test('only once: a second undelivered error surfaces', async () => {
    const m = 'Could not establish connection. Receiving end does not exist.';
    const { rt, calls } = fakeRuntime([{ lastError: m }, { lastError: m }]);
    await expect(makeResilientTransport(() => rt, noWait)('createAction', {})).rejects.toThrow(/Receiving end/);
    expect(calls.length).toBe(2);
  });
  test('never retries after delivery (port closed mid-call): no double pay', async () => {
    const { rt, calls } = fakeRuntime([{ lastError: 'The message port closed before a response was received.' }]);
    await expect(makeResilientTransport(() => rt, noWait)('createAction', {})).rejects.toThrow(/port closed/);
    expect(calls.length).toBe(1);
  });
  test('never retries an error answer, and keeps code/detail', async () => {
    const { rt, calls } = fakeRuntime([
      { response: { success: false, error: 'An internal error has occurred.', detail: 'WERR_INTERNAL\nat x' } },
    ]);
    const e = await makeResilientTransport(() => rt, noWait)('createAction', {}).catch((x) => x);
    expect(e.message).toBe('An internal error has occurred.');
    expect(e.detail).toContain('WERR_INTERNAL');
    expect(calls.length).toBe(1);
  });
  test('empty answer is an error, not a TypeError', async () => {
    const { rt } = fakeRuntime([{ response: undefined }]);
    await expect(makeResilientTransport(() => rt, noWait)('listOutputs', {})).rejects.toThrow(/answered nothing/);
  });
  test('synchronous throw from a dead context is retried once', async () => {
    const { rt, calls } = fakeRuntime([
      { throws: 'Extension context invalidated.' },
      { response: { success: true, data: 1 } },
    ]);
    expect(await makeResilientTransport(() => rt, noWait)('getHeight', {})).toBe(1);
    expect(calls.length).toBe(2);
  });
});
