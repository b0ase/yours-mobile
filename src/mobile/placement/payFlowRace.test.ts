// bShares Pay, second re-review (8 Nov 2026). Started from the reviewer's repros (zzReviewRepro*.test.ts), which
// asserted the bugs on 08cb44bc (two tabs paid twice; a failed-record write loss dropped the payment; payment_held
// and quote_expired read as final); here they assert the fixed behaviour, plus one test per further finding.
import { describe, expect, test } from 'bun:test';
import { ChatApiError } from '../chat/api';
import {
  HELD_MESSAGE,
  PAY_BUTTON,
  QUOTE_MAX_AGE_MS,
  RAWTX_STORE_MAX,
  NOT_SEEN_DEAD_MS,
  checkPayment,
  claimVerdict,
  failedKey,
  findOrphanPayment,
  findPaidAction,
  openedOver,
  payAndClaim,
  payNoteFor,
  payState,
  pendingKey,
  quoteTooOld,
  readAttempts,
  readFailed,
  type ListActionsFn,
  type PayDeps,
  type PayStore,
} from './payFlow';

const memoStore = (): PayStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
};
const none: ListActionsFn = async () => ({ totalActions: 0, actions: [] });
const NONE = { kind: 'none' } as const;
const QA = { quote_id: 'qa', memo: 'bitsign-bshares a', memo_script: '006a11aa' };
const QB = { quote_id: 'qb', memo: 'bitsign-bshares b', memo_script: '006a11bb' };
const TXA = 'aa'.repeat(32);
const TXB = 'bb'.repeat(32);
const refused = (code: string, extra: Record<string, unknown> = {}, status = 409) =>
  new ChatApiError(`srv ${code}`, status, { error: `srv ${code}`, code, ...extra });
const waiting = () => {
  throw refused('not_confirmed', { payment_pending: true, retryable: true });
};
const MAYBE = "We can't confirm whether this went out. Check History before sending again.";

describe('#1 two tabs never pay twice (compare-and-set)', () => {
  test('B confirms a no-warning sheet while A is inside createAction: refused, one payment', async () => {
    const store = memoStore();
    let pays = 0;
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const d: PayDeps = { store, listActions: none, claim: async () => waiting() };
    // both tabs opened their sheet while nothing was recorded (no warning)
    const a = payAndClaim(
      d,
      'o',
      QA,
      async () => {
        pays++;
        await gate;
        return { txid: TXA };
      },
      NONE,
    );
    await Promise.resolve();
    const b = await payAndClaim(d, 'o', QB, async () => (pays++, { txid: TXB }), NONE);
    releaseA();
    const ra = await a;
    expect(b.kind).toBe('changed');
    expect(ra.kind).toBe('retry');
    expect(pays).toBe(1);
    expect(readAttempts(store, 'o')).toEqual([expect.objectContaining({ quote_id: 'qa', txid: TXA })]);
  });

  test('a warning sheet pays again only over the very attempt it warned about', async () => {
    const store = memoStore();
    const d: PayDeps = { store, listActions: none, claim: async () => waiting() };
    await payAndClaim(
      d,
      'o',
      QA,
      async () => {
        throw new Error(MAYBE);
      },
      NONE,
    );
    const warnedAbout = openedOver(store, 'o')!;
    expect(warnedAbout).toMatchObject({ kind: 'attempt', quote_id: 'qa' });
    // another tab paid again over it first
    let pays = 0;
    expect((await payAndClaim(d, 'o', QB, async () => (pays++, { txid: TXB }), warnedAbout)).kind).toBe('retry');
    const QC = { quote_id: 'qc', memo: 'bitsign-bshares c', memo_script: '006a11cc' };
    expect((await payAndClaim(d, 'o', QC, async () => (pays++, { txid: 'cc'.repeat(32) }), warnedAbout)).kind).toBe(
      'changed',
    );
    expect(pays).toBe(1);
  });

  test('"Pay again anyway" keeps the first attempt; the memo search looks for every attempt', async () => {
    const store = memoStore();
    const claimed: { quote_id: string; txid: string }[] = [];
    let listed: { txid: string; status: string; outputs: { lockingScript: string }[] }[] = [];
    const d: PayDeps = {
      store,
      listActions: async () => ({ totalActions: listed.length, actions: listed }),
      claim: async (c) => {
        claimed.push(c);
        return waiting();
      },
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
    await payAndClaim(
      d,
      'o',
      QB,
      async () => {
        throw new Error(MAYBE);
      },
      openedOver(store, 'o')!,
    );
    expect(readAttempts(store, 'o').map((a) => a.memo_script)).toEqual(['006a11aa', '006a11bb']);
    // the FIRST attempt turns up in the wallet: claimed with its own quote
    listed = [{ txid: TXA, status: 'unproven', outputs: [{ lockingScript: '006a11aa' }] }];
    expect((await checkPayment(d, 'o'))!.kind).toBe('retry');
    expect(claimed.at(-1)).toEqual({ quote_id: 'qa', txid: TXA });
  });

  test("the wallet's answer never overwrites another tab's record (only its own attempt, by quote_id)", async () => {
    const store = memoStore();
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const d: PayDeps = { store, listActions: none, claim: async () => waiting(), lock: async (_n, fn) => fn() };
    const a = payAndClaim(
      d,
      'o',
      QA,
      async () => {
        await gate;
        return { txid: TXA };
      },
      NONE,
    );
    await Promise.resolve();
    // meanwhile another tab replaced the record with its own attempt
    store.set(pendingKey('o'), JSON.stringify({ ...QB, startedAt: 7, txid: TXB }));
    releaseA();
    await a;
    const all = readAttempts(store, 'o');
    expect(all.find((x) => x.quote_id === 'qb')).toMatchObject({ txid: TXB });
    expect(all.find((x) => x.quote_id === 'qa')).toMatchObject({ txid: TXA });
  });
});

describe('#2 a failed claim never loses the payment record', () => {
  test('failed-record write fails (quota): the pending record stays, Check payment still claims it', async () => {
    const base = memoStore();
    const store: PayStore = {
      ...base,
      set: (k, v) => {
        if (k === failedKey('o')) return;
        base.set(k, v);
      },
    };
    const d: PayDeps = {
      store,
      listActions: none,
      claim: async () => Promise.reject(refused('no_memo', { retryable: false })),
    };
    const o = await payAndClaim(d, 'o', QA, async () => ({ txid: TXA, rawtx: 'ff'.repeat(1000) }), NONE);
    expect(o.kind).toBe('final');
    expect(payState(store, 'o')).toMatchObject({ kind: 'pending', rec: { txid: TXA } });
    expect(await checkPayment(d, 'o')).not.toBeNull();
  });

  test('a failed record too big with its rawtx is kept without it; only then is pending dropped', async () => {
    const base = memoStore();
    const store: PayStore = {
      ...base,
      set: (k, v) => (k === failedKey('o') && v.includes('ffff') ? undefined : base.set(k, v)),
    };
    const d: PayDeps = {
      store,
      listActions: none,
      claim: async () => Promise.reject(refused('no_memo', { retryable: false })),
    };
    await payAndClaim(d, 'o', QA, async () => ({ txid: TXA, rawtx: 'ff'.repeat(1000) }), NONE);
    expect(readFailed(store, 'o')).toMatchObject({ txid: TXA, code: 'no_memo' });
    expect(readFailed(store, 'o')!.rawtx).toBeUndefined();
    expect(base.get(pendingKey('o'))).toBeNull();
  });
});

describe('#3 payment_held: received, held for a compliance review', () => {
  test('claim 409 payment_held: held, its own words with the txid, no button, no refund wording', async () => {
    const store = memoStore();
    const err = refused('payment_held', { payment_held: true, payment_txid: TXA, retryable: false });
    expect(claimVerdict(err).kind).toBe('held');
    const d: PayDeps = { store, listActions: none, claim: async () => Promise.reject(err) };
    const o = await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), NONE);
    expect(o.kind).toBe('held');
    expect('message' in o && o.message).toBe(`${HELD_MESSAGE} Transaction ${TXA}.`);
    const s = payState(store, 'o');
    expect(s.kind).toBe('held');
    expect(PAY_BUTTON.held).toBe('Check again'); // re-claims only, never pays
    expect(payNoteFor(s)).toContain(HELD_MESSAGE);
    expect(payNoteFor(s)).not.toMatch(/refund/i);
    expect((await checkPayment(d, 'o'))!.kind).toBe('held');
    expect(openedOver(store, 'o')).toBeNull(); // no sheet may pay over it
  });
});

describe('#4 quote_expired and the quote age', () => {
  test('quote_expired is reclaimable (bit-sign records it once it confirms)', async () => {
    const store = memoStore();
    const d: PayDeps = {
      store,
      listActions: none,
      claim: async () => Promise.reject(refused('quote_expired', { retryable: false })),
    };
    expect((await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), NONE)).kind).toBe('reclaim');
    expect(payState(store, 'o').kind).toBe('reclaim');
  });
  test('quoteTooOld: by the monotonic clock, over 8 minutes, or a clock that ran backwards', () => {
    const at = (mono: number, wall = 5_000) => ({ mono, wall });
    expect(quoteTooOld(at(1000), at(1000 + QUOTE_MAX_AGE_MS))).toBe(false);
    expect(quoteTooOld(at(1000), at(1000 + QUOTE_MAX_AGE_MS + 1))).toBe(true);
    expect(quoteTooOld(at(1000), at(500))).toBe(true);
  });
});

describe('#5 the scan before a no-warning sheet', () => {
  const T = '5221' + '00'.repeat(10) + 'ae';
  const memo = (s: string) => `006a${s.length.toString(16).padStart(2, '0')}${Buffer.from(s).toString('hex')}`;
  const act = (txid: string, treasurySats: number, script = memo('bitsign-bshares xyz'), status = 'unproven') => ({
    txid,
    status,
    outputs: [
      { lockingScript: T, satoshis: treasurySats },
      { lockingScript: script, satoshis: 0 },
    ],
  });
  const lister = (labelled: ReturnType<typeof act>[], all: ReturnType<typeof act>[] = labelled) => {
    const calls: { labels: string[]; limit: number; offset: number }[] = [];
    const fn: ListActionsFn = async (a) => {
      calls.push(a);
      const src = a.labels.length ? labelled : all;
      return { totalActions: src.length, actions: src.slice(a.offset, a.offset + a.limit) };
    };
    return { fn, calls };
  };
  test('finds a bShares-memo payment to this treasury of at least the offer sats', async () => {
    const l = lister([act(TXA, 999), act(TXB, 1000)]);
    expect(await findOrphanPayment(l.fn, T, 1000, new Set())).toBe(TXB);
    expect(l.calls.every((c) => c.limit <= 100)).toBe(true);
  });
  test('skips payments an offer already shows, other memos, and never-sent actions', async () => {
    const l = lister([
      act(TXA, 1000),
      act(TXB, 1000, memo('bitsign-speak xyz')),
      act('cc'.repeat(32), 1000, undefined, 'nosend'),
    ]);
    expect(await findOrphanPayment(l.fn, T, 1000, new Set([TXA]))).toBeNull();
  });
  test('falls back to recent actions when none carries the label; errors are "none found"', async () => {
    const l = lister([], [act(TXA, 2000)]);
    expect(await findOrphanPayment(l.fn, T, 1000, new Set())).toBe(TXA);
    expect(l.calls.some((c) => c.labels.length === 0)).toBe(true);
    expect(
      await findOrphanPayment(
        async () => {
          throw new Error('closed');
        },
        T,
        1000,
        new Set(),
      ),
    ).toBeNull();
  });
});

describe('#6 rawtx kept small and once', () => {
  test(`over ${RAWTX_STORE_MAX} characters it is not stored, but the first claim still carries it`, async () => {
    const store = memoStore();
    const big = 'ab'.repeat(RAWTX_STORE_MAX);
    const sent: (string | undefined)[] = [];
    const d: PayDeps = {
      store,
      listActions: none,
      claim: async (c) => {
        sent.push(c.rawtx);
        return waiting();
      },
    };
    await payAndClaim(d, 'o', QA, async () => ({ txid: TXA, rawtx: big }), NONE);
    expect(sent[0]).toBe(big);
    expect(readAttempts(store, 'o')[0].rawtx).toBeUndefined();
    await checkPayment(d, 'o');
    expect(sent[1]).toBeUndefined();
  });
  test('moved, not copied, into the failed record', async () => {
    const store = memoStore();
    const d: PayDeps = {
      store,
      listActions: none,
      claim: async () => Promise.reject(refused('offer_changed', { retryable: false })),
    };
    await payAndClaim(d, 'o', QA, async () => ({ txid: TXA, rawtx: 'fe'.repeat(50) }), NONE);
    const hits = [...store.m.values()].filter((v) => v.includes('fe'.repeat(50)));
    expect(hits.length).toBe(1);
    expect(readFailed(store, 'o')!.rawtx).toBe('fe'.repeat(50));
  });
});

describe('#7 the remaining claim answers', () => {
  test('not_named_investor is reclaimable, like unauthenticated', () =>
    expect(claimVerdict(refused('not_named_investor', { retryable: false })).kind).toBe('reclaim'));

  test('quote_invalid three times: "Ask the directors", the txid, still never pays', async () => {
    const store = memoStore();
    let pays = 0;
    const d: PayDeps = {
      store,
      listActions: none,
      claim: async () => Promise.reject(refused('quote_invalid', { retryable: false })),
    };
    await payAndClaim(d, 'o', QA, async () => (pays++, { txid: TXA }), NONE);
    await checkPayment(d, 'o');
    const o = await checkPayment(d, 'o');
    expect(o && 'message' in o && o.message).toBe(
      `Ask the directors: quote no longer valid. Your payment is transaction ${TXA}. Don't pay again.`,
    );
    expect(payNoteFor(payState(store, 'o'))).toContain('Ask the directors: quote no longer valid');
    expect(readFailed(store, 'o')!.tries).toBe(3);
    expect(pays).toBe(1);
    expect(openedOver(store, 'o')).toBeNull();
  });

  test('not_seen past an hour: "Search my wallet again"; still in the wallet → claimed again, never paid', async () => {
    const store = memoStore();
    let t = 1_000_000;
    let listed: { txid: string; status: string; outputs: { lockingScript: string }[] }[] = [];
    const claims: string[] = [];
    const d: PayDeps = {
      store,
      now: () => t,
      listActions: async () => ({ totalActions: listed.length, actions: listed }),
      claim: async (c) => {
        claims.push(c.txid);
        throw refused('not_seen', { retryable: true, payment_pending: true }, 404);
      },
    };
    expect((await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), NONE)).kind).toBe('retry');
    t += NOT_SEEN_DEAD_MS + 1;
    expect(payState(store, 'o', t).kind).toBe('stale');
    expect(PAY_BUTTON.stale).toBe('Search my wallet again');
    expect(openedOver(store, 'o')).toBeNull();
    listed = [{ txid: TXA, status: 'sending', outputs: [{ lockingScript: '006a11aa' }] }];
    expect((await checkPayment(d, 'o'))!.kind).toBe('stale');
    expect(claims).toEqual([TXA, TXA]);
  });

  test('…gone from the wallet (failed / abandoned): warned "Pay again anyway" is allowed, the old attempt kept', async () => {
    const store = memoStore();
    let t = 1_000_000;
    const d: PayDeps = {
      store,
      now: () => t,
      listActions: none,
      claim: async () => {
        throw refused('not_seen', { retryable: true, payment_pending: true }, 404);
      },
    };
    await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), NONE);
    t += NOT_SEEN_DEAD_MS + 1;
    const o = await checkPayment(d, 'o');
    expect(o!.kind).toBe('check-first');
    expect(o && 'message' in o && o.message).toContain("We can't find transaction");
    const opened = openedOver(store, 'o')!;
    expect(opened).toMatchObject({ kind: 'attempt', quote_id: 'qa', txid: TXA });
    let pays = 0;
    await payAndClaim(d, 'o', QB, async () => (pays++, { txid: TXB }), opened);
    expect(pays).toBe(1);
    expect(readAttempts(store, 'o').map((a) => a.quote_id)).toEqual(['qa', 'qb']);
  });

  test('sanctions_unavailable (503, retryable): the record stays, Check payment re-claims, never pays', async () => {
    const store = memoStore();
    const err = refused(
      'sanctions_unavailable',
      {
        retryable: true,
        error: `Sanctions screening is unavailable right now. Your payment ${TXA} is safe: claim again shortly. Don't pay again.`,
      },
      503,
    );
    expect(claimVerdict(err).kind).toBe('retry');
    expect(claimVerdict(refused('sanctions_unavailable', {}, 503)).kind).toBe('retry');
    const d: PayDeps = { store, listActions: none, claim: async () => Promise.reject(err) };
    expect((await payAndClaim(d, 'o', QA, async () => ({ txid: TXA }), NONE)).kind).toBe('retry');
    expect(payState(store, 'o')).toMatchObject({ kind: 'pending', rec: { txid: TXA } });
    expect(PAY_BUTTON.pending).toBe('Check payment');
    expect(openedOver(store, 'o')).toBeNull();
  });

  test('findPaidAction takes several memo scripts and says which matched', async () => {
    const list: ListActionsFn = async () => ({
      totalActions: 1,
      actions: [{ txid: TXB, status: 'completed', outputs: [{ lockingScript: '006a11bb' }] }],
    });
    expect(await findPaidAction(list, ['006a11aa', '006A11BB'])).toEqual({
      found: true,
      txid: TXB,
      memo_script: '006a11bb',
    });
  });
});

describe('payment_returned (bit-sign 2f9cdd0e): the company already refunded it', () => {
  test('final: records cleared, both txids said, no button for it, never pays', async () => {
    const store = memoStore();
    const RF = 'ee'.repeat(32);
    const err = refused('payment_returned', {
      payment_returned: true,
      payment_txid: TXA,
      refund_txid: RF,
      already_claimed: true,
      retryable: false,
    });
    expect(claimVerdict(err).kind).toBe('returned');
    let pays = 0;
    const d: PayDeps = { store, listActions: none, claim: async () => Promise.reject(err) };
    const o = await payAndClaim(d, 'o', QA, async () => (pays++, { txid: TXA }), NONE);
    expect(o).toEqual({
      kind: 'returned',
      message: `Your payment ${TXA} was returned by the company (refund ${RF}).`,
      txid: TXA,
    });
    expect(store.m.size).toBe(0);
    expect(await checkPayment(d, 'o')).toBeNull();
    expect(pays).toBe(1);
  });
});
