import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as ns from './nativeSeal';
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import {
  CLAIM_SKEW_MS,
  CLAIM_STALE_MS,
  ELSEWHERE_MESSAGE,
  SEAL_CLAIM_MS,
  SEAL_RECOVERY_WINDOW_MS,
  SETTLE_MARK_MS,
  SEAL_ACTION_DESCRIPTION,
  UNSAVED_MESSAGE,
  archiveRefusedSeal,
  paidAgainDrawingMessage,
  sealBusyElsewhere,
  txCarriesScript,
  beingSettled,
  claimAlive,
  HELD_SUPPORT_AFTER_MS,
  RELEASE_MIN_AGE_MS,
  RELEASE_SPACING_MS,
  RESUME_MARGIN_MS,
  SEAL_NONCE_TTL_MS,
  SEAL_SPENT_MESSAGE,
  findSealAction,
  heldSupportMessage,
  heldTooLong,
  nativeSignAndSeal,
  notPaidText,
  recoverNativeSeals,
  sealKey,
  sealStateHere,
  settleUnsureSeal,
  unpaidProven,
  withNotFound,
  type ListActionsFn,
  type NativeSealError,
  type PendingSeal,
  type PendingSealStore,
  type SealApi,
  type SealKeys,
  type SealTxLookup,
} from './nativeSeal';
import { SEAL_HTML, SEAL_KEY, composedFor, preparedFor } from './nativeSeal.fixtures';
import { boundSupport, heldSealStateFor, localLedger, localStore } from './sealStore';
import { createRetryHold, RETRY_HOLD_MS } from './sealRetryHold';
import { openingNotice, retryAllowed, retryDrawingFits } from './sealScreen';
import { reportSealFailure, resetSealReports, scrubSealText } from './sealReport';
import { DEVICE_NOT_ACTIVE_MESSAGE } from '../../utils/sendErrors';
import { consoleGate } from '../../testing/captureConsole';

/**
 * Review of #560 (fix round 1): the reviewer's probes P1-P8 as tests, plus #561's A and B (they live in nativeSeal.ts).
 * Each one failed on 0ecdcb00.
 */
const gate = consoleGate(['error', 'warn', 'info']);

const TX = 'ab'.repeat(32);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250"><path d="M1 1L9 9Z"/></svg>';
const OTHER_KEY = `03${'cd'.repeat(32)}`;
const fakeStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
type Log = string[];
type Reply = Awaited<ReturnType<SealApi>>;

/**
 * bit-sign as main behaves (facts from the coordinator, 23 Nov 2026): a 10-minute session (commit after it → 410
 * expired; /recover still records for 24 h), composeHold (the same signer can't compose a second live nonce), and a
 * cancelled nonce can't compose again.
 */
const bitsign = (log: Log, now: () => number = Date.now, over: Partial<Record<string, (b: never) => Reply>> = {}) => {
  let n = 0;
  let prepared: Record<string, unknown> = {};
  const issued = new Map<string, number>();
  const cancelled = new Set<string>();
  const composedLive = new Set<string>();
  const api: SealApi = async (path, body) => {
    log.push(path === 'prepare' || path === 'compose' || path === 'cancel' ? `${path}:${body.nonce ?? ''}` : path);
    const o = over[path];
    if (o) return o(body as never);
    const nonce = String(body.nonce ?? '');
    if (path === 'prepare') {
      prepared = body;
      const nn = `N${++n}`;
      issued.set(nn, now());
      return { ok: true, status: 200, body: preparedFor(nn) };
    }
    if (path === 'cancel') {
      cancelled.add(nonce);
      composedLive.delete(nonce);
      return { ok: true, status: 200, body: {} };
    }
    if (path === 'compose') {
      if (cancelled.has(nonce)) return { ok: false, status: 409, body: { code: 'cancelled' } };
      if ([...composedLive].some((x) => x !== nonce && now() - (issued.get(x) ?? 0) < SEAL_NONCE_TTL_MS))
        return { ok: false, status: 409, body: { code: 'signer_busy', error: 'busy elsewhere' } };
      composedLive.add(nonce);
      return {
        ok: true,
        status: 200,
        body: composedFor({
          documentId: String(prepared.documentId),
          fieldIds: prepared.fieldIds as string[],
          svg: String(body.svg),
          nonce,
        }),
      };
    }
    if (path === 'commit' && now() - (issued.get(nonce) ?? 0) > SEAL_NONCE_TTL_MS) {
      log.push('EXPIRED-commit');
      return { ok: false, status: 410, body: { code: 'expired', error: 'session expired' } };
    }
    composedLive.delete(nonce);
    return { ok: true, status: 200, body: { signatureId: 'S', txid: TX, docHash: 'H', complete: true, sealed: true } };
  };
  return api;
};
const wallet = (log: Log, errs: unknown[] = [], scripts: string[] = []): SealKeys => ({
  createSignature: async () => (log.push('sign'), { signature: [1, 2, 3] }),
  createAction: async (a) => {
    log.push('pay');
    scripts.push(a.outputs[0].lockingScript);
    const e = errs.shift();
    if (e) throw e;
    return { txid: TX, tx: [9, 9] };
  },
});
const base = (
  o: { log: Log; store: PendingSealStore; documentId: string } & Partial<Parameters<typeof nativeSignAndSeal>[0]>,
) =>
  ({
    documentHtml: SEAL_HTML,
    identityKey: SEAL_KEY,
    fieldIds: ['f1'],
    svg: SVG,
    api: bitsign(o.log),
    keys: wallet(o.log),
    approve: async () => true,
    receiptTimeoutMs: 1,
    sleep: async () => undefined,
    ...o,
  }) as Parameters<typeof nativeSignAndSeal>[0];
const count = (log: Log, what: string) => log.filter((l) => l === what || l.startsWith(`${what}:`)).length;
const POOR = 'Not enough spendable BSV for this payment.';
const recover = (
  api: SealApi,
  store: PendingSealStore,
  documentId: string | undefined,
  lookup: SealTxLookup | undefined,
  opts: Partial<Parameters<typeof recoverNativeSeals>[5]> = {},
) => recoverNativeSeals(api, store, documentId, null, lookup, { identityKey: SEAL_KEY, ...opts });
const NONE: SealTxLookup = { find: async () => ({ found: false }), beef: async () => null };
const unsure = (over: Partial<PendingSeal> = {}): PendingSeal => ({
  documentId: 'D',
  nonce: 'N9',
  txid: '',
  beefHex: '',
  attestation: 'aa',
  savedAt: 1_000,
  identityKey: SEAL_KEY,
  fieldIds: ['f1'],
  lockingScriptHex: '006a',
  svg: SVG,
  ...over,
});

describe('L1 / P1: a pay-only retry never pays on a session that ran out during its approval', () => {
  test('the sheet open 3 minutes → the kept nonce is given back, a new one prepared, ONE approval, paid in time', async () => {
    gate.expectLines(`warn [nativeSeal] pay failed ${POOR}`);
    const log: Log = [];
    let t = 1_000_000;
    const now = () => t;
    const store = localStore(fakeStorage(), now);
    const api = bitsign(log, now);
    const keys = wallet(log, [new Error(POOR)]);
    const e = (await nativeSignAndSeal(base({ log, store, documentId: 'E1', api, keys, now })).catch(
      (x) => x,
    )) as NativeSealError;
    const resume = e.drawing!.resume!;
    t = resume.expiresAt - RESUME_MARGIN_MS - 1_000; // 91 s left: usable when Try again is pressed
    let asked = 0;
    const out = await nativeSignAndSeal(
      base({
        log,
        store,
        documentId: 'E1',
        api,
        keys,
        now,
        resume,
        approve: async () => (asked++, (t += 180_000), true),
      }),
    );
    expect(out.txid).toBe(TX);
    expect(asked).toBe(1); // one approval for the payment, no second sheet
    expect(log.some((l) => l.startsWith('EXPIRED'))).toBe(false);
    expect(log.slice(4)).toEqual(['cancel:N1', 'prepare:', 'compose:N2', 'sign', 'pay', 'receipt', 'commit']);
    expect(count(log, 'pay')).toBe(2); // the refused attempt and this one
  });
});

describe('M1 / P2 / P3: ONE release rule, wherever recovery runs', () => {
  test('P2: a reopen mid-check does ONE lookup and keeps the record (no cancel, no "Nothing was paid")', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const log: Log = [];
    const storage = fakeStorage();
    const api = bitsign(log);
    const e = await nativeSignAndSeal(
      base({
        log,
        store: localStore(storage),
        documentId: 'R9',
        api,
        keys: wallet(log, [new Error('Failed to fetch')]),
      }),
    ).catch((x) => x);
    expect(e.code).toBe('pending_recovery');
    let asked = 0;
    const rs = await recover(api, localStore(storage), 'R9', {
      find: async () => (asked++, { found: false }),
      beef: async () => null,
    });
    expect(asked).toBe(1);
    expect(rs).toEqual([{ nonce: 'N1', documentId: 'R9', outcome: 'kept' }]);
    expect(count(log, 'cancel')).toBe(0);
    expect(sealStateHere(SEAL_KEY, 'R9', ['f1'], localStore(storage))).toBe('unsure'); // never "Seal again" yet
  });

  test('the rule itself: ≥2 answers ≥5 s apart AND ≥3 minutes since saved; a txid learnt never releases', () => {
    let p = unsure({ savedAt: 0 });
    const old = RELEASE_MIN_AGE_MS;
    p = withNotFound(p, old);
    expect(unpaidProven(p, old)).toBe(false);
    p = withNotFound(p, old + RELEASE_SPACING_MS - 1); // too soon: not counted
    expect(p.notFound).toBe(1);
    p = withNotFound(p, old + RELEASE_SPACING_MS);
    expect(unpaidProven(p, old + RELEASE_SPACING_MS)).toBe(true);
    // N4: answers from before the record is 3 minutes old are not evidence at all.
    const young = withNotFound(withNotFound(unsure({ savedAt: 0 }), 1_000), 7_000);
    expect(young.notFound).toBeUndefined();
    expect(unpaidProven(young, old + 1)).toBe(false);
    const late = withNotFound(withNotFound(young, old - 1), old);
    expect(late.notFound).toBe(1); // only the answer at 3 minutes counts
    expect(unpaidProven({ ...p, notFoundFirstAt: old - 1 }, old + RELEASE_SPACING_MS)).toBe(false);
    expect(unpaidProven({ ...p, txid: TX }, old + RELEASE_SPACING_MS)).toBe(false);
  });

  test('the count lives ON the record: two reopens (new store instances) release it, never one', async () => {
    const storage = fakeStorage();
    const t0 = 1_000 + RELEASE_MIN_AGE_MS;
    let t = t0;
    const clock = () => t;
    localStore(storage, clock).save(unsure());
    const log: Log = [];
    const api = bitsign(log);
    expect((await recover(api, localStore(storage, clock), 'D', NONE, { now: () => t0 }))[0].outcome).toBe('kept');
    expect(localStore(storage, clock).list()[0]).toMatchObject({ notFound: 1, notFoundFirstAt: t0 });
    const rs = await recover(api, localStore(storage, clock), 'D', NONE, { now: () => (t = t0 + RELEASE_SPACING_MS) });
    expect(rs[0].outcome).toBe('released');
    expect(log).toEqual(['cancel:N9']);
    expect(localStore(storage, clock).drawings!.get(sealKey(SEAL_KEY, 'D', ['f1']))?.svg).toBe(SVG);
  });

  test('P3: recovery skips a record being settled on screen (its mark is live), then takes it once the mark is gone', async () => {
    const storage = fakeStorage();
    const store = localStore(storage);
    store.save(unsure({ documentId: 'C9', nonce: 'NC' }));
    const log: Log = [];
    const api = bitsign(log);
    let open!: () => void;
    const gateSleep = new Promise<void>((r) => (open = r));
    let settleAsked = 0;
    const settling = settleUnsureSeal({
      api,
      store: localStore(storage),
      nonce: 'NC',
      delaysMs: [1],
      lookup: { find: async () => (settleAsked++, { found: false }), beef: async () => null },
      sleep: () => gateSleep,
    });
    await Promise.resolve();
    expect(localStore(storage).list()[0].settling?.by).toBe(ns.CONTEXT_ID);
    let recoveryAsked = 0;
    const rs = await recover(api, localStore(storage), 'C9', {
      find: async () => (recoveryAsked++, { found: false }),
      beef: async () => null,
    });
    expect(rs[0].outcome).toBe('kept');
    expect(recoveryAsked).toBe(0);
    open();
    expect((await settling).k).toBe('unknown'); // one answer, young record: kept
    expect(settleAsked).toBe(1);
    expect(localStore(storage).list()[0].settling).toBeUndefined();
    expect(count(log, 'cancel')).toBe(0);
  });

  test('the page leaving stops the check: no further lookup, the record kept, its mark cleared', async () => {
    const storage = fakeStorage();
    localStore(storage).save(unsure({ nonce: 'NS' }));
    let left = false;
    let asked = 0;
    const r = await settleUnsureSeal({
      api: bitsign([]),
      store: localStore(storage),
      nonce: 'NS',
      lookup: { find: async () => (asked++, { found: false }), beef: async () => null },
      sleep: async () => void (left = true),
      stopped: () => left,
    });
    expect(r.k).toBe('unknown');
    expect(asked).toBe(0);
    expect(localStore(storage).list()).toMatchObject([{ nonce: 'NS' }]);
    expect(localStore(storage).list()[0].settling).toBeUndefined();
  });
});

describe('M2 / P6: a pay-only retry only after a refusal before anything was built', () => {
  test("P6: spent elsewhere → the retry gets a NEW session and output script, never the failed attempt's", async () => {
    gate.expectLines(
      'warn [nativeSeal] pay failed Some of your coins were already spent from another device.',
      'warn [nativeSeal] pay failed Failed to fetch',
    );
    const log: Log = [];
    const store = localStore(fakeStorage());
    const api = bitsign(log);
    const scripts: string[] = [];
    const keys = wallet(
      log,
      [new Error('Some of your coins were already spent from another device.'), new Error('Failed to fetch')],
      scripts,
    );
    const e1 = (await nativeSignAndSeal(base({ log, store, documentId: 'S1', api, keys })).catch(
      (x) => x,
    )) as NativeSealError;
    expect(e1.code).toBe('spent_elsewhere');
    expect(e1.drawing?.resume).toBeUndefined();
    const e2 = (await nativeSignAndSeal(
      base({ log, store, documentId: 'S1', api, keys, svg: e1.drawing!.svg, resume: e1.drawing!.resume }),
    ).catch((x) => x)) as NativeSealError;
    expect(e2.code).toBe('pending_recovery');
    expect(scripts[0]).not.toBe(scripts[1]);
    // The wallet: attempt 1 is in the FAILED list, attempt 2 never stored. The lookup for attempt 2 finds nothing.
    const FAILED_TX = '11'.repeat(32);
    const listActions = (async (args: { labels: string[] }) =>
      args.labels.length === 2
        ? { totalActions: 1, actions: [{ txid: FAILED_TX, outputs: [{ lockingScript: scripts[0] }] }] }
        : { totalActions: 0, actions: [] }) as unknown as ListActionsFn;
    const r = await recover(api, store, 'S1', {
      find: (s, since, o) => findSealAction(listActions, s, since, 'failed', o),
      beef: async () => null,
    });
    expect(r[0].outcome).toBe('kept');
    expect(store.list()[0].txid).toBe(''); // never pinned to the failed attempt
    expect(store.list()[0].notFound).toBeUndefined(); // a young record: not evidence yet (N4)
  });

  test('which refusals keep the session: locked, not delivered, device not active, USB key, not enough funds', async () => {
    const keep = [
      new Error('wallet is locked'),
      new Error('Could not establish connection. Receiving end does not exist.'),
      new Error(DEVICE_NOT_ACTIVE_MESSAGE),
      Object.assign(new Error('Insert your USB key to continue'), { name: 'UsbKeyAbsentError' }),
      new Error(POOR),
    ];
    const prepare = [
      new Error('Some of your coins were already spent from another device.'),
      new Error(
        'The network refused this payment because a coin in it was already spent by another payment, so nothing was sent.',
      ),
      new Error('Payment refused: limit. Nothing was sent.'),
    ];
    gate.expectLines(...[...keep, ...prepare].map((e) => `warn [nativeSeal] pay failed ${e.message}`));
    for (const [i, err] of [...keep, ...prepare].entries()) {
      const e = (await nativeSignAndSeal(
        base({ log: [], store: localStore(fakeStorage()), documentId: `K${i}`, keys: wallet([], [err]) }),
      ).catch((x) => x)) as NativeSealError;
      expect([i, !!e.drawing?.resume]).toEqual([i, i < keep.length]);
    }
  });

  test("N1 / P9: a resumed record keeps the 60 s back-off: found even when the remote storage's clock is behind", async () => {
    gate.expectLines(`warn [nativeSeal] pay failed ${POOR}`, 'warn [nativeSeal] pay failed Failed to fetch');
    const log: Log = [];
    let t = 20_000_000;
    const now = () => t;
    const store = localStore(fakeStorage(), now);
    const api = bitsign(log, now);
    const keys = wallet(log, [new Error(POOR), new Error('Failed to fetch')]);
    const e = (await nativeSignAndSeal(base({ log, store, documentId: 'X1', api, keys, now })).catch(
      (x) => x,
    )) as NativeSealError;
    const e2 = (await nativeSignAndSeal(
      base({ log, store, documentId: 'X1', api, keys, now, resume: e.drawing!.resume }),
    ).catch((x) => x)) as NativeSealError;
    expect(e2.code).toBe('pending_recovery');
    const rec = store.list()[0];
    expect(Object.keys(rec)).not.toContain('resumed');
    expect(Object.keys(rec)).not.toContain('excludeTxids');
    // wallet.1sat.app stamped the action with its own clock, 1.5 s behind the phone.
    const createdAt = rec.savedAt - 1_500;
    const listActions = (async (args: { labels: string[] }) => {
      const from = Number(String(args.labels[0]).replace('action time from ', ''));
      return createdAt >= from && args.labels.length === 1
        ? { totalActions: 1, actions: [{ txid: 'cc'.repeat(32), outputs: [{ lockingScript: rec.lockingScriptHex }] }] }
        : { totalActions: 0, actions: [] };
    }) as unknown as ListActionsFn;
    const r = await settleUnsureSeal({
      api,
      store,
      nonce: e2.nonce!,
      now,
      lookup: { find: (sc, since) => findSealAction(listActions, sc, since, 'failed'), beef: async () => [7] },
      sleep: async (ms) => void (t += ms),
    });
    expect(r.k).toBe('recorded'); // never missed, released and paid twice
    expect(count(log, 'cancel')).toBe(0);
    expect(count(log, 'pay')).toBe(2); // the refused attempt and the one that went out
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).not.toMatch(/\bexact:|\bexclude:/);
  });

  test('a held record with no recorded seal after 24 h: "Contact support" with its reference; never cancelled', () => {
    const store = localStore(fakeStorage());
    store.save(unsure({ nonce: 'NONCE-abcdefghijkl-rest' }));
    expect(heldTooLong(store, SEAL_KEY, 'D', ['f1'], 1_000 + HELD_SUPPORT_AFTER_MS)).toBeNull();
    const p = heldTooLong(store, SEAL_KEY, 'D', ['f1'], 1_001 + HELD_SUPPORT_AFTER_MS);
    expect(p?.nonce).toBe('NONCE-abcdefghijkl-rest');
    expect(heldSupportMessage(p!)).toContain('Contact support with reference seal-NONCE-abcdef');
    expect(heldSupportMessage(p!)).not.toContain('rest');
    expect(heldTooLong(store, OTHER_KEY, 'D', ['f1'], 2 * HELD_SUPPORT_AFTER_MS)).toBeNull();
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('heldTooLong(localStore(), myKey, doc.documentId, ids, Date.now())');
  });
});

describe('M3 / P7 / P8: two windows sharing one store never both pay', () => {
  test('P7: the same kept seal in two contexts (popup + tab): ONE payment; the other "Already being sealed…"', async () => {
    gate.expectLines(`warn [nativeSeal] pay failed ${POOR}`);
    const storage = fakeStorage();
    const log: Log = [];
    const api = bitsign(log);
    let pays = 0;
    const keys = (errs: unknown[]): SealKeys => ({
      createSignature: async () => ({ signature: [1, 2, 3] }),
      createAction: async () => {
        pays++;
        const e = errs.shift();
        if (e) throw e;
        await new Promise((r) => setTimeout(r, 5));
        return { txid: TX, tx: [9] };
      },
    });
    await nativeSignAndSeal(
      base({ log, store: localStore(storage), documentId: 'T1', api, keys: keys([new Error(POOR)]) }),
    ).catch(() => null);
    const d = localStore(storage).drawings!.get(sealKey(SEAL_KEY, 'T1', ['f1']))!;
    const nsB = (await import(`./nativeSeal.ts?ctxB-${Date.now()}`)) as typeof ns; // its own inFlight and CONTEXT_ID
    expect(nsB.CONTEXT_ID).not.toBe(ns.CONTEXT_ID);
    const slow = async () => (await new Promise((r) => setTimeout(r, 20)), true);
    const out = await Promise.allSettled([
      ns.nativeSignAndSeal(
        base({
          log,
          store: localStore(storage),
          documentId: 'T1',
          api,
          keys: keys([]),
          resume: d.resume,
          approve: slow,
        }),
      ),
      nsB.nativeSignAndSeal(
        base({
          log,
          store: localStore(storage),
          documentId: 'T1',
          api,
          keys: keys([]),
          resume: d.resume,
          approve: slow,
        }),
      ),
    ]);
    expect(pays).toBe(2); // the refused first attempt + ONE retry
    expect(out.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('elsewhere');
    expect(lost.reason.message).toBe(ELSEWHERE_MESSAGE);
    expect(retryAllowed(new ns.NativeSealError(ELSEWHERE_MESSAGE, 'elsewhere'), false)).toBe(false);
    expect(count(log, 'cancel')).toBe(0); // the losing window never cancels the winner's session
  });

  test('a record written by another window during the approval stops this one right before it pays', async () => {
    gate.expectLines(`warn [nativeSeal] pay failed ${POOR}`);
    const storage = fakeStorage();
    const log: Log = [];
    const api = bitsign(log);
    const keys = wallet(log, [new Error(POOR)]);
    const e = (await nativeSignAndSeal(base({ log, store: localStore(storage), documentId: 'T3', api, keys })).catch(
      (x) => x,
    )) as NativeSealError;
    const r = await nativeSignAndSeal(
      base({
        log,
        store: localStore(storage),
        documentId: 'T3',
        api,
        keys,
        resume: e.drawing!.resume,
        approve: async () => (localStore(storage).save(unsure({ documentId: 'T3', nonce: 'N1' })), true),
      }),
    ).catch((x) => x);
    expect(r.code).toBe('elsewhere');
    expect(count(log, 'pay')).toBe(1);
    expect(count(log, 'cancel')).toBe(0);
  });

  test("P8: without a kept seal, bit-sign's composeHold stops the second window (unchanged)", async () => {
    const storage = fakeStorage();
    const log: Log = [];
    const api = bitsign(log);
    let pays = 0;
    const keys: SealKeys = {
      createSignature: async () => ({ signature: [1] }),
      createAction: async () => (pays++, await new Promise((r) => setTimeout(r, 5)), { txid: TX, tx: [9] }),
    };
    const nsC = (await import(`./nativeSeal.ts?ctxC-${Date.now()}`)) as typeof ns;
    const slow = async () => (await new Promise((r) => setTimeout(r, 20)), true);
    const out = await Promise.allSettled([
      ns.nativeSignAndSeal(base({ log, store: localStore(storage), documentId: 'T2', api, keys, approve: slow })),
      nsC.nativeSignAndSeal(base({ log, store: localStore(storage), documentId: 'T2', api, keys, approve: slow })),
    ]);
    expect(pays).toBe(1);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
});

describe("#561 A: recovery only touches THIS account's records", () => {
  test("two accounts, one document: A's recovery never asks for, looks up, erases or cancels B's records", async () => {
    const store = localStore(fakeStorage());
    store.save({ ...unsure({ nonce: 'B-paid', identityKey: OTHER_KEY }), txid: TX, beefHex: '00' });
    store.save(unsure({ nonce: 'B-unsure', identityKey: OTHER_KEY, savedAt: 0 }));
    const log: Log = [];
    let asked = 0;
    const lookup: SealTxLookup = { find: async () => (asked++, { found: false }), beef: async () => null };
    for (let i = 0; i < 3; i++) {
      const rs = await recover(bitsign(log), store, 'D', lookup, { now: () => RELEASE_MIN_AGE_MS + i * 10_000 });
      expect(rs).toEqual([]);
    }
    expect(log).toEqual([]);
    expect(asked).toBe(0);
    expect(store.list().map((p) => p.nonce)).toEqual(['B-paid', 'B-unsure']);
  });

  test('key-less records (before 6 Nov) only from the seal page, for one document; never in bulk', async () => {
    const store = localStore(fakeStorage());
    store.save({ documentId: 'OLD', nonce: 'K1', txid: TX, beefHex: '00', attestation: 'aa', savedAt: 1 });
    const log: Log = [];
    expect(await recover(bitsign(log), store, undefined, NONE, { keyless: true })).toEqual([]); // bulk
    expect(await recover(bitsign(log), store, 'OLD', NONE)).toEqual([]); // not asked for
    expect(log).toEqual([]);
    const rs = await recover(bitsign(log), store, 'OLD', NONE, { keyless: true });
    expect(rs).toEqual([{ nonce: 'K1', documentId: 'OLD', outcome: 'recorded' }]);
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(
      /recoverNativeSeals\(api, localStore\(\), p\.documentId, localLedger\(\), txLookup\(\), \{\s*identityKey: myKey,\s*keyless: true,/,
    );
  });
});

describe('#561 B: an answer that can change never erases a paid record', () => {
  const paid = () => {
    const store = localStore(fakeStorage());
    store.save({ ...unsure(), txid: TX, beefHex: '00' });
    return store;
  };
  const answer =
    (status: number, body: Record<string, unknown> = {}): SealApi =>
    async () => ({ ok: status === 200, status, body });
  test('401 / 403 / 404 not_yours, faults and in-progress keep it; replayed is final; other refusals are kept as refused', async () => {
    for (const [status, body, outcome, left] of [
      [401, { error: 'session expired' }, 'kept', 1],
      [403, {}, 'kept', 1],
      [404, { code: 'not_yours' }, 'kept', 1],
      [0, {}, 'kept', 1],
      [503, {}, 'kept', 1],
      [429, { code: 'commit_in_progress' }, 'kept', 1],
      [410, { code: 'beyond_window' }, 'refused', 1],
      [400, { error: 'bad attestation' }, 'refused', 1],
      [409, { code: 'replayed' }, 'recorded', 0],
      [200, { signatureId: 'S' }, 'recorded', 0],
    ] as const) {
      const store = paid();
      const rs = await recover(answer(status, body), store, 'D', NONE);
      expect([status, rs[0].outcome, store.list().length]).toEqual([status, outcome, left]);
    }
  });

  test('in the seal itself: a 401 on commit and recover keeps the paid record (pending_recovery, never "failed")', async () => {
    const store = localStore(fakeStorage());
    const log: Log = [];
    const no = () => ({ ok: false, status: 401, body: { error: 'Unauthorized' } });
    const e = await nativeSignAndSeal(
      base({ log, store, documentId: 'B1', api: bitsign(log, Date.now, { commit: no, recover: no }) }),
    ).catch((x) => x);
    expect(e.code).toBe('pending_recovery');
    expect(store.list()).toMatchObject([{ documentId: 'B1', beefHex: '0909' }]);
  });
});

describe('L2: the kept session on the retry screen goes back on unmount or after 2 minutes', () => {
  const kept = () => ({
    key: 'K',
    documentId: 'D',
    identityKey: SEAL_KEY,
    fieldIds: ['f1'],
    svg: SVG,
    savedAt: Date.now(),
    resume: {
      key: 'K',
      svg: SVG,
      prepared: preparedFor('NK'),
      composed: {},
      attestation: 'aa',
      expiresAt: 10,
    },
  });
  const rig = () => {
    const store = localStore(fakeStorage());
    const cancelled: string[] = [];
    const back: unknown[] = [];
    let fire: (() => void) | null = null;
    let cleared = 0;
    const h = createRetryHold({
      cancel: (n) => void cancelled.push(n),
      drawings: () => store.drawings,
      onGiveBack: (d) => void back.push(d),
      setTimer: (fn, ms) => (expect(ms).toBe(RETRY_HOLD_MS), (fire = fn), 1),
      clearTimer: () => void ((fire = null), cleared++),
    });
    return { store, cancelled, back, h, fire: () => fire?.(), cleared: () => cleared };
  };
  test('after 2 minutes on the screen: cancelled once, dropped from the stored drawing, the drawing kept', () => {
    const r = rig();
    const d = kept();
    r.store.drawings!.save(d);
    r.h.hold(d);
    r.fire();
    expect(r.cancelled).toEqual(['NK']);
    expect(r.store.drawings!.get('K')).toMatchObject({ svg: SVG });
    expect(r.store.drawings!.get('K')?.resume).toBeUndefined();
    expect(r.back).toEqual([{ ...d, resume: undefined }].map(({ resume: _r, ...x }) => (void _r, x)));
    r.h.giveBack(); // the unmount after it: nothing more
    expect(r.cancelled).toEqual(['NK']);
  });
  test('unmount first: cancelled once and the timer stopped; Try again (take) cancels nothing', () => {
    const r = rig();
    r.h.hold(kept());
    r.h.giveBack();
    expect(r.cancelled).toEqual(['NK']);
    expect(r.cleared()).toBe(1);
    const r2 = rig();
    r2.h.hold(kept());
    r2.h.take();
    r2.fire();
    r2.h.giveBack();
    expect(r2.cancelled).toEqual([]);
  });
  test('a drawing with no kept session starts no timer; the page holds restored and in-session drawings alike', () => {
    const r = rig();
    const { resume: _r, ...bare } = kept();
    void _r;
    r.h.hold(bare);
    r.h.giveBack();
    expect(r.cancelled).toEqual([]);
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/const d = n \? null : keptDrawing\(key\);\s*if \(d\) retryHold\.hold\(d\);/);
    expect(page).toMatch(/if \(d\) \{\s*retryHold\.hold\(d\);/);
    expect(page).toMatch(
      /mounted\.current = false;\s*if \(holdKey\.current\) abandonSeal\(holdKey\.current\);\s*retryHold\.giveBack\(\);/,
    );
  });
});

describe('L3: an account switch on the retry screen goes back to the pad', () => {
  test('only the drawing of this signer, document and blocks is used', () => {
    const key = sealKey(SEAL_KEY, 'D', ['f1']);
    expect(retryDrawingFits({ key }, key)).toBe(true);
    expect(retryDrawingFits({ key }, sealKey(OTHER_KEY, 'D', ['f1']))).toBe(false);
    expect(retryDrawingFits({ key }, '')).toBe(false);
    expect(retryDrawingFits(null, key)).toBe(false);
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(
      /if \(phase\.k === 'retry' && !retryDrawingFits\(phase\.drawing, currentKey\)\) backToPad\(\);/,
    );
  });
});

describe('L4: one report per nonce and kind; paymails, handles, addresses, JWTs and split hex removed', () => {
  test('P4: the sanitiser on realistic strings', () => {
    const cases: [string, string[]][] = [
      [
        'createAction failed for $b0asex (b0asex@bwalletx.com) paying 1HQTpVArDyFac7hnoMBFjDPxCqQt3boHRp',
        ['b0asex', '1HQTpVArDyFac7hnoMBFjDPxCqQt3boHRp'],
      ],
      ['abandon ability able about above absent absorb abstract absurd abuse access accident', ['absurd abuse']],
      ['key L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ end', ['L1aW4aub']],
      [
        'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
        ['xprv9s21'],
      ],
      [`identity 02${'ab'.repeat(32)} txid ${'cd'.repeat(32)}`, ['abab', 'cdcd']],
      ['split hex ab12cd34 ef56ab78 90cd12ef 3456abcd 7890ef12', ['ab12cd34', '90cd12ef']],
      [
        'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        ['eyJ', 'dozjg'],
      ],
      ['token=abcdefghij1234567890ABCDEFGHIJ12345 short', ['abcdefghij123']],
      ['mnemonic words: zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', ['zoo zoo zoo']],
    ];
    for (const [raw, gone] of cases) {
      const out = scrubSealText(raw);
      for (const g of gone) expect([raw.slice(0, 20), out.includes(g)]).toEqual([raw.slice(0, 20), false]);
    }
    // Plain words stay readable.
    expect(scrubSealText('Failed to fetch while paying')).toBe('Failed to fetch while paying');
  });
  test('the same nonce and kind is reported once; the on-screen result is its own report; no nonce always reports', () => {
    resetSealReports();
    const sent: string[] = [];
    const deps = { send: (t: string) => void sent.push(t), warn: () => undefined, ctx: {} };
    const f = {
      outcome: 'pending_recovery' as const,
      step: 'paying' as const,
      error: new Error('Failed to fetch'),
      nonce: 'N1',
    };
    reportSealFailure(f, deps);
    reportSealFailure(f, deps);
    reportSealFailure(f, { ...deps, settled: 'unknown' });
    reportSealFailure(f, { ...deps, settled: 'unknown' });
    reportSealFailure({ ...f, error: new Error('An internal error has occurred.') }, deps);
    reportSealFailure({ ...f, nonce: undefined }, deps);
    reportSealFailure({ ...f, nonce: undefined }, deps);
    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => expect(sent).toHaveLength(5));
  });
});

describe('L5: "Nothing was paid" said once, and only when proven', () => {
  test('the wallet\'s "Nothing was sent." becomes one "Nothing was paid."; the spent-coin words match the button', () => {
    for (const raw of [
      'Payment refused: over your limit. Nothing was sent.',
      DEVICE_NOT_ACTIVE_MESSAGE,
      'Insufficient funds: need 75, have 3. Nothing was sent.',
      POOR,
    ]) {
      const t = notPaidText(new Error(raw));
      expect([raw, (t.match(/nothing was (paid|sent)/gi) ?? []).length]).toEqual([raw, 1]);
      expect(t).toContain('Nothing was paid.');
    }
    expect(SEAL_SPENT_MESSAGE).toContain('Try again');
    expect(SEAL_SPENT_MESSAGE).not.toContain('Seal & pay');
  });
  test('an unclear payment never says "Nothing was paid" before the rule releases it', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const store = localStore(fakeStorage());
    const e = await nativeSignAndSeal(
      base({ log: [], store, documentId: 'W1', keys: wallet([], [new Error('Failed to fetch')]) }),
    ).catch((x) => x);
    expect(e.message).not.toMatch(/nothing was paid/i);
    expect(e.drawing).toBeUndefined();
    const ledger = localLedger(fakeStorage());
    const r = await settleUnsureSeal({
      api: bitsign([]),
      store,
      nonce: e.nonce,
      lookup: NONE,
      ledger,
      sleep: async () => undefined,
      delaysMs: [1, 1, 1],
    });
    expect(r.k).toBe('unknown'); // young record: never "not paid"
  });
});

describe('SealRecorded hook (for #561, the Signed list): every recorded seal, with the room ticker when known', () => {
  test('a fresh seal, a recovered one and one settled on screen all tell it, with the ticker; orphaned does not', async () => {
    const got: ns.SealRecorded[] = [];
    ns.setSealRecordedHook((s) => void got.push(s));
    try {
      const store = localStore(fakeStorage());
      await nativeSignAndSeal(base({ log: [], store, documentId: 'SR1', ticker: '$bcorp' }));
      expect(got).toEqual([
        {
          documentId: 'SR1',
          identityKey: SEAL_KEY,
          title: 'T',
          signatureId: 'S',
          txid: TX,
          docHash: 'H',
          complete: true,
          ticker: 'BCORP',
        },
      ]);
      // A paid record saved with its ticker, recovered on reopen.
      store.save({ ...unsure({ documentId: 'SR2', nonce: 'NSR2', ticker: 'BCORP' }), txid: TX, beefHex: '00' });
      await recover(bitsign([]), store, 'SR2', NONE);
      expect(got[1]).toMatchObject({ documentId: 'SR2', title: '', ticker: 'BCORP', signatureId: 'S' });
      // Settled on screen.
      store.save(unsure({ documentId: 'SR3', nonce: 'NSR3', ticker: 'BCORP' }));
      const r = await settleUnsureSeal({
        api: bitsign([]),
        store,
        nonce: 'NSR3',
        lookup: { find: async () => ({ found: true, txid: TX }), beef: async () => [7] },
        sleep: async () => undefined,
      });
      expect(r.k).toBe('recorded');
      expect(got[2]).toMatchObject({ documentId: 'SR3', ticker: 'BCORP' });
      // Orphaned (another party sealed first) and a seal with no ticker known.
      store.save({ ...unsure({ documentId: 'SR4', nonce: 'NSR4' }), txid: TX, beefHex: '00' });
      await recover(
        async () => ({ ok: true, status: 200, body: { success: false, orphaned: true } }),
        store,
        'SR4',
        NONE,
      );
      expect(got).toHaveLength(3);
      await nativeSignAndSeal(base({ log: [], store, documentId: 'SR5' }));
      expect(got[3].ticker).toBeUndefined();
      expect('ticker' in got[3]).toBe(false);
    } finally {
      ns.setSealRecordedHook(null);
    }
  });

  test('a listener that throws never touches the seal; the held record carries the ticker', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    ns.setSealRecordedHook(() => {
      throw new Error('Signed list broke');
    });
    try {
      const store = localStore(fakeStorage());
      const out = await nativeSignAndSeal(base({ log: [], store, documentId: 'SR6', ticker: 'BCORP' }));
      expect(out.txid).toBe(TX);
      await nativeSignAndSeal(
        base({ log: [], store, documentId: 'SR7', ticker: 'BCORP', keys: wallet([], [new Error('Failed to fetch')]) }),
      ).catch((x) => x);
      expect(store.list()).toMatchObject([{ documentId: 'SR7', ticker: 'BCORP' }]);
    } finally {
      ns.setSealRecordedHook(null);
    }
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/resume: resume \?\? null,[\s\S]{0,120}ticker,/);
  });
});

describe('Round 2 N2 / P10: a paid record bit-sign refused has its own state, words and way out', () => {
  const refusing = (log: Log, now: () => number = Date.now) =>
    bitsign(log, now, {
      commit: () => ({ ok: false, status: 422, body: { error: 'That transaction does not validate.' } }),
      recover: () => ({ ok: false, status: 422, body: { error: 'That transaction does not validate.' } }),
    });
  test('"Paid, but bChatX wouldn\'t record it. Contact support (ref …)"; never "Already sealed"; no second seal', async () => {
    const log: Log = [];
    const store = localStore(fakeStorage());
    const e = (await nativeSignAndSeal(base({ log, store, documentId: 'K1', api: refusing(log) })).catch(
      (x) => x,
    )) as NativeSealError;
    expect(e.code).toBe('paid_refused');
    expect(e.message).toBe("Paid, but bChatX wouldn't record it. Contact support (ref seal-N1).");
    expect(e.nonce).toBe('N1');
    expect(retryAllowed(e, true)).toBe(false);
    expect(store.list()).toMatchObject([{ nonce: 'N1', refused: { status: 422 }, svg: SVG }]);
    expect(sealStateHere(SEAL_KEY, 'K1', ['f1'], store)).toBe('refused');
    expect(openingNotice('refused', true)?.text).not.toMatch(/Already sealed|being recorded/);
    expect(heldSealStateFor('K1', store)).toBe('refused');
    const again = (await nativeSignAndSeal(base({ log, store, documentId: 'K1', api: refusing(log) })).catch(
      (x) => x,
    )) as NativeSealError;
    expect(again.code).toBe('paid_refused');
    expect(again.message).toContain('ref seal-N1');
    expect(count(log, 'pay')).toBe(1);
  });

  test("L7: /recover is always asked (the phone's clock never decides); only bit-sign's 410 stops the asking", async () => {
    const log: Log = [];
    let t = 1_000_000;
    const now = () => t;
    const store = localStore(fakeStorage(), now);
    await nativeSignAndSeal(base({ log, store, documentId: 'K2', api: refusing(log, now), now })).catch((x) => x);
    const p = store.list()[0];
    expect(p.sessionEndsAt).toBe(1_000_000 + SEAL_NONCE_TTL_MS);
    const before = count(log, 'recover');
    t = p.sessionEndsAt! + SEAL_RECOVERY_WINDOW_MS + 60 * 60_000; // long past the window by the phone's clock
    expect((await recover(refusing(log, now), store, 'K2', NONE, { now }))[0].outcome).toBe('refused');
    expect(count(log, 'recover')).toBe(before + 1); // still asked: the 422 decides, not the clock
    const closed = bitsign(log, now, {
      recover: () => ({ ok: false, status: 410, body: { code: 'beyond_window', error: 'too late' } }),
    });
    expect((await recover(closed, store, 'K2', NONE, { now }))[0].outcome).toBe('refused');
    expect(store.list()[0].refused).toMatchObject({ status: 410 });
    const asked = count(log, 'recover');
    expect((await recover(closed, store, 'K2', NONE, { now }))[0].outcome).toBe('refused');
    expect(count(log, 'recover')).toBe(asked); // after the server's 410: not asked again
    expect(store.list()).toHaveLength(1); // never deleted
  });

  test('"Seal again (you\'ll pay again)", confirmed: archived to the support list (never deleted), same drawing', async () => {
    const log: Log = [];
    const storage = fakeStorage();
    const store = localStore(storage);
    await nativeSignAndSeal(base({ log, store, documentId: 'K3', api: refusing(log) })).catch((x) => x);
    expect(archiveRefusedSeal({ ...store, support: undefined }, 'N1')).toBe(false); // nowhere to keep it: unchanged
    expect(store.list()).toHaveLength(1);
    expect(archiveRefusedSeal(store, 'N1')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.support!.list()).toMatchObject([{ nonce: 'N1', refused: { status: 422 }, beefHex: '0909' }]);
    expect(store.support!.list()[0].archivedAt).toBeGreaterThan(0);
    expect(localStore(storage).drawings!.get(sealKey(SEAL_KEY, 'K3', ['f1']))?.svg).toBe(SVG);
    const out = await nativeSignAndSeal(base({ log, store, documentId: 'K3' }));
    expect(out.txid).toBe(TX);
    expect(count(log, 'pay')).toBe(2); // the user confirmed paying again
    expect(store.support!.list()).toHaveLength(1); // still there for support
    // Only a refused record can be archived.
    store.save(unsure({ nonce: 'NU' }));
    expect(archiveRefusedSeal(store, 'NU')).toBe(false);
    expect(store.list()).toHaveLength(1);
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('{SEAL_AGAIN_PAY_AGAIN_LABEL}');
    expect(page).toMatch(/phase\.confirming \? \([\s\S]{0,400}onClick=\{\(\) => payAgain\(phase\.nonce\)\}/);
  });
});

describe('Round 2 N3 / N5 / P11: claims are short, heart-beaten, and dead when stale', () => {
  test("P11: a crashed context's claim blocks Seal again only until its heartbeat is stale (≤45 s), not 10 min", async () => {
    gate.expectLines(`warn [nativeSeal] pay failed ${POOR}`);
    const log: Log = [];
    let t = 30_000_000;
    const now = () => t;
    const storage = fakeStorage();
    const api = bitsign(log, now);
    const e = (await nativeSignAndSeal(
      base({ log, store: localStore(storage, now), documentId: 'L1', api, keys: wallet(log, [new Error(POOR)]), now }),
    ).catch((x) => x)) as NativeSealError;
    const key = sealKey(SEAL_KEY, 'L1', ['f1']);
    localStore(storage, now).claims!.save({ key, by: 'crashedctx', at: t, until: t + SEAL_CLAIM_MS });
    const blocked = await nativeSignAndSeal(
      base({ log, store: localStore(storage, now), documentId: 'L1', api, now, resume: e.drawing!.resume }),
    ).catch((x) => x);
    expect(blocked.code).toBe('elsewhere');
    t += CLAIM_STALE_MS + 1; // no heartbeat since the crash
    const out = await nativeSignAndSeal(
      base({ log, store: localStore(storage, now), documentId: 'L1', api, now, resume: e.drawing!.resume }),
    );
    expect(out.txid).toBe(TX);
    expect(count(log, 'pay')).toBe(2);
  });

  test('the claim is refreshed at each step (after a long approval it is fresh when paying)', async () => {
    gate.expectLines(`warn [nativeSeal] pay failed ${POOR}`);
    const log: Log = [];
    let t = 40_000_000;
    const now = () => t;
    const storage = fakeStorage();
    const api = bitsign(log, now);
    const e = (await nativeSignAndSeal(
      base({ log, store: localStore(storage, now), documentId: 'L2', api, keys: wallet(log, [new Error(POOR)]), now }),
    ).catch((x) => x)) as NativeSealError;
    const key = sealKey(SEAL_KEY, 'L2', ['f1']);
    let atPay: ns.SealClaim | null = null;
    const keys: SealKeys = {
      createSignature: async () => ({ signature: [1] }),
      createAction: async () => ((atPay = localStore(storage, now).claims!.get(key)), { txid: TX, tx: [9] }),
    };
    await nativeSignAndSeal(
      base({
        log,
        store: localStore(storage, now),
        documentId: 'L2',
        api,
        keys,
        now,
        resume: e.drawing!.resume,
        approve: async () => ((t += 40_000), true), // 40 s on the sheet
      }),
    );
    expect(atPay).toMatchObject({ by: ns.CONTEXT_ID, at: t, until: t + SEAL_CLAIM_MS });
    expect(localStore(storage, now).claims!.get(key)).toBeNull(); // dropped when the seal ends
  });

  test('N5: a claim or settling mark that claims to last too long (clock moved back, bogus) is stale', () => {
    const t = 1_000_000;
    const c = { key: 'k', by: 'x', at: t, until: t + SEAL_CLAIM_MS };
    expect(claimAlive(c, t)).toBe(true);
    expect(claimAlive({ ...c, until: t + SEAL_CLAIM_MS + CLAIM_SKEW_MS + 1 }, t)).toBe(false);
    expect(claimAlive({ ...c, until: t + 10 * 60_000 }, t)).toBe(false); // the old 10-minute claim
    expect(claimAlive({ ...c, at: t + CLAIM_SKEW_MS + 1, until: t + 60_000 }, t)).toBe(false); // from the future
    expect(claimAlive({ ...c, at: t - CLAIM_STALE_MS - 1 }, t)).toBe(false); // no heartbeat
    const p = unsure();
    expect(beingSettled({ ...p, settling: { by: 'x', until: t + SETTLE_MARK_MS } }, t)).toBe(true);
    expect(beingSettled({ ...p, settling: { by: 'x', until: t + SETTLE_MARK_MS + CLAIM_SKEW_MS + 1 } }, t)).toBe(false);
    expect(beingSettled({ ...p, settling: { by: 'x', until: t - 1 } }, t)).toBe(false);
  });
});

describe('Round 2 N4: only answers from a record ≥3 minutes old count toward release', () => {
  test('a reopen loop in the first 3 minutes never builds evidence; two later answers ≥5 s apart release it', async () => {
    const storage = fakeStorage();
    localStore(storage).save(unsure({ savedAt: 0, nonce: 'N4' }));
    const log: Log = [];
    const api = bitsign(log);
    for (const at of [1_000, 30_000, 90_000, 170_000, RELEASE_MIN_AGE_MS - 1])
      expect((await recover(api, localStore(storage), 'D', NONE, { now: () => at }))[0].outcome).toBe('kept');
    expect(localStore(storage).list()[0].notFound).toBeUndefined();
    expect((await recover(api, localStore(storage), 'D', NONE, { now: () => RELEASE_MIN_AGE_MS }))[0].outcome).toBe(
      'kept',
    );
    const rs = await recover(api, localStore(storage), 'D', NONE, {
      now: () => RELEASE_MIN_AGE_MS + RELEASE_SPACING_MS,
    });
    expect(rs[0].outcome).toBe('released');
    expect(log).toEqual(['cancel:N4']);
  });
});

describe('Round 3 M1 / L1: a seal action that could be this one is never "none built"', () => {
  const SCRIPT = '006a' + 'ab'.repeat(40);
  const page = (actions: Awaited<ReturnType<ListActionsFn>>['actions']): ListActionsFn =>
    (async () => ({ totalActions: actions.length, actions })) as ListActionsFn;
  test('PROBE A: built but unsigned (no txid yet) → unsure (null), never { found: false }', async () => {
    expect(
      await findSealAction(page([{ txid: '', outputs: [{ lockingScript: SCRIPT }] }]), SCRIPT, 1e12, 'F'),
    ).toBeNull();
    // By the seal's description, script truncated, no txid: unsure too.
    expect(
      await findSealAction(
        page([{ txid: '', description: SEAL_ACTION_DESCRIPTION, outputs: [{ lockingScript: '' }] }]),
        SCRIPT,
        1e12,
        'F',
      ),
    ).toBeNull();
  });
  test('PROBE A2: an unsigned candidate and a signed one with the script → found (the signed one)', async () => {
    const r = await findSealAction(
      page([
        { txid: '', outputs: [{ lockingScript: SCRIPT }] },
        { txid: 'cd'.repeat(32), outputs: [{ lockingScript: SCRIPT }] },
      ]),
      SCRIPT,
      1e12,
      'F',
    );
    expect(r).toEqual({ found: true, txid: 'cd'.repeat(32) });
  });
  test('PROBE A3: recovery never releases (or cancels) a record whose action exists unsigned', async () => {
    const store = localStore(fakeStorage());
    let t = 1_000_000_000_000;
    const now = () => t;
    store.save(unsure({ nonce: 'NA3', savedAt: t, lockingScriptHex: SCRIPT }));
    const log: Log = [];
    const unsigned = page([{ txid: '', outputs: [{ lockingScript: SCRIPT }] }]);
    const lookup: SealTxLookup = {
      find: (s, since) => findSealAction(unsigned, s, since, 'F'),
      beef: async () => null,
    };
    for (const step of [RELEASE_MIN_AGE_MS + 1, 6_000, 6_000, 60_000]) {
      t += step;
      expect((await recover(bitsign(log), store, 'D', lookup, { now }))[0].outcome).toBe('kept');
    }
    expect(log).toEqual([]);
    expect(store.list()[0].notFound).toBeUndefined();
  });
  test('L1: other actions (no description, other script) are no candidates: { found: false } still counts', async () => {
    expect(
      await findSealAction(
        page([{ txid: 'ee'.repeat(32), description: 'send', outputs: [{ lockingScript: '76a9' }] }]),
        SCRIPT,
        1e12,
        'F',
      ),
    ).toEqual({ found: false });
    // Another seal by description, with its full (different) script and a txid: not this one.
    expect(
      await findSealAction(
        page([{ txid: 'ee'.repeat(32), description: SEAL_ACTION_DESCRIPTION, outputs: [{ lockingScript: '006a00' }] }]),
        SCRIPT,
        1e12,
        'F',
      ),
    ).toEqual({ found: false });
  });
  test("L1: a long seal script stored truncated ('') is found by description and confirmed from its own transaction", async () => {
    const LONG = '006a' + 'ab'.repeat(540); // > 1024 bytes: the toolbox keeps it truncated
    const k = PrivateKey.fromRandom();
    const src = new Transaction();
    src.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
    src.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(k.toAddress()) });
    const mk = (script: string) => {
      const tx = new Transaction();
      tx.addInput({
        sourceTransaction: src,
        sourceOutputIndex: 0,
        unlockingScript: new Script(),
        sequence: 0xffffffff,
      });
      tx.addOutput({ satoshis: 0, lockingScript: Script.fromHex(script) });
      return tx;
    };
    const ours = mk(LONG);
    const other = mk('006a' + 'cd'.repeat(540));
    const OTHER_TX = other.id('hex');
    const OUR_TX = ours.id('hex');
    expect(txCarriesScript(ours.toAtomicBEEF(true), LONG)).toBe(true);
    expect(txCarriesScript(other.toAtomicBEEF(true), LONG)).toBe(false);
    const listActions = page([
      { txid: OTHER_TX, description: SEAL_ACTION_DESCRIPTION, outputs: [{ lockingScript: '' }] },
      { txid: OUR_TX, description: SEAL_ACTION_DESCRIPTION, outputs: [{ lockingScript: '' }] },
    ]);
    expect(await findSealAction(listActions, LONG, 1e12, 'F')).toEqual({ found: 'maybe', txids: [OTHER_TX, OUR_TX] });
    const store = localStore(fakeStorage());
    store.save(unsure({ nonce: 'NL1', lockingScriptHex: LONG, savedAt: Date.now() }));
    const lookup: SealTxLookup = {
      find: (s, since) => findSealAction(listActions, s, since, 'F'),
      beef: async (t) => (t === OUR_TX ? ours.toAtomicBEEF(true) : t === OTHER_TX ? other.toAtomicBEEF(true) : null),
    };
    const log: Log = [];
    const rs = await recover(bitsign(log), store, 'D', lookup);
    expect(rs[0].outcome).toBe('recorded');
    expect(count(log, 'recover')).toBe(1);
    // Only the other seal's transaction: unsure, kept, never released.
    store.save(unsure({ nonce: 'NL2', lockingScriptHex: LONG, savedAt: 0 }));
    const onlyOther = page([
      { txid: OTHER_TX, description: SEAL_ACTION_DESCRIPTION, outputs: [{ lockingScript: '' }] },
    ]);
    for (const at of [RELEASE_MIN_AGE_MS, RELEASE_MIN_AGE_MS + 10_000])
      expect(
        (
          await recover(
            bitsign(log),
            store,
            'D',
            {
              find: (s, since) => findSealAction(onlyOther, s, since, 'F'),
              beef: async () => other.toAtomicBEEF(true),
            },
            { now: () => at },
          )
        )[0].outcome,
      ).toBe('kept');
    expect(count(log, 'cancel')).toBe(0);
  });
  test('the createAction description is the one the lookup matches', () => {
    const src = readFileSync(new URL('./nativeSeal.ts', import.meta.url), 'utf8');
    expect(src).toContain('description: SEAL_ACTION_DESCRIPTION,');
    expect(SEAL_ACTION_DESCRIPTION).toBe('bit-sign: sign and seal a document');
  });
});

describe('Round 3 L2 / L3 / L5: before and while paying', () => {
  test('L2: a record whose createAction is still running in another window is kept by recovery and settle', async () => {
    const store = localStore(fakeStorage());
    const t = RELEASE_MIN_AGE_MS * 10;
    store.save({ ...unsure({ nonce: 'NP', savedAt: 0 }), paying: { by: 'otherctx', at: t, until: t + SEAL_CLAIM_MS } });
    const log: Log = [];
    let asked = 0;
    const none: SealTxLookup = { find: async () => (asked++, { found: false }), beef: async () => null };
    for (const at of [t, t + 6_000, t + 12_000])
      expect((await recover(bitsign(log), store, 'D', none, { now: () => at }))[0].outcome).toBe('kept');
    let tt = t;
    const r = await settleUnsureSeal({
      api: bitsign(log),
      store,
      nonce: 'NP',
      lookup: none,
      now: () => tt,
      sleep: async () => void (tt += 1_000),
      delaysMs: [1, 1, 1],
    });
    expect(r.k).toBe('unknown');
    expect(asked).toBe(0);
    expect(log).toEqual([]);
    // Its heartbeat stops (the window died): after CLAIM_STALE_MS the record is looked up again as usual.
    expect((await recover(bitsign(log), store, 'D', none, { now: () => t + CLAIM_STALE_MS + 1 }))[0].outcome).toBe(
      'kept',
    );
    expect(asked).toBe(1);
  });
  test('L2: the paying mark is on the record while createAction runs, and gone after it', async () => {
    const store = localStore(fakeStorage());
    let seen: PendingSeal | undefined;
    const keys: SealKeys = {
      createSignature: async () => ({ signature: [1] }),
      createAction: async () => ((seen = store.list()[0]), { txid: TX, tx: [9] }),
    };
    await nativeSignAndSeal(base({ log: [], store, documentId: 'PM1', keys }));
    expect(seen?.paying?.by).toBe(ns.CONTEXT_ID);
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    await nativeSignAndSeal(
      base({ log: [], store, documentId: 'PM2', keys: wallet([], [new Error('Failed to fetch')]) }),
    ).catch((x) => x);
    expect(store.list().find((p) => p.documentId === 'PM2')?.paying).toBeUndefined();
  });
  test("L3: a FRESH seal stops right before paying when another window's claim or record exists", async () => {
    const storage = fakeStorage();
    const log: Log = [];
    const key = sealKey(SEAL_KEY, 'F3', ['f1']);
    const e = await nativeSignAndSeal(
      base({
        log,
        store: localStore(storage),
        documentId: 'F3',
        approve: async () => (
          localStore(storage).claims!.save({ key, by: 'otherctx', at: Date.now(), until: Date.now() + SEAL_CLAIM_MS }),
          true
        ),
      }),
    ).catch((x) => x);
    expect(e.code).toBe('elsewhere');
    expect(count(log, 'pay')).toBe(0);
    expect(count(log, 'cancel')).toBe(1); // a fresh session is this window's own: given back
  });
  test("L5: a store that doesn't keep the unsure record → nothing paid, a clear error, the button back", async () => {
    const log: Log = [];
    const real = localStore(fakeStorage());
    const leaky: PendingSealStore = { ...real, save: () => undefined }; // a full disk: writes vanish
    const e = await nativeSignAndSeal(base({ log, store: leaky, documentId: 'Q5' })).catch((x) => x);
    expect(e.code).toBe('refused');
    expect(e.message).toBe(UNSAVED_MESSAGE);
    expect(retryAllowed(e, false)).toBe(true);
    expect(count(log, 'pay')).toBe(0);
  });
  test('L5: the support list keeps every entry; only old or excess BEEFs are dropped, oldest first', () => {
    const DAY = 24 * 60 * 60_000;
    const now = 200 * DAY;
    const e = (nonce: string, archivedAt: number, beefChars: number): PendingSeal => ({
      ...unsure({ nonce, txid: TX }),
      beefHex: 'b'.repeat(beefChars),
      archivedAt,
      refused: { at: archivedAt, status: 422, error: 'x' },
    });
    const out = boundSupport(
      [
        e('old', now - 91 * DAY, 10),
        e('a', now - 3 * DAY, 200_000),
        e('b', now - 2 * DAY, 100_000),
        e('c', now - DAY, 100),
      ],
      now,
    );
    expect(out.map((p) => [p.nonce, p.txid, p.beefHex.length])).toEqual([
      ['old', TX, 0], // past 90 days: BEEF dropped, entry kept
      ['a', TX, 0], // oldest while over the cap
      ['b', TX, 100_000],
      ['c', TX, 100],
    ]);
  });
});

describe('Round 3 L4 / L6: the retry hold and the archived drawing', () => {
  test('L4: the retry hold never cancels a session another window is paying on', () => {
    const cancelled: string[] = [];
    const h = createRetryHold({
      cancel: (n) => void cancelled.push(n),
      drawings: () => undefined,
      busyElsewhere: () => true,
      setTimer: () => 1,
      clearTimer: () => undefined,
    });
    h.hold({
      key: 'K',
      documentId: 'D',
      identityKey: SEAL_KEY,
      fieldIds: ['f1'],
      svg: SVG,
      savedAt: Date.now(),
      resume: { key: 'K', svg: SVG, prepared: preparedFor('NK'), composed: {}, attestation: 'aa', expiresAt: 10 },
    });
    h.giveBack();
    expect(cancelled).toEqual([]);
    const store = localStore(fakeStorage());
    store.claims!.save({ key: 'K', by: 'otherctx', at: Date.now(), until: Date.now() + SEAL_CLAIM_MS });
    expect(sealBusyElsewhere(store, 'K', Date.now())).toBe(true);
    expect(sealBusyElsewhere(store, 'other', Date.now())).toBe(false);
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('busyElsewhere: (key) => sealBusyElsewhere(localStore(), key, Date.now()),');
  });
  test('PROBE B / L6: after "Seal again (you\'ll pay again)" the kept drawing of a PAID seal never says "Nothing was paid"', () => {
    const store = localStore(fakeStorage());
    store.save({
      ...unsure({ nonce: 'N9abcdefghijklmn', txid: TX }),
      beefHex: 'beef',
      refused: { at: Date.now(), status: 422, error: 'x' },
    });
    expect(archiveRefusedSeal(store, 'N9abcdefghijklmn')).toBe(true);
    const d = store.drawings!.get(sealKey(SEAL_KEY, 'D', ['f1']))!;
    expect(d.paidRef).toBe('seal-N9abcdefghij');
    expect(paidAgainDrawingMessage(d.paidRef!)).not.toMatch(/nothing was paid/i);
    expect(paidAgainDrawingMessage(d.paidRef!)).toContain('seal-N9abcdefghij');
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('text: d.paidRef ? paidAgainDrawingMessage(d.paidRef) : RESTORED_DRAWING_MESSAGE,');
  });
});
