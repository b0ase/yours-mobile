import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import {
  feeFromAtomicBeef,
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
