import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import {
  feeFromAtomicBeef,
  isInProgress,
  retryAfterMs,
  NativeSealError,
  inertHtml,
  accountHandles,
  fetchSignedCopy,
  myFields,
  nativeRoomSteps,
  nativeSignAndSeal,
  recoverNativeSeals,
  SEAL_SPENT_MESSAGE,
  signedFieldIds,
  strokesToSvg,
  type PendingSeal,
  type SealApi,
  type SealKeys,
} from './nativeSeal';

const memStore = () => {
  const m = new Map<string, PendingSeal>();
  return {
    list: () => [...m.values()],
    save: (p: PendingSeal) => void m.set(p.nonce, p),
    remove: (n: string) => void m.delete(n),
    m,
  };
};
const TX = 'ab'.repeat(32);
const keys = (log: string[]): SealKeys => ({
  createSignature: async (a) => (
    log.push(`sign:${a.protocolID[1]}:${a.keyID}:${a.counterparty}:${a.data.length}`),
    { signature: [1, 2, 255] }
  ),
  createAction: async (a) => (
    log.push(`pay:${a.outputs[0].satoshis}:${a.outputs[0].lockingScript}:${a.options.acceptDelayedBroadcast}`),
    { txid: TX.toUpperCase(), tx: [9, 9] }
  ),
});
const api =
  (
    log: string[],
    over: Partial<
      Record<string, (b: Record<string, unknown>) => { ok: boolean; status: number; body: Record<string, unknown> }>
    > = {},
  ): SealApi =>
  async (path, body) => {
    log.push(`${path}:${JSON.stringify(body)}`);
    const o = over[path];
    if (o) return o(body);
    if (path === 'prepare')
      return { ok: true, status: 200, body: { nonce: 'N1', ref: 'R', title: 'T', identityKey: '02aa', estFeeSats: 3 } };
    if (path === 'compose')
      return {
        ok: true,
        status: 200,
        body: {
          signing: { protocolID: [2, 'bitsign seal'], keyID: 'N1', counterparty: 'anyone' },
          recordCanonical: 'rec',
          lockingScriptHex: '006a',
        },
      };
    return { ok: true, status: 200, body: { signatureId: 'S', txid: TX, docHash: 'H', complete: true, sealed: true } };
  };

describe("nativeSignAndSeal: the web client's exact protocol, with the wallet's own keys", () => {
  test('prepare → approve → compose → sign → pay → commit, payloads as the web client sends them', async () => {
    const log: string[] = [];
    const store = memStore();
    const out = await nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: ' <svg/> ',
      api: api(log),
      keys: keys(log),
      store,
      approve: async () => true,
    });
    expect(log).toEqual([
      'prepare:{"documentId":"D","fieldIds":["f1"]}',
      'compose:{"nonce":"N1","svg":"<svg/>"}',
      'sign:bitsign seal:N1:anyone:3',
      'pay:0:006a:false',
      // The broadcast receipt, right after the payment and before commit, with commit's exact body.
      `receipt:{"nonce":"N1","attestation":"0102ff","txid":"${TX}","beefHex":"0909"}`,
      `commit:{"nonce":"N1","attestation":"0102ff","txid":"${TX}","beefHex":"0909"}`,
    ]);
    expect(out).toEqual({ signatureId: 'S', txid: TX, docHash: 'H', complete: true, sealed: true });
    expect(store.m.size).toBe(0);
  });

  test('cancelled at the one approval: nothing signed or paid', async () => {
    const log: string[] = [];
    await expect(
      nativeSignAndSeal({
        documentId: 'D',
        fieldIds: ['f1'],
        svg: '<svg/>',
        api: api(log),
        keys: keys(log),
        store: memStore(),
        approve: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(log.some((l) => l.startsWith('sign') || l.startsWith('pay') || l.startsWith('compose'))).toBe(false);
  });

  test('already sealed: refused at prepare, before any approval', async () => {
    const log: string[] = [];
    let asked = false;
    const e = await nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: '<svg/>',
      store: memStore(),
      keys: keys(log),
      api: api(log, {
        prepare: () => ({ ok: false, status: 409, body: { error: 'already sealed', code: 'already_sealed' } }),
      }),
      approve: async () => (asked = true),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(NativeSealError);
    expect(e.code).toBe('already_sealed');
    expect(asked).toBe(false);
  });

  test('a refused commit goes to /recover with the same body; the saved entry is cleared on success', async () => {
    const log: string[] = [];
    const store = memStore();
    const out = await nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: '<svg/>',
      keys: keys(log),
      store,
      approve: async () => true,
      api: api(log, {
        commit: () => ({ ok: false, status: 410, body: { error: 'expired' } }),
        recover: () => ({
          ok: true,
          status: 200,
          body: { signatureId: 'S2', txid: TX, docHash: 'H', complete: true, sealed: true },
        }),
      }),
    });
    expect(log.filter((l) => l.startsWith('recover')).length).toBe(1);
    expect(log.find((l) => l.startsWith('recover'))).toContain(`"txid":"${TX}"`);
    expect(out.recovered).toBe(true);
    expect(store.m.size).toBe(0);
  });

  test('commit and recover both unreachable: kept on the phone for later, said plainly', async () => {
    const store = memStore();
    const boom: SealApi = async (path, body) => {
      if (path === 'commit' || path === 'recover') throw new Error('offline');
      return api([])(path, body);
    };
    const e = await nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: '<svg/>',
      api: boom,
      keys: keys([]),
      store,
      approve: async () => true,
    }).catch((x) => x);
    expect(e.code).toBe('pending_recovery');
    expect(store.m.size).toBe(1);
    const n = await recoverNativeSeals(api([]), store, 'D');
    expect(n).toBe(1);
    expect(store.m.size).toBe(0);
  });
});

describe('pay refused: a coin already spent on another device (owner iPhone, 3 Nov 2026 14:37Z)', () => {
  const RAW =
    'Undelayed createAction or signAction results require review. rejected by the network as invalid; broadcaster said: UTXO_SPENT (70) … already spent by tx 5db5b9af48bc… Coins tried: eb6dcc27fb…:2.';
  const failingKeys = (log: string[], err: Error): SealKeys => ({
    ...keys(log),
    createAction: async () => (log.push('pay'), Promise.reject(err)),
  });

  test('plain message, not the toolbox text; nothing saved, nothing committed', async () => {
    const log: string[] = [];
    const store = memStore();
    const err = await nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: '<svg/>',
      api: api(log),
      keys: failingKeys(log, new Error(RAW)),
      store,
      approve: async () => true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(NativeSealError);
    expect(err.code).toBe('spent_elsewhere');
    expect(err.message).toBe(SEAL_SPENT_MESSAGE);
    expect(err.message).not.toContain('UTXO_SPENT');
    expect(store.m.size).toBe(0); // not paid: no paid-but-unrecorded entry
    expect(log.filter((l) => l.startsWith('commit') || l.startsWith('recover'))).toEqual([]);
    expect(log.filter((l) => l === 'pay')).toHaveLength(1); // the background already made the one safe retry
  });

  test('the background healed but could not retry safely: same plain message', async () => {
    const log: string[] = [];
    const err = await nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: '<svg/>',
      api: api(log),
      keys: failingKeys(
        log,
        new Error('Some coins were already spent on another device. Refreshed your balance — please try again.'),
      ),
      store: memStore(),
      approve: async () => true,
    }).catch((e) => e);
    expect(err.message).toBe(SEAL_SPENT_MESSAGE);
  });

  test('other pay failures pass through unchanged', async () => {
    const log: string[] = [];
    const boom = new Error('Not enough spendable BSV for this payment.');
    const err = await nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: '<svg/>',
      api: api(log),
      keys: failingKeys(log, boom),
      store: memStore(),
      approve: async () => true,
    }).catch((e) => e);
    expect(err).toBe(boom);
  });
});

describe('the drawn signature', () => {
  test('same SVG format as the web pad (bit-sign InPlaceSignaturePad), accepted by the server allowlist', () => {
    const svg = strokesToSvg(
      [
        [
          { x: 50, y: 60, pressure: 0.5 },
          { x: 80, y: 70, pressure: 0.5 },
        ],
      ],
      400,
      200,
    )!;
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 50" width="70" height="50"><path d="M 20.0 20.0 L 50.0 30.0" stroke="black" stroke-width="3.0" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    );
    // Only tags / attributes bit-sign's sanitiser allows (nds-compose.ts SVG_ALLOWED_TAGS / ATTRS).
    expect([...svg.matchAll(/<\/?([a-z]+)/g)].every((m) => ['svg', 'path'].includes(m[1]))).toBe(true);
    expect(svg).not.toMatch(/on[a-z]+=|<!--|javascript:/i);
  });
  test('no strokes → nothing to seal', () => expect(strokesToSvg([[{ x: 1, y: 1, pressure: 1 }]], 10, 10)).toBeNull());
});

describe('which blocks, and the document shown', () => {
  test("my unsigned blocks, by any of my handles (one identity), never someone else's", () => {
    const f = [
      { id: 'a', signerHandle: 'b0asex' },
      { id: 'b', signerHandle: '$BOASE' },
      { id: 'c', signerHandle: 'bailey' },
      { id: 'd', signerHandle: null },
    ];
    expect(myFields(f, ['b0asex', 'boase'], new Set(['a'])).map((x) => x.id)).toEqual(['b']);
  });
  test('signed blocks are read from the document', () => {
    expect([
      ...signedFieldIds('<span data-sig-anchor="x" data-signed="true"></span><span data-sig-anchor="y"></span>'),
    ]).toEqual(['x']);
  });
  test('the shown document carries no script, handler or javascript: URL', () => {
    const h = inertHtml(
      '<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:alert(1)">l</a><iframe src="//x"></iframe>',
    );
    expect(h).not.toMatch(/script|onclick|javascript:|iframe/i);
  });
});

describe('nativeRoomSteps (the room hears about a native seal)', () => {
  const out = { signatureId: 'sig-1', txid: TX, docHash: 'dh', complete: true };
  test('fully signed: pin (the "signed and sealed" row), then clear the pending pointer', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const r = await nativeRoomSteps(
      async (p, b) => void calls.push([p, b]),
      'DRAFTS',
      { documentTitle: 'Letter' },
      out,
    );
    expect(r).toBe('pinned');
    expect(calls).toEqual([
      [
        '/api/bitsign/rooms',
        { ticker: 'DRAFTS', documentId: 'sig-1', docTxid: TX, docHash: 'dh', manifest: { documentTitle: 'Letter' } },
      ],
      ['/api/bitsign/rooms/DRAFTS/prepare-doc', { action: 'sealed' }],
    ]);
  });
  test('part-signed: hand the signed copy on, nothing pinned', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const r = await nativeRoomSteps(async (p, b) => void calls.push([p, b]), 'A B', null, { ...out, complete: false });
    expect(r).toBe('handed-on');
    expect(calls).toEqual([['/api/bitsign/rooms/A%20B/prepare-doc', { action: 'send', documentId: 'sig-1' }]]);
  });
  test('a refused room step throws (the page offers Try again) and stops before clearing the pointer', async () => {
    const calls: string[] = [];
    const post = async (p: string) => {
      calls.push(p);
      throw new Error('403');
    };
    await expect(nativeRoomSteps(post, 'DRAFTS', null, out)).rejects.toThrow('403');
    expect(calls).toEqual(['/api/bitsign/rooms']);
  });
});

describe('fetchSignedCopy (the phone shows the signed copy after sealing)', () => {
  test('first id that answers with HTML wins; ids tried in order', async () => {
    const seen: string[] = [];
    const html = await fetchSignedCopy(
      async (p) => {
        seen.push(p);
        if (p.includes('orig')) throw new Error('404');
        return '<!doctype html><p>signed</p>';
      },
      'DRAFTS',
      ['orig', 'sig-1'],
    );
    expect(html).toBe('<!doctype html><p>signed</p>');
    expect(seen).toEqual([
      '/api/bitsign/rooms/DRAFTS/executed?documentId=orig',
      '/api/bitsign/rooms/DRAFTS/executed?documentId=sig-1',
    ]);
  });
  test('JSON or empty answers are not a signed copy: null', async () => {
    expect(await fetchSignedCopy(async () => ({ error: 'nope' }), 'T', ['a', ''])).toBeNull();
  });
});

describe('accountHandles (every handle on the account signs)', () => {
  test('handles plus primary, no repeats', () => {
    expect(accountHandles({ handles: [{ handle: 'b0asex' }, { handle: 'boase' }], primary: 'boase' })).toEqual([
      'b0asex',
      'boase',
    ]);
  });
  test('a block bound to $boase is mine when signed in as $b0asex', () => {
    const fields = [{ id: 'director', signerHandle: 'boase', name: 'Richard William Boase' }] as never;
    expect(
      myFields(fields, ['b0asex', ...accountHandles({ handles: [{ handle: 'boase' }] })], new Set()).map((f) => f.id),
    ).toEqual(['director']);
  });
  test('junk → []', () => {
    expect(accountHandles(null)).toEqual([]);
    expect(accountHandles({ handles: 'x' })).toEqual([]);
  });
});

describe('one press: steps, the pre-tap coin check, the real fee', () => {
  const run = async (coins?: { pending: () => boolean; wait: () => Promise<void> }, approve = true) => {
    const log: string[] = [];
    const steps: string[] = [];
    const out = await nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: '<svg/>',
      api: api(log),
      keys: keys(log),
      store: memStore(),
      coins,
      approve: async () => (log.push('approve'), approve),
      onStep: (s) => steps.push(s),
    }).catch((e) => e);
    return { out, log, steps };
  };

  test('progress states in order: approval first, then sign, pay, commit', async () => {
    const r = await run();
    expect(r.steps).toEqual(['preparing', 'approving', 'composing', 'signing', 'paying', 'committing']);
  });

  test('coin check finished before the press: no "Finding a fresh coin…" step', async () => {
    const r = await run({ pending: () => false, wait: async () => void 0 });
    expect(r.steps).not.toContain('healing');
  });

  test('coin check still running: waits for it after approval, before anything is composed or paid', async () => {
    const order: string[] = [];
    const r = await run({
      pending: () => true,
      wait: async () => void order.push('waited'),
    });
    expect(r.steps).toEqual(['preparing', 'approving', 'healing', 'composing', 'signing', 'paying', 'committing']);
    expect(order).toEqual(['waited']);
    expect(r.log.indexOf('approve')).toBeLessThan(r.log.findIndex((l) => l.startsWith('compose')));
  });

  test('a failing coin check never blocks the seal', async () => {
    const r = await run({ pending: () => true, wait: () => Promise.reject(new Error('boom')) });
    expect(r.out.txid).toBe(TX);
  });

  test('cancel at the sheet: no coin wait, nothing composed, signed or paid (compose never reached the server)', async () => {
    let waited = false;
    const r = await run({ pending: () => true, wait: async () => void (waited = true) }, false);
    expect(r.out).toMatchObject({ code: 'cancelled' });
    expect(waited).toBe(false);
    expect(r.steps).toEqual(['preparing', 'approving']);
    expect(r.log.filter((l) => /^(compose|sign|pay|commit|recover)/.test(l))).toEqual([]);
  });

  test('the actual fee is read from the AtomicBEEF the wallet returns', () => {
    const k = PrivateKey.fromRandom();
    const src = new Transaction();
    src.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
    src.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(k.toAddress()) });
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
    tx.addOutput({ satoshis: 0, lockingScript: Script.fromHex('006a') });
    tx.addOutput({ satoshis: 925, lockingScript: new P2PKH().lock(k.toAddress()) });
    expect(feeFromAtomicBeef(tx.toAtomicBEEF(true))).toBe(75);
    expect(feeFromAtomicBeef([9, 9])).toBeNull();
    expect(feeFromAtomicBeef(undefined)).toBeNull();
  });
});

describe('the broadcast receipt and in-progress (bit-sign fix/seal-receipt-sweep, a1cc86a1)', () => {
  const seal = (
    over: Parameters<typeof api>[1],
    extra: { receiptTimeoutMs?: number; sleeps?: number[]; rawApi?: SealApi } = {},
  ) => {
    const log: string[] = [];
    const store = memStore();
    const p = nativeSignAndSeal({
      documentId: 'D',
      fieldIds: ['f1'],
      svg: '<svg/>',
      api: extra.rawApi ?? api(log, over),
      keys: keys(log),
      store,
      approve: async () => true,
      receiptTimeoutMs: extra.receiptTimeoutMs ?? 50,
      sleep: async (ms) => void extra.sleeps?.push(ms),
    }).catch((e) => e);
    return p.then((out) => ({ out, log, store }));
  };
  const paths = (log: string[]) => log.map((l) => l.split(':')[0]).filter((x) => x !== 'sign');
  const body = { signatureId: 'S', txid: TX, docHash: 'H', complete: true, sealed: true };

  for (const [name, reply] of [
    [
      '503 receipts_unavailable (server not migrated)',
      { ok: false, status: 503, body: { code: 'receipts_unavailable' } },
    ],
    ['404 not_yours', { ok: false, status: 404, body: { code: 'not_yours' } }],
    ['409 other_receipt', { ok: false, status: 409, body: { code: 'other_receipt' } }],
    ['410 beyond_window', { ok: false, status: 410, body: { code: 'beyond_window' } }],
  ] as const) {
    test(`receipt fails (${name}) → commit still runs and the seal completes`, async () => {
      const r = await seal({ receipt: () => reply });
      expect(paths(r.log)).toEqual(['prepare', 'compose', 'pay', 'receipt', 'commit']);
      expect(r.out).toEqual(body);
    });
  }

  test('receipt throws (network) → commit still runs', async () => {
    const log: string[] = [];
    const inner = api(log);
    const r = await seal(
      {},
      { rawApi: async (path, b) => (path === 'receipt' ? Promise.reject(new Error('offline')) : inner(path, b)) },
    );
    expect(r.out).toEqual(body);
    expect(paths(log)).toEqual(['prepare', 'compose', 'commit']);
  });

  test('receipt hangs → commit goes ahead after the short cap', async () => {
    const log: string[] = [];
    const inner = api(log);
    const t0 = Date.now();
    const r = await seal(
      {},
      {
        receiptTimeoutMs: 30,
        rawApi: async (path, b) => (path === 'receipt' ? new Promise<never>(() => undefined) : inner(path, b)),
      },
    );
    expect(r.out).toEqual(body);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  const inProgress = (retryAfter?: number) => ({
    ok: false,
    status: 429,
    body: { code: 'commit_in_progress', error: 'being recorded', ...(retryAfter ? { retryAfter } : {}) },
  });

  test('commit answers 429 commit_in_progress → waits Retry-After, recover reads the result; never pays again', async () => {
    let recovers = 0;
    const sleeps: number[] = [];
    const r = await seal(
      {
        commit: () => inProgress(15),
        recover: () =>
          ++recovers < 3 ? inProgress(20) : { ok: true, status: 200, body: { ...body, idempotent: true } },
      },
      { sleeps },
    );
    expect(r.out).toMatchObject({ signatureId: 'S', txid: TX, recovered: true });
    expect(paths(r.log)).toEqual(['prepare', 'compose', 'pay', 'receipt', 'commit', 'recover', 'recover', 'recover']);
    expect(r.log.filter((l) => /^(pay|prepare)/.test(l)).length).toBe(2); // one prepare, one payment
    expect(sleeps).toEqual([15_000, 20_000, 20_000]); // the server's Retry-After each time, not a fixed wait
    expect(r.store.m.size).toBe(0);
  });

  test('in progress is matched by the code at any status; no retryAfter → 15 s', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await seal(
      {
        commit: () => ({ ok: false, status: 409, body: { code: 'commit_in_progress' } }),
        recover: () =>
          ++n < 2 ? { ok: false, status: 503, body: { code: 'commit_in_progress' } } : { ok: true, status: 200, body },
      },
      { sleeps },
    );
    expect(r.out).toMatchObject({ signatureId: 'S', recovered: true });
    expect(sleeps).toEqual([15_000, 15_000]);
    expect(retryAfterMs({ body: {} })).toBe(15_000);
    expect(retryAfterMs({ body: { retryAfter: 'x' } })).toBe(15_000);
    expect(isInProgress({ status: 429, body: {} })).toBe(true);
    expect(isInProgress({ status: 409, body: { code: 'replayed' } })).toBe(false);
  });

  test('still in progress after 3 tries → entry kept (pending_recovery), never re-prepared or paid again', async () => {
    const r = await seal({ commit: () => inProgress(15), recover: () => inProgress(15) });
    expect(r.out).toMatchObject({ code: 'pending_recovery' });
    expect(r.store.m.size).toBe(1);
    expect(r.log.filter((l) => l.startsWith('recover')).length).toBe(3);
    expect(r.log.filter((l) => /^(pay|prepare)/.test(l)).length).toBe(2);
  });

  test('409 replayed from commit and recover is a real refusal: entry cleared, no retry, no second payment', async () => {
    const replayed = () => ({
      ok: false,
      status: 409,
      body: { code: 'replayed', error: 'already finished with a different tx' },
    });
    const sleeps: number[] = [];
    const r = await seal({ commit: replayed, recover: replayed }, { sleeps });
    expect(r.out).toMatchObject({ code: 'failed', status: 409 });
    expect(r.store.m.size).toBe(0);
    expect(sleeps).toEqual([]);
    expect(r.log.filter((l) => l.startsWith('recover')).length).toBe(1);
    expect(r.log.filter((l) => l.startsWith('pay')).length).toBe(1);
  });

  test('commit idempotent:true is success', async () => {
    const r = await seal({ commit: () => ({ ok: true, status: 200, body: { ...body, idempotent: true } }) });
    expect(r.out).toEqual(body);
    expect(paths(r.log)).toEqual(['prepare', 'compose', 'pay', 'receipt', 'commit']);
  });

  test('an orphaned commit result (success:false) is orphaned: entry cleared, no recover, no retry', async () => {
    const r = await seal({
      commit: () => ({
        ok: true,
        status: 200,
        body: { success: false, orphaned: true, txid: TX, docHash: 'H', message: 'Another party sealed it first.' },
      }),
    });
    expect(r.out).toMatchObject({ code: 'orphaned', message: 'Another party sealed it first.' });
    expect(paths(r.log)).toEqual(['prepare', 'compose', 'pay', 'receipt', 'commit']);
    expect(r.store.m.size).toBe(0);
  });

  test('reopen: 429 keeps the entry; success, orphaned or a definitive 4xx clears it', async () => {
    const one = async (reply: { ok: boolean; status: number; body: Record<string, unknown> }) => {
      const store = memStore();
      store.save({ documentId: 'D', nonce: 'N1', txid: TX, beefHex: '00', attestation: 'aa', savedAt: 1 });
      const done = await recoverNativeSeals(async () => reply, store, 'D');
      return { done, kept: store.m.size };
    };
    expect(await one(inProgress(15))).toEqual({ done: 0, kept: 1 });
    expect(await one({ ok: false, status: 409, body: { code: 'commit_in_progress' } })).toEqual({ done: 0, kept: 1 });
    expect(await one({ ok: false, status: 0, body: {} })).toEqual({ done: 0, kept: 1 });
    expect(await one({ ok: false, status: 502, body: {} })).toEqual({ done: 0, kept: 1 });
    expect(await one({ ok: true, status: 200, body: { ...body, idempotent: true } })).toEqual({ done: 1, kept: 0 });
    expect(await one({ ok: true, status: 200, body: { success: false, orphaned: true } })).toEqual({
      done: 0,
      kept: 0,
    });
    expect(await one({ ok: false, status: 409, body: { code: 'replayed' } })).toEqual({ done: 0, kept: 0 });
  });
});
