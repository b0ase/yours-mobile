// bShares Pay, third re-review of a42ace28 (8 Nov 2026, "ship with nits"). Started from the reviewer's zzRe2 repros;
// one test per nit. Every test here fails on a42ace28 (most of them on the new exports alone).
import { afterEach, describe, expect, test } from 'bun:test';
import { ChatApiError } from '../chat/api';
import {
  QUOTE_MAX_AGE_MS,
  NOT_SEEN_DEAD_MS,
  checkPayment,
  clocksNow,
  dropKnownOrphans,
  failedKey,
  findTxidAction,
  openedOver,
  payAndClaim,
  payNoteFor,
  payState,
  pendingKey,
  quoteTooOld,
  readAttempts,
  recordOrphan,
  recordedTxids,
  webLock,
  type ListActionsFn,
  type PayDeps,
  type PayLock,
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
const none: ListActionsFn = async () => ({ totalActions: 0, actions: [] });
const NONE = { kind: 'none' } as const;
const QA = { quote_id: 'qa', memo: 'bitsign-bshares a', memo_script: '006a11aa' };
const QB = { quote_id: 'qb', memo: 'bitsign-bshares b', memo_script: '006a11bb' };
const TXA = 'aa'.repeat(32);
const TXB = 'bb'.repeat(32);
const ncf = () => new ChatApiError('w', 409, { code: 'not_confirmed', payment_pending: true, retryable: true });
const MAYBE = "We can't confirm whether this went out. Check History before sending again.";
const list = (actions: { txid: string; status: string; outputs?: { lockingScript?: string; satoshis?: number }[] }[]) =>
  (async (a) => ({
    totalActions: actions.length,
    actions: actions.slice(a.offset, a.offset + a.limit),
  })) as ListActionsFn;

describe('reviewer repros (zzRe2), kept', () => {
  test('two tabs over the same opened state: one payment', async () => {
    const store = memoStore();
    let pays = 0;
    let rel!: () => void;
    const gate = new Promise<void>((r) => (rel = r));
    const d: PayDeps = { store, listActions: none, claim: async () => Promise.reject(ncf()), settleMs: 5 };
    const oA = openedOver(store, 'o')!;
    const oB = openedOver(store, 'o')!;
    const a = payAndClaim(
      d,
      'o',
      QA,
      async () => {
        pays++;
        await gate;
        return { txid: TXA };
      },
      oA,
    );
    const b = await payAndClaim(d, 'o', QB, async () => (pays++, { txid: TXB }), oB);
    rel();
    await a;
    expect(b.kind).toBe('changed');
    expect(pays).toBe(1);
  });

  test('failed-record write fails: the pending record is kept', async () => {
    const base = memoStore();
    const store: PayStore = { ...base, set: (k, v) => (k === failedKey('o') ? undefined : base.set(k, v)) };
    const d: PayDeps = {
      store,
      settleMs: 1,
      listActions: none,
      claim: async () => Promise.reject(new ChatApiError('x', 409, { code: 'underpaid', retryable: false })),
    };
    await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), NONE);
    expect(payState(store, 'o').kind).not.toBe('none');
  });
});

describe('#1 the cross-tab step is atomic beyond localStorage', () => {
  test('Web Locks held by another tab: "changed", nothing written, nothing paid', async () => {
    const store = memoStore();
    let pays = 0;
    const busy: PayLock = async () => null; // ifAvailable: another holder
    const d: PayDeps = { store, listActions: none, claim: async () => ({ ok: true }), lock: busy };
    const o = await payAndClaim(d, 'o', QA, async () => (pays++, { txid: TXA }), NONE);
    expect(o.kind).toBe('changed');
    expect(pays).toBe(0);
    expect(store.m.size).toBe(0);
  });

  test('the lock covers check + write + createAction, named per offer', async () => {
    const store = memoStore();
    const seen: string[] = [];
    let inside = false;
    const lock: PayLock = async (name, fn) => {
      seen.push(name);
      inside = true;
      try {
        return await fn();
      } finally {
        inside = false;
      }
    };
    let paidInside = false;
    const d: PayDeps = { store, listActions: none, claim: async () => Promise.reject(ncf()), lock };
    await payAndClaim(d, 'o1', QA, async () => ((paidInside = inside), { txid: TXA }), NONE);
    expect(seen).toEqual(['bshares-pay:o1']);
    expect(paidInside).toBe(true);
  });

  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  afterEach(() => {
    if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
    else delete (globalThis as { navigator?: unknown }).navigator;
  });
  test('webLock uses navigator.locks with ifAvailable', async () => {
    const calls: unknown[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (name: string, opts: unknown, cb: (l: unknown) => unknown) => (
            calls.push([name, opts]),
            cb(null)
          ),
        },
      },
    });
    const l = webLock()!;
    expect(await l('n', async () => 1)).toBeNull();
    expect(calls).toEqual([['n', { ifAvailable: true }]]);
  });

  test("no Web Locks: another tab's write landing after ours → we step back after the settle, nothing paid", async () => {
    const base = memoStore();
    let armed = false;
    // localStorage isn't atomic across processes: the other tab's whole record lands right after our read-back.
    const store: PayStore = {
      ...base,
      set: (k, v) => {
        base.set(k, v);
        if (k === pendingKey('o') && v.includes('"qa"') && !v.includes('"qb"')) armed = true;
      },
      get: (k) => {
        const v = base.get(k);
        if (armed && k === pendingKey('o')) {
          armed = false;
          base.set(k, JSON.stringify({ ...QB, startedAt: 9 }));
        }
        return v;
      },
    };
    let pays = 0;
    const d: PayDeps = { store, listActions: none, claim: async () => ({ ok: true }), lock: null, settleMs: 5 };
    const o = await payAndClaim(d, 'o', QA, async () => (pays++, { txid: TXA }), NONE);
    // our own write read back fine at first (writeAttempts), so only the settle re-read catches it
    expect(o.kind).toBe('changed');
    expect(pays).toBe(0);
    expect(readAttempts(base, 'o')).toEqual([expect.objectContaining({ quote_id: 'qb' })]);
  });

  test("our write lost to another tab's: not sent, and the other tab's record is left alone", async () => {
    const base = memoStore();
    const store: PayStore = {
      ...base,
      set: (k, v) => (k === pendingKey('o') ? base.set(k, JSON.stringify({ ...QB, startedAt: 9 })) : base.set(k, v)),
    };
    let pays = 0;
    const d: PayDeps = { store, listActions: none, claim: async () => ({ ok: true }), lock: null, settleMs: 1 };
    expect((await payAndClaim(d, 'o', QA, async () => (pays++, { txid: TXA }), NONE)).kind).toBe('not-sent');
    expect(pays).toBe(0);
    expect(readAttempts(base, 'o')).toEqual([expect.objectContaining({ quote_id: 'qb' })]);
  });
});

describe('#2 "Search my wallet again" also looks the txid up', () => {
  test('wallet lists the tx but without output scripts: claimed again, not abandoned (zzRe2)', async () => {
    const store = memoStore();
    let t = 1000;
    const listed = { txid: TXA, status: 'unproven', outputs: [{ satoshis: 0 }] };
    const claims: string[] = [];
    const d: PayDeps = {
      store,
      now: () => t,
      settleMs: 1,
      listActions: list([listed]),
      claim: async (c) => {
        claims.push(c.txid);
        throw new ChatApiError('ns', 404, { code: 'not_seen', payment_pending: true, retryable: true });
      },
    };
    await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), NONE);
    t += 2 * 3600_000;
    expect(payState(store, 'o', t).kind).toBe('stale');
    const r = await checkPayment(d, 'o');
    expect(r?.kind).not.toBe('check-first');
    expect(claims).toEqual([TXA, TXA]);
    expect(openedOver(store, 'o')).toBeNull();
    expect(readAttempts(store, 'o')[0].abandoned).toBeUndefined();
  });

  test('findTxidAction: newest first, no label filter; sent / absent / unchecked', async () => {
    const labels: string[][] = [];
    const many = Array.from({ length: 2500 }, (_, i) => ({
      txid: i.toString(16).padStart(64, '0'),
      status: 'completed',
    }));
    const l: ListActionsFn = async (a) => (labels.push(a.labels), list(many)(a));
    expect(await findTxidAction(l, many[2499].txid)).toBe('sent');
    expect(labels.every((x) => x.length === 0)).toBe(true);
    expect(await findTxidAction(l, many[3].txid)).toBe('sent');
    expect(await findTxidAction(l, 'ff'.repeat(32))).toBe('absent');
    expect(await findTxidAction(list([{ txid: TXA, status: 'nosend' }]), TXA)).toBe('absent');
    const huge = (async (a) => ({
      totalActions: 50_000,
      actions: Array.from({ length: a.limit }, () => ({ txid: TXB, status: 'completed' })),
    })) as ListActionsFn;
    expect(await findTxidAction(huge, TXA)).toBeNull();
  });

  test('abandoned only when neither lookup lists it as sent; softer words', async () => {
    const store = memoStore();
    let t = 1000;
    const d: PayDeps = {
      store,
      now: () => t,
      settleMs: 1,
      listActions: none,
      claim: async () => {
        throw new ChatApiError('ns', 404, { code: 'not_seen', payment_pending: true, retryable: true });
      },
    };
    await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), NONE);
    t += NOT_SEEN_DEAD_MS + 1;
    const r = await checkPayment(d, 'o');
    expect(r?.kind).toBe('check-first');
    expect(r && 'message' in r && r.message).toContain(`We can't find transaction ${TXA} in this wallet`);
    expect(readAttempts(store, 'o')[0].abandoned).toBe(true);
  });
});

describe('#3 the scan never blames another offer, and its warning clears', () => {
  test("recordedTxids: every txid this device holds for other offers (pending and failed), not this one's", () => {
    const s = memoStore();
    s.set(pendingKey('other'), JSON.stringify({ ...QA, startedAt: 1, txid: TXA }));
    s.set(failedKey('third'), JSON.stringify({ quote_id: 'q', txid: TXB, code: 'no_memo', reason: 'r' }));
    s.set(pendingKey('o'), JSON.stringify({ ...QB, startedAt: 1, txid: 'cc'.repeat(32) }));
    expect([...recordedTxids(s, 'o')].sort()).toEqual([TXA, TXB]);
  });

  test('an orphan whose txid an offer now shows as its payment is dropped', () => {
    const s = memoStore();
    recordOrphan(s, 'o', TXA);
    expect(payNoteFor(payState(s, 'o'))).toContain(TXA);
    dropKnownOrphans(s, 'o', new Set([TXB]));
    expect(readAttempts(s, 'o').length).toBe(1);
    dropKnownOrphans(s, 'o', new Set([TXA]));
    expect(payState(s, 'o').kind).toBe('none');
  });
});

describe('#4 the quote age counts device sleep', () => {
  test('too old when the wall clock says over 8 minutes even if performance.now() paused', () => {
    expect(quoteTooOld({ mono: 100, wall: 0 }, { mono: 200, wall: QUOTE_MAX_AGE_MS + 1 })).toBe(true);
    expect(quoteTooOld({ mono: 100, wall: 0 }, { mono: 100 + QUOTE_MAX_AGE_MS + 1, wall: 10 })).toBe(true);
    expect(quoteTooOld({ mono: 100, wall: 5000 }, { mono: 200, wall: 4000 })).toBe(true);
    expect(quoteTooOld({ mono: 100, wall: 5000 }, { mono: 200, wall: 6000 })).toBe(false);
    const c = clocksNow();
    expect(typeof c.mono).toBe('number');
    expect(typeof c.wall).toBe('number');
  });
});

describe('#5 a claim drops only its own attempt', () => {
  test('claimed attempt 2 keeps unfound attempt 1 (zzRe2)', async () => {
    const store = memoStore();
    const d: PayDeps = { store, listActions: none, settleMs: 1, claim: async () => ({ ok: true }) };
    expect(
      (
        await payAndClaim(
          d,
          'o',
          QA,
          async () => {
            throw new Error(MAYBE);
          },
          NONE,
        )
      ).kind,
    ).toBe('maybe-sent');
    const o2 = await payAndClaim(d, 'o', QB, async () => ({ txid: TXB }), openedOver(store, 'o')!);
    expect(o2).toEqual({ kind: 'claimed' });
    expect(readAttempts(store, 'o')).toEqual([expect.objectContaining({ quote_id: 'qa' })]);
  });

  test('…and if attempt 1 also went out: kept for a refund, "An earlier attempt also went out"', async () => {
    const store = memoStore();
    let listed: { txid: string; status: string; outputs: { lockingScript: string }[] }[] = [];
    const d: PayDeps = {
      store,
      settleMs: 1,
      listActions: async (a) => list(listed)(a),
      claim: async () => ({ ok: true }),
    };
    await payAndClaim(
      d,
      'o',
      QA,
      async () => {
        throw new Error(MAYBE);
      },
      NONE,
    );
    const opened = openedOver(store, 'o')!;
    listed = [];
    const o2 = await payAndClaim(
      d,
      'o',
      QB,
      async () => {
        // attempt 1 turns up in the wallet while attempt 2 is being paid
        listed = [{ txid: TXA, status: 'completed', outputs: [{ lockingScript: '006a11aa' }] }];
        return { txid: TXB };
      },
      opened,
    );
    expect(o2).toEqual({
      kind: 'claimed',
      message: `An earlier attempt also went out: ask the directors to refund transaction ${TXA}.`,
    });
    const s = payState(store, 'o');
    expect(s).toMatchObject({ kind: 'pending', rec: { txid: TXA, extra: true } });
    expect(payNoteFor(s)).toContain('ask the directors to refund transaction');
    // never claimed again, and no sheet pays over it without the warning
    expect(openedOver(store, 'o')).toMatchObject({ kind: 'attempt' });
  });
});
