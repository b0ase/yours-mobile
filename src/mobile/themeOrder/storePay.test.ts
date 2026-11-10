import { describe, expect, test } from 'bun:test';
import { OP, Script, Utils } from '@bsv/sdk';
import {
  localOutbox,
  memoryOutbox,
  OUTBOX_KEEP_MS,
  pruneOutbox,
  recordNewPayment,
  REFUSED_KEEP_MS,
  sendStorePayment,
  storeMemo,
  StorePayError,
  type OutboxEntry,
  type StorePayDeps,
} from './storePay';

const T = 'ab'.repeat(32);
const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  kind: 'buy',
  quoteId: 'q'.repeat(32),
  txid: T,
  beefHex: '00',
  key: 'emoji-cool',
  state: 'signed',
  at: 1_000,
  ...over,
});

describe('the Store outbox (P0, 3 Nov 2026)', () => {
  test('localOutbox keeps entries per identity; a write that did not stick THROWS (nothing may be sent then)', () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const a = localOutbox('02aa', kv);
    a.put(entry());
    a.put(entry({ state: 'sent' }));
    expect(a.all()).toEqual([entry({ state: 'sent' })]);
    expect(localOutbox('03bb', kv).all()).toEqual([]);
    a.drop(T);
    expect(a.all()).toEqual([]);
    const broken = localOutbox('02aa', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    });
    expect(() => broken.put(entry())).toThrow();
    expect(broken.all()).toEqual([]);
    expect(() => broken.drop(T)).not.toThrow();
    // A store that accepts the write but keeps nothing (quota, eviction) is caught by the read-back.
    const forgetful = localOutbox('02dd', { getItem: () => null, setItem: () => undefined });
    expect(() => forgetful.put(entry())).toThrow(/did not keep/);
    m.set('bwx-store-outbox:02cc', 'not json');
    expect(localOutbox('02cc', kv).all()).toEqual([]);
  });

  test('entries older than the keep time are dropped', () => {
    const o = memoryOutbox();
    o.put(entry({ at: 0 }));
    o.put(entry({ txid: 'cd'.repeat(32), at: OUTBOX_KEEP_MS }));
    expect(pruneOutbox(o, OUTBOX_KEEP_MS + 1).map((e) => e.txid)).toEqual(['cd'.repeat(32)]);
  });

  test("the wallet couldn't send it and the chain doesn't have it: kept to send again, nothing claimed", async () => {
    const o = memoryOutbox();
    const wallet = {
      abortAction: async () => {
        throw new Error('never');
      },
      createAction: async () => {
        throw new Error('offline');
      },
    };
    const e = await sendStorePayment(wallet, entry(), {
      backup: async () => ({ ok: true }),
      outbox: o,
      lookups: [async () => 'missing'],
      log: () => undefined,
    }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(StorePayError);
    expect((e as StorePayError).code).toBe('not_sent');
    expect((e as StorePayError).sent).toBe(true);
    expect(o.all()[0].state).toBe('sending');
  });

  test('backup first: a failed backup never reaches the wallet send', async () => {
    let sends = 0;
    const wallet = {
      abortAction: async () => undefined,
      createAction: async () => (sends++, {}),
    };
    const o = memoryOutbox();
    await expect(
      sendStorePayment(wallet, entry(), {
        backup: async () => ({ ok: false, error: 'offline' }),
        outbox: o,
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'backup_failed', sent: false });
    expect(sends).toBe(0);
    expect(o.all()).toEqual([]);
  });
});

/** A wallet whose sendWith answers as given (WERR_REVIEW_ACTIONS shape for a refusal). */
const answering = (kind: 'refused' | 'unknown' | 'sent') => ({
  abortAction: async () => {
    throw new Error('never aborts');
  },
  createAction: async () => {
    if (kind === 'sent') return { sendWithResults: [{ txid: T, status: 'unproven' }] };
    if (kind === 'unknown') return { sendWithResults: [{ txid: T, status: 'failed' }] };
    throw Object.assign(new Error('WERR_REVIEW_ACTIONS'), {
      sendWithResults: [{ txid: T, status: 'failed' }],
      reviewActionResults: [{ txid: T, status: 'invalidTx' }],
    });
  },
});
const base = (over: Partial<StorePayDeps> = {}): StorePayDeps => ({
  backup: async () => ({ ok: true }),
  outbox: memoryOutbox(),
  lookups: [async () => 'missing'],
  releaseLookups: [async () => 'missing'],
  recheckDelaysMs: [0],
  sleep: async () => undefined,
  log: () => undefined,
  ...over,
});

describe('review 4 Nov 2026', () => {
  test('M8: after a refusal (or no answer) the chain is asked: if it has the payment, it went out', async () => {
    for (const kind of ['refused', 'unknown'] as const) {
      const d = base({ lookups: [async () => 'seen'] });
      expect(await sendStorePayment(answering(kind), entry({ state: 'sending' }), d)).toBe('sent');
      expect(d.outbox.all()[0].state).toBe('sent');
    }
  });

  test('F1: a refusal is never dropped on one look: kept as refused, the buyer is not told "nothing was paid"', async () => {
    const d = base({ actionStatus: async () => 'failed' });
    const e = await sendStorePayment(answering('refused'), entry({ state: 'sending' }), d).then(
      () => null,
      (x: unknown) => x as StorePayError,
    );
    expect(e?.code).toBe('refused_so_far');
    expect(e?.message).not.toMatch(/Nothing was paid/);
    const [kept] = d.outbox.all();
    expect(kept.state).toBe('refused');
    // The next Store open: still not on chain, still kept (inside the day).
    const again = await sendStorePayment(answering('refused'), kept, {
      ...d,
      now: () => kept.refusedAt! + 60_000,
    }).catch((x: StorePayError) => x.code);
    expect(again).toBe('refused_so_far');
    expect(d.outbox.all().length).toBe(1);
    // It turns up: sent (and then claimed by the caller).
    expect(await sendStorePayment(answering('refused'), kept, { ...d, lookups: [async () => 'seen'] })).toBe('sent');
  });

  test('F1/F3: a refused entry is cleared only after a day, failed in the wallet AND missing over the retries', async () => {
    const d = base({ actionStatus: async () => 'failed' });
    const refused = entry({ state: 'refused', refusedAt: 1_000 });
    d.outbox.put(refused);
    const late = { ...d, now: () => 1_000 + REFUSED_KEEP_MS + 1 };
    expect(await sendStorePayment(answering('refused'), refused, late).catch((x: StorePayError) => x.code)).toBe(
      'refused_cleared',
    );
    expect(d.outbox.all()).toEqual([]);
    // Still a live action in the wallet: kept.
    const live = base({ actionStatus: async () => 'unproven' });
    live.outbox.put(refused);
    const r = await sendStorePayment(answering('refused'), refused, { ...live, now: late.now }).catch(
      (x: StorePayError) => x.code,
    );
    expect(r).toBe('refused_so_far');
    // The chain unclear during the retries: kept.
    const unclear = base({ actionStatus: async () => 'failed', releaseLookups: [async () => 'unclear'] });
    unclear.outbox.put(refused);
    expect(
      await sendStorePayment(answering('refused'), refused, { ...unclear, now: late.now }).catch(
        (x: StorePayError) => x.code,
      ),
    ).toBe('refused_so_far');
  });

  test('F3: nothing posted, the action failed or gone, and the chain has nothing: the entry is cleared', async () => {
    for (const status of ['failed', undefined]) {
      const d = base({ actionStatus: async () => status });
      d.outbox.put(entry({ state: 'sending' }));
      const r = await sendStorePayment(answering('unknown'), entry({ state: 'sending' }), d).catch(
        (x: StorePayError) => x.code,
      );
      expect(r).toBe('cleared');
      expect(d.outbox.all()).toEqual([]);
    }
    // A live nosend row: kept to send again.
    const d = base({ actionStatus: async () => 'nosend' });
    expect(
      await sendStorePayment(answering('unknown'), entry({ state: 'sending' }), d).catch((x: StorePayError) => x.code),
    ).toBe('not_sent');
  });

  test('F2: the Store is told first; refused → released, never sent; unreachable → kept unsent', async () => {
    let sends = 0;
    const w = {
      ...answering('sent'),
      createAction: async () => (sends++, { sendWithResults: [{ txid: T, status: 'unproven' }] }),
    };
    const released: string[] = [];
    const refusedD = base({
      intent: async () => ({ ok: false, refused: true, error: 'That price ran out.', code: 'quote_expired' }),
      releaseUnsent: async (t) => void released.push(t),
    });
    refusedD.outbox.put(entry());
    const e1 = await sendStorePayment(w, entry(), refusedD).catch((x: StorePayError) => x);
    expect([e1.code, e1.sent, e1.message]).toEqual(['intent_refused', false, 'That price ran out.']);
    expect(released).toEqual([T]);
    expect(refusedD.outbox.all()).toEqual([]);
    const downD = base({ intent: async () => ({ ok: false, refused: false, error: 'Failed to fetch' }) });
    downD.outbox.put(entry());
    expect((await sendStorePayment(w, entry(), downD).catch((x: StorePayError) => x)).code).toBe('store_unreachable');
    expect(downD.outbox.all()[0].state).toBe('signed');
    expect(sends).toBe(0);
    // The intent goes through: then (and only then) the wallet sends.
    const order: string[] = [];
    const okD = base({
      intent: async () => (order.push('intent'), { ok: true }),
      backup: async () => (order.push('backup'), { ok: true }),
    });
    const w2 = {
      ...w,
      createAction: async () => (order.push('send'), { sendWithResults: [{ txid: T, status: 'unproven' }] }),
    };
    expect(await sendStorePayment(w2, entry(), okD)).toBe('sent');
    expect(order).toEqual(['backup', 'intent', 'send']);
  });

  test('F2: an outbox write that fails stops everything before the broadcast', async () => {
    let sends = 0;
    const w = { ...answering('sent'), createAction: async () => (sends++, {}) };
    const failing = {
      all: () => [],
      put: () => {
        throw new Error('QuotaExceeded');
      },
      drop: () => undefined,
    };
    const released: string[] = [];
    const d = base({ outbox: failing, releaseUnsent: async (t) => void released.push(t) });
    expect((await recordNewPayment(entry(), d).catch((x: StorePayError) => x)).code).toBe('outbox_failed');
    expect(released).toEqual([T]);
    expect((await sendStorePayment(w, entry({ state: 'sending' }), d).catch((x: StorePayError) => x)).code).toBe(
      'outbox_failed',
    );
    expect(sends).toBe(0);
  });

  test('storeMemo reads the quote id from a Store memo output', () => {
    const memo = (tag: string, q: string) =>
      new Script()
        .writeOpCode(OP.OP_FALSE)
        .writeOpCode(OP.OP_RETURN)
        .writeBin(Utils.toArray(tag, 'utf8'))
        .writeBin(Utils.toArray(q, 'utf8'))
        .toHex();
    const q = 'f'.repeat(32);
    expect(storeMemo(memo('bwx-theme-buy', q))).toEqual({ kind: 'buy', quoteId: q });
    expect(storeMemo(memo('bwx-theme-order', q))).toEqual({ kind: 'order', quoteId: q });
    expect(storeMemo(memo('bwx-theme-deposit', q))).toBeNull();
    expect(storeMemo('76a914')).toBeNull();
  });
});

describe('06c M1: a payment that was already being sent is marked "may be out" before it is re-posted', () => {
  test('resume of a sending entry marks it first; a first send does not', async () => {
    const order: string[] = [];
    const w = {
      ...answering('sent'),
      createAction: async () => (order.push('send'), { sendWithResults: [{ txid: T, status: 'unproven' }] }),
    };
    const d = base({ markMayBeOut: async (t) => void order.push(`mark ${t.slice(0, 4)}`) });
    expect(await sendStorePayment(w, entry({ state: 'sending' }), d)).toBe('sent');
    expect(order).toEqual(['mark abab', 'send']);
    order.length = 0;
    // A new payment (the outbox's entry for T says 'sent' now, and the outbox is what the send trusts).
    d.outbox.drop(T);
    expect(await sendStorePayment(w, entry({ state: 'signed' }), d)).toBe('sent');
    expect(order).toEqual(['send']);
  });
});

describe('final check (LOW): a first post that ends without a verdict is marked "may be out" too', () => {
  test('pending first post: marked; accepted first post: not marked', async () => {
    const marked: string[] = [];
    const pendingWallet = {
      ...answering('sent'),
      createAction: async () => {
        throw Object.assign(new Error('WERR_REVIEW_ACTIONS'), {
          sendWithResults: [{ txid: T, status: 'sending' }],
          reviewActionResults: [{ txid: T, status: 'serviceError' }],
        });
      },
    };
    const d = base({ markMayBeOut: async (t) => void marked.push(t) });
    expect(await sendStorePayment(pendingWallet, entry({ state: 'signed' }), d)).toBe('pending');
    expect(marked).toEqual([T]);
    marked.length = 0;
    expect(await sendStorePayment(answering('sent'), entry({ state: 'signed' }), d)).toBe('sent');
    expect(marked).toEqual([]);
  });
});

describe('re-review: an intent dep that never answers is given up on (the backstop), and the lock is free again', () => {
  test('store_unreachable after intentTimeoutMs + INTENT_GRACE_MS; nothing sent; intentAt written; the lock is free', async () => {
    const { withPayLock, INTENT_GRACE_MS } = await import('./storePay');
    let sends = 0;
    const w = { abortAction: async () => undefined, createAction: async () => (sends++, {}) };
    const d = base({ intent: () => new Promise(() => undefined), intentTimeoutMs: 10 });
    d.outbox.put(entry({ intentAt: null }));
    const t0 = Date.now();
    await expect(sendStorePayment(w, entry({ intentAt: null }), d)).rejects.toMatchObject({
      code: 'store_unreachable',
      sent: false,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(10 + INTENT_GRACE_MS - 50);
    expect(sends).toBe(0);
    expect(typeof d.outbox.all()[0].intentAt).toBe('number');
    expect(await withPayLock(T, async () => 'free')).toBe('free');
  }, 10_000);
});
