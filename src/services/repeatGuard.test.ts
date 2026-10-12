import { describe, expect, test } from 'bun:test';
import {
  QUEUED_MESSAGE,
  RepeatGuard,
  REPEAT_WINDOW_MS,
  queuedResult,
  queuedSend,
  repeatRefusal,
  requestFingerprint,
} from './repeatGuard';

const lock = (h: string) => `76a914${h.repeat(40).slice(0, 40)}88ac`;
const ord = (body: string) => `0063036f7264${body}68`;

describe('requestFingerprint', () => {
  test('the same inscription matches even with a fresh receive address', async () => {
    const a = await requestFingerprint({
      outputs: [{ lockingScript: ord('aa'.repeat(50)) + lock('1'), satoshis: 1, outputDescription: '' }],
    });
    const b = await requestFingerprint({
      outputs: [{ lockingScript: ord('aa'.repeat(50)) + lock('2'), satoshis: 1, outputDescription: '' }],
    });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
  test('different content does not match', async () => {
    const a = await requestFingerprint({ outputs: [{ lockingScript: ord('aa'), satoshis: 1, outputDescription: '' }] });
    const b = await requestFingerprint({ outputs: [{ lockingScript: ord('bb'), satoshis: 1, outputDescription: '' }] });
    expect(a).not.toBe(b);
  });
  test('small plain payments are not guarded (tips repeat)', async () => {
    expect(
      await requestFingerprint({ outputs: [{ lockingScript: lock('3'), satoshis: 500, outputDescription: '' }] }),
    ).toBeNull();
    expect(await requestFingerprint({ outputs: [] })).toBeNull();
  });
});

describe('RepeatGuard', () => {
  test('refuses a repeat inside the window, allows after it or after an abort', () => {
    let t = 1_000;
    const g = new RepeatGuard(() => t);
    g.record('fp', { reference: 'r1' });
    t += 60_000;
    expect(g.check('fp')?.reference).toBe('r1');
    g.aborted('r1');
    expect(g.check('fp')).toBeNull();
    g.record('fp', { reference: 'r2' });
    t += REPEAT_WINDOW_MS + 1;
    expect(g.check('fp')).toBeNull();
  });
  test('an abort by txid after signing clears it too', () => {
    const g = new RepeatGuard(() => 0);
    g.record('fp', { reference: 'r1' });
    g.signed('r1', 'tx1');
    g.aborted('tx1');
    expect(g.check('fp')).toBeNull();
  });
  test('message says how long ago', () => {
    expect(repeatRefusal({ at: 0 }, 4 * 60_000)).toContain('4 minutes ago');
  });
});

describe('queuedSend', () => {
  test('only all-sending results count as queued', () => {
    expect(queuedSend({ sendWithResults: [{ status: 'sending' }] })).toBe(true);
    expect(queuedSend({ sendWithResults: [{ status: 'failed' }] })).toBe(false);
    expect(queuedSend(new Error('x'))).toBe(false);
  });
});

describe('queuedResult', () => {
  const txid = 'ab'.repeat(32);
  test('a queued send answers with its txid, marked pending', () => {
    const r = queuedResult({ txid, sendWithResults: [{ txid, status: 'sending' }] });
    expect(r?.txid).toBe(txid);
    expect(r?.pending).toBe(true);
    expect(r?.message).toBe(QUEUED_MESSAGE);
    expect(r?.sendWithResults).toEqual([{ txid, status: 'sending' }]);
  });
  test('falls back to the txid in sendWithResults', () => {
    expect(queuedResult({ sendWithResults: [{ txid, status: 'sending' }] })?.txid).toBe(txid);
  });
  test('null for real failures and queued sends without a txid', () => {
    expect(queuedResult({ txid, sendWithResults: [{ txid, status: 'failed' }] })).toBeNull();
    expect(queuedResult(new Error('x'))).toBeNull();
    expect(queuedResult({ sendWithResults: [{ status: 'sending' }] })).toBeNull();
  });
});
