// bShares Pay, after the final check of 50228001: a held payment was never asked about again, so a hold the directors
// later cleared (paid) or returned kept showing "held, don't pay again" for good. "Check again" re-claims it.
// Fails on 50228001 (recheck didn't exist: checkPayment answered 'held' without asking).
import { describe, expect, test } from 'bun:test';
import { ChatApiError } from '../chat/api';
import {
  PAY_BUTTON,
  checkPayment,
  failedKey,
  holdLiftedOnQuote,
  payState,
  readClaimed,
  recordHeld,
  type PayDeps,
  type PayStore,
} from './payFlow';

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
const TXA = 'aa'.repeat(32);
const heldRecord = (s: PayStore) =>
  s.set(failedKey('o'), JSON.stringify({ quote_id: 'qa', txid: TXA, code: 'payment_held', reason: 'held', tries: 1 }));
const refused = (code: string, extra: Record<string, unknown> = {}) =>
  new ChatApiError(code, 409, { error: code, code, ...extra });

describe('"Check again" on a held payment', () => {
  test('the button exists and only re-claims with the stored quote_id + txid', async () => {
    expect(PAY_BUTTON.held).toBe('Check again');
    const store = memoStore();
    heldRecord(store);
    const sent: unknown[] = [];
    const d: PayDeps = { store, listActions: none, claim: async (c) => (sent.push(c), { ok: true }) };
    expect((await checkPayment(d, 'o'))!.kind).toBe('claimed');
    expect(sent).toEqual([{ quote_id: 'qa', txid: TXA }]);
    expect(readClaimed(store, 'o')).toBe(TXA);
    expect(payState(store, 'o')).toEqual({ kind: 'claimed', rec: { txid: TXA } });
  });

  test('returned: records cleared, the returned note with both txids', async () => {
    const store = memoStore();
    heldRecord(store);
    const d: PayDeps = {
      store,
      listActions: none,
      claim: async () =>
        Promise.reject(
          refused('payment_returned', { payment_returned: true, payment_txid: TXA, refund_txid: 'ee'.repeat(32) }),
        ),
    };
    const o = await checkPayment(d, 'o');
    expect(o).toEqual({
      kind: 'returned',
      message: `Your payment ${TXA} was returned by the company (refund ${'ee'.repeat(32)}).`,
      txid: TXA,
    });
    expect(store.m.size).toBe(0);
  });

  test("still held, or a refusal it can't act on: the held record is left exactly as it was", async () => {
    for (const err of [
      refused('payment_held', { payment_held: true, payment_txid: TXA }),
      refused('quote_invalid', { retryable: false }),
      new Error('Network request failed'),
    ]) {
      const store = memoStore();
      heldRecord(store);
      const before = store.get(failedKey('o'));
      const d: PayDeps = { store, listActions: none, claim: async () => Promise.reject(err) };
      expect((await checkPayment(d, 'o'))!.kind).toBe('held');
      expect(store.get(failedKey('o'))).toBe(before);
    }
  });

  test('a hold from the quote route (no quote_id) is never claimed here; lifted → kept as a warned payment', async () => {
    const store = memoStore();
    recordHeld(store, 'o', TXA);
    let claims = 0;
    const d: PayDeps = { store, listActions: none, claim: async () => (claims++, { ok: true }) };
    expect((await checkPayment(d, 'o'))!.kind).toBe('held');
    expect(claims).toBe(0);
    holdLiftedOnQuote(store, 'o', TXA);
    expect(payState(store, 'o')).toMatchObject({ kind: 'pending', rec: { txid: TXA, orphan: true } });
  });
});
