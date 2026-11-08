// bShares Pay, nits on 42103e4e: the claimed marker only on a real paid answer (never on an HTML / empty 200 from a
// proxy or captive portal), and the softer "review resolved" wording. Fails on 42103e4e.
import { describe, expect, test } from 'bun:test';
import {
  checkPayment,
  failedKey,
  holdLiftedMessage,
  isPaidAnswer,
  payAndClaim,
  payState,
  readAttempts,
  readClaimed,
  type PayDeps,
  type PayStore,
} from './payFlow';
import type { ClaimAnswer } from './api';

const memoStore = (): PayStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return {
    m,
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
};
const none = async () => ({ totalActions: 0, actions: [] });
const QA = { quote_id: 'qa', memo: 'bitsign-bshares a', memo_script: '006a11aa' };
const TXA = 'aa'.repeat(32);
const junk: unknown[] = ['<html>captive portal</html>', '', null, {}, { ok: 'true' }, { status: 'accepted' }, []];

describe('isPaidAnswer', () => {
  test('ok === true, or an offer paid / approved / issued', () => {
    expect(isPaidAnswer({ ok: true })).toBe(true);
    for (const status of ['paid', 'approved', 'issued']) expect(isPaidAnswer({ status })).toBe(true);
  });
  test('never an HTML, empty or unrelated body', () => {
    for (const a of junk) expect(isPaidAnswer(a)).toBe(false);
  });
});

describe('a 2xx that is not a paid answer keeps every record and sets no marker', () => {
  for (const body of junk)
    test(`claim answered ${JSON.stringify(body)}`, async () => {
      const store = memoStore();
      const d: PayDeps = { store, lock: null, settleMs: 1, listActions: none, claim: async () => body as ClaimAnswer };
      const o = await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), { kind: 'none' });
      expect(o.kind).toBe('retry');
      expect(readClaimed(store, 'o')).toBeNull();
      expect(readAttempts(store, 'o')).toEqual([expect.objectContaining({ quote_id: 'qa', txid: TXA })]);
      expect(payState(store, 'o').kind).toBe('pending');
    });

  test('Check again on a held payment answered with HTML: still held, no marker', async () => {
    const store = memoStore();
    store.set(
      failedKey('o'),
      JSON.stringify({ quote_id: 'qa', txid: TXA, code: 'payment_held', reason: 'held', tries: 1 }),
    );
    const before = store.get(failedKey('o'));
    const d: PayDeps = { store, listActions: none, claim: async () => '<html></html>' as unknown as ClaimAnswer };
    expect((await checkPayment(d, 'o'))!.kind).toBe('held');
    expect(store.get(failedKey('o'))).toBe(before);
    expect(readClaimed(store, 'o')).toBeNull();
  });

  test('a real paid answer without ok (status paid) still counts', async () => {
    const store = memoStore();
    const d: PayDeps = { store, lock: null, settleMs: 1, listActions: none, claim: async () => ({ status: 'paid' }) };
    expect((await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), { kind: 'none' })).kind).toBe('claimed');
    expect(readClaimed(store, 'o')).toBe(TXA);
  });
});

test('a lifted hold reads "resolved the review", not "no longer held"', () =>
  expect(holdLiftedMessage(TXA)).toBe(
    `The company has resolved the review of transaction ${TXA}; ask the directors before paying again.`,
  ));
