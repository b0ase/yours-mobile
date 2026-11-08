// bShares Pay, final check of 4b4f6f85: a stale sheet paid again after another tab or device had claimed (the claim
// cleared the record, so "none" still matched). Started from the reviewer's zzRe3 repro. Fails on 4b4f6f85.
import { describe, expect, test } from 'bun:test';
import {
  PAY_BUTTON,
  checkPayment,
  claimedKey,
  openedOver,
  payAndClaim,
  payNoteFor,
  payState,
  readClaimed,
  type PayDeps,
  type PayLock,
  type PayOutcome,
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
const QA = { quote_id: 'qa', memo: 'bitsign-bshares a', memo_script: '006a11aa' };
const QB = { quote_id: 'qb', memo: 'bitsign-bshares b', memo_script: '006a11bb' };
const TXA = 'aa'.repeat(32);
const TXB = 'bb'.repeat(32);

describe('(a) a claimed offer keeps a marker: stale sheets refuse, the card says Paid', () => {
  test('zzRe3: a sheet opened over "none" before another tab claimed does not pay', async () => {
    const store = memoStore();
    let pays = 0;
    const d: PayDeps = { store, lock: null, settleMs: 1, listActions: none, claim: async () => ({ ok: true }) };
    const oB = openedOver(store, 'o')!;
    const a = await payAndClaim(d, 'o', QA, async () => (pays++, { txid: TXA }), openedOver(store, 'o')!);
    const b = await payAndClaim(d, 'o', QB, async () => (pays++, { txid: TXB }), oB);
    expect(a.kind).toBe('claimed');
    expect(b.kind).toBe('changed');
    expect(pays).toBe(1);
    expect(readClaimed(store, 'o')).toBe(TXA);
    const s = payState(store, 'o');
    expect(s).toEqual({ kind: 'claimed', rec: { txid: TXA } });
    expect(PAY_BUTTON.claimed).toBeNull();
    expect(payNoteFor(s)).toContain(`Paid: transaction ${TXA}`);
    expect(openedOver(store, 'o')).toBeNull();
    expect((await checkPayment(d, 'o'))!.kind).toBe('claimed');
  });

  test('a claim answered refund_due leaves no Paid marker', async () => {
    const store = memoStore();
    const d: PayDeps = {
      store,
      lock: null,
      settleMs: 1,
      listActions: none,
      claim: async () => ({ status: 'refund_due' }),
    };
    expect((await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), { kind: 'none' })).kind).toBe('refund');
    expect(store.get(claimedKey('o'))).toBeNull();
  });
});

describe('(b)(c) a fresh look at Pay time, inside the lock, before anything is written or paid', () => {
  test('a stop from the fresh check: nothing written, nothing paid, that outcome', async () => {
    const store = memoStore();
    let pays = 0;
    const stop: PayOutcome = { kind: 'changed', message: 'A payment for this offer is waiting.' };
    const d: PayDeps = { store, lock: async (_n, fn) => fn(), listActions: none, claim: async () => ({ ok: true }) };
    const o = await payAndClaim(
      d,
      'o',
      QA,
      async () => (pays++, { txid: TXA }),
      { kind: 'none' },
      async () => stop,
    );
    expect(o).toBe(stop);
    expect(pays).toBe(0);
    expect(store.m.size).toBe(0);
  });

  test('it runs inside the lock, before the record is written', async () => {
    const store = memoStore();
    let inside = false;
    let sawRecord: boolean | null = null;
    let freshInside = false;
    const lock: PayLock = async (_n, fn) => {
      inside = true;
      try {
        return await fn();
      } finally {
        inside = false;
      }
    };
    const d: PayDeps = { store, lock, listActions: none, claim: async () => ({ ok: true }) };
    await payAndClaim(
      d,
      'o',
      QA,
      async () => ({ txid: TXA }),
      { kind: 'none' },
      async () => {
        freshInside = inside;
        sawRecord = store.m.size > 0;
        return null;
      },
    );
    expect(freshInside).toBe(true);
    expect(sawRecord).toBe(false);
  });

  test('the record changed while the fresh check ran (e.g. it found an unrecorded payment): changed, not paid', async () => {
    const store = memoStore();
    let pays = 0;
    const d: PayDeps = { store, lock: async (_n, fn) => fn(), listActions: none, claim: async () => ({ ok: true }) };
    const o = await payAndClaim(
      d,
      'o',
      QA,
      async () => (pays++, { txid: TXA }),
      { kind: 'none' },
      async () => {
        store.set(
          'bshares-claim:o',
          JSON.stringify({ quote_id: '', memo: '', memo_script: '', startedAt: 1, txid: TXB, orphan: true }),
        );
        return null;
      },
    );
    expect(o.kind).toBe('changed');
    expect(pays).toBe(0);
  });
});
