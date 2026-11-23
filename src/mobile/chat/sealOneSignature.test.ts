import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DRAWING_MAX_AGE_MS,
  FACE_ID_NOT_PAID_MESSAGE,
  HELD_FOR_REOPEN_MESSAGE,
  NOT_SENT_AFTER_CHECK_MESSAGE,
  PASSWORD_NOT_PAID_MESSAGE,
  RESUME_MARGIN_MS,
  SEAL_NONCE_TTL_MS,
  SETTLE_DELAYS_MS,
  drawingUsable,
  nativeSignAndSeal,
  recoverNativeSeals,
  resumeUsable,
  sealKey,
  sealStateHere,
  settleUnsureSeal,
  type NativeSealError,
  type PendingSealStore,
  type SealApi,
  type SealFailure,
  type SealKeys,
  type SealLedger,
  type SealTxLookup,
} from './nativeSeal';
import { SEAL_HTML, SEAL_KEY, composedFor, preparedFor } from './nativeSeal.fixtures';
import { FINISHING_SEAL_LINE, openingNotice, retryAllowed } from './sealScreen';
import { heldSealFor, localLedger, localStore } from './sealStore';
import { SEAL_FAILURE_PREFIX, reportSealFailure, scrubSealText, sealFailureReportText } from './sealReport';
import { consoleGate } from '../../testing/captureConsole';

/**
 * ONE SIGNATURE PER DOCUMENT (owner, 23 Nov 2026, instrument 1c377264: "having to do it twice is not good"). His seal
 * passed approval and compose, createAction threw an error that was not proof of "nothing sent", the seal was held,
 * the page said "failed", and reopening found no transaction, cancelled the nonce and made him draw and sign again.
 * These pin: a not-paid failure keeps the drawing (and the seal itself while its session lasts), an unclear one is
 * settled on the same screen, the drawing survives a relaunch, and no retry path can pay twice.
 */
const gate = consoleGate(['error', 'warn', 'info']);

const TX = 'ab'.repeat(32);
const T2 = 'ef'.repeat(32);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 250"><path d="M1 1L9 9Z"/></svg>';

/** A localStorage stand-in: a "relaunch" is a new localStore() over the same one. */
const fakeStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

type Log = string[];
/** bit-sign's honest answers; each prepare gives a new nonce (N1, N2, …). */
const bitsign = (log: Log, over: Partial<Record<string, () => Awaited<ReturnType<SealApi>>>> = {}): SealApi => {
  let n = 0;
  let prepared = { documentId: 'D', fieldIds: ['f1'] as string[] };
  return async (path, body) => {
    log.push(path === 'prepare' || path === 'compose' || path === 'cancel' ? `${path}:${body.nonce ?? ''}` : path);
    const o = over[path];
    if (o) return o();
    if (path === 'prepare') {
      prepared = body as typeof prepared;
      return { ok: true, status: 200, body: preparedFor(`N${++n}`) };
    }
    if (path === 'compose')
      return {
        ok: true,
        status: 200,
        body: composedFor({ ...prepared, svg: String(body.svg), nonce: String(body.nonce) }),
      };
    return { ok: true, status: 200, body: { signatureId: 'S', txid: TX, docHash: 'H', complete: true, sealed: true } };
  };
};
/** createSignature logs 'sign'; createAction logs 'pay' and throws the queued errors first. */
const wallet = (log: Log, errs: unknown[] = []): SealKeys => ({
  createSignature: async () => (log.push('sign'), { signature: [1, 2, 3] }),
  createAction: async () => {
    log.push('pay');
    const e = errs.shift();
    if (e) throw e;
    return { txid: TX, tx: [9, 9] };
  },
});
const memLedger = (): SealLedger & { s: Set<string> } => {
  const s = new Set<string>();
  return { has: (d) => s.has(d), add: (d) => void s.add(d), s };
};

const seal = (o: Partial<Parameters<typeof nativeSignAndSeal>[0]> & { log: Log; store: PendingSealStore }) =>
  nativeSignAndSeal({
    documentId: 'D',
    documentHtml: SEAL_HTML,
    identityKey: SEAL_KEY,
    fieldIds: ['f1'],
    svg: SVG,
    api: bitsign(o.log),
    keys: wallet(o.log),
    approve: async () => true,
    ...o,
  });
const noSleep = async () => undefined;
const count = (log: Log, what: string) => log.filter((l) => l === what || l.startsWith(`${what}:`)).length;

describe('Face ID / passcode did not complete: plain words, nothing paid, Try again keeps the drawing', () => {
  test('Face ID cancelled → "Face ID didn\'t complete. Nothing was paid." and Try again pays once, no redraw', async () => {
    const log: Log = [];
    const store = localStore(fakeStorage());
    const e = (await seal({
      log,
      store,
      documentId: 'B1',
      approve: async () => 'device_auth_failed',
    }).catch((x) => x)) as NativeSealError;
    expect(e.code).toBe('cancelled');
    expect(e.message).toBe(FACE_ID_NOT_PAID_MESSAGE);
    expect(retryAllowed(e, false)).toBe(true);
    // The drawing comes back with the error: Try again sends exactly it.
    expect(e.drawing).toMatchObject({ svg: SVG, documentId: 'B1', fieldIds: ['f1'] });
    expect(count(log, 'sign') + count(log, 'pay') + count(log, 'compose')).toBe(0);
    const out = await seal({ log, store, documentId: 'B1', svg: e.drawing!.svg, resume: e.drawing!.resume });
    expect(out.txid).toBe(TX);
    expect(count(log, 'pay')).toBe(1);
    expect(count(log, 'sign')).toBe(1);
  });

  test('the wallet password not confirmed (no phone prompt) says so', async () => {
    const e = await seal({
      log: [],
      store: localStore(fakeStorage()),
      documentId: 'B2',
      approve: async () => 'password_failed',
    }).catch((x) => x);
    expect(e.message).toBe(PASSWORD_NOT_PAID_MESSAGE);
  });

  test('Face ID fails on a pay-only retry: still nothing paid, the kept seal stays (no cancel), the next Try pays once', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Not enough spendable BSV for this payment.');
    const log: Log = [];
    const store = localStore(fakeStorage());
    const keys = wallet(log, [new Error('Not enough spendable BSV for this payment.')]);
    const api = bitsign(log);
    const first = (await seal({ log, store, documentId: 'B3', keys, api }).catch((x) => x)) as NativeSealError;
    expect(first.code).toBe('not_paid');
    const resume = first.drawing!.resume!;
    const second = (await seal({
      log,
      store,
      documentId: 'B3',
      keys,
      api,
      resume,
      approve: async () => 'device_auth_failed',
    }).catch((x) => x)) as NativeSealError;
    expect(second.message).toBe(FACE_ID_NOT_PAID_MESSAGE);
    expect(second.drawing?.resume?.prepared.nonce).toBe('N1');
    expect(count(log, 'cancel')).toBe(0);
    await seal({ log, store, documentId: 'B3', keys, api, resume: second.drawing!.resume });
    expect(log).toEqual(['prepare:', 'compose:N1', 'sign', 'pay', 'pay', 'receipt', 'commit']);
  });

  test('Cancel on the sheet is a cancel: the kept drawing is forgotten (cleared on cancel)', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Not enough spendable BSV for this payment.');
    const log: Log = [];
    const store = localStore(fakeStorage());
    const keys = wallet(log, [new Error('Not enough spendable BSV for this payment.')]);
    const api = bitsign(log);
    const first = (await seal({ log, store, documentId: 'B4', keys, api }).catch((x) => x)) as NativeSealError;
    const key = sealKey(SEAL_KEY, 'B4', ['f1']);
    expect(store.drawings!.get(key)).not.toBeNull();
    const e = await seal({
      log,
      store,
      documentId: 'B4',
      keys,
      api,
      resume: first.drawing!.resume,
      approve: async () => false,
    }).catch((x) => x);
    expect(e.code).toBe('cancelled');
    expect(store.drawings!.get(key)).toBeNull();
    expect(log.at(-1)).toBe('cancel:N1'); // the declined seal's session is given back
  });
});

describe('a createAction that proves nothing went out: Try again pays once, on the same seal', () => {
  test('spent coin (healed in the background) → Try again: no prepare, compose or signature again; one payment', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Some of your coins were already spent from another device.');
    const log: Log = [];
    const store = localStore(fakeStorage());
    const keys = wallet(log, [new Error('Some of your coins were already spent from another device.')]);
    const api = bitsign(log);
    const e = (await seal({ log, store, documentId: 'P1', keys, api }).catch((x) => x)) as NativeSealError;
    expect(e.code).toBe('spent_elsewhere');
    expect(retryAllowed(e, true)).toBe(true);
    await seal({ log, store, documentId: 'P1', keys, api, resume: e.drawing!.resume });
    expect(log).toEqual(['prepare:', 'compose:N1', 'sign', 'pay', 'pay', 'receipt', 'commit']);
    expect(store.drawings!.get(sealKey(SEAL_KEY, 'P1', ['f1']))).toBeNull(); // cleared on success
  });

  test('an EXPIRED session re-prepares silently with the same drawing: old nonce cancelled, a new one, one payment', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Not enough spendable BSV for this payment.');
    const log: Log = [];
    const store = localStore(fakeStorage());
    let t = 1_000_000;
    const now = () => t;
    const keys = wallet(log, [new Error('Not enough spendable BSV for this payment.')]);
    const api = bitsign(log);
    const e = (await seal({ log, store, documentId: 'P2', keys, api, now }).catch((x) => x)) as NativeSealError;
    const resume = e.drawing!.resume!;
    expect(resume.expiresAt).toBeLessThanOrEqual(t + SEAL_NONCE_TTL_MS);
    t = resume.expiresAt - RESUME_MARGIN_MS + 1; // too little time left to pay and commit
    const out = await seal({ log, store, documentId: 'P2', keys, api, now, svg: e.drawing!.svg, resume });
    expect(out.txid).toBe(TX);
    expect(log).toEqual([
      'prepare:',
      'compose:N1',
      'sign',
      'pay',
      'cancel:N1', // the old session given back
      'prepare:',
      'compose:N2', // the SAME drawing composed again: no redraw
      'sign',
      'pay',
      'receipt',
      'commit',
    ]);
  });

  test('a kept seal is used only for the same drawing, signer, blocks and document text', () => {
    const composed = composedFor({ documentId: 'D', fieldIds: ['f1'], svg: SVG, nonce: 'N1' });
    const r = {
      key: sealKey(SEAL_KEY, 'D', ['f1']),
      svg: SVG,
      prepared: preparedFor('N1'),
      composed,
      attestation: '0102',
      expiresAt: 10_000_000,
    };
    const input = { documentId: 'D', documentHtml: SEAL_HTML, fieldIds: ['f1'], svg: SVG, identityKey: SEAL_KEY };
    expect(resumeUsable(input, r, 1_000)).toBe(true);
    expect(resumeUsable({ ...input, svg: '<svg/>' }, r, 1_000)).toBe(false);
    expect(resumeUsable({ ...input, fieldIds: ['a'] }, r, 1_000)).toBe(false);
    expect(resumeUsable({ ...input, identityKey: `03${'cd'.repeat(32)}` }, r, 1_000)).toBe(false);
    expect(resumeUsable({ ...input, documentHtml: SEAL_HTML.replace('Agreement', 'Other') }, r, 1_000)).toBe(false);
    expect(resumeUsable(input, { ...r, composed: { ...composed, lockingScriptHex: '006a00' } }, 1_000)).toBe(false);
    expect(resumeUsable(input, r, r.expiresAt - RESUME_MARGIN_MS)).toBe(false);
    expect(resumeUsable(input, null, 1_000)).toBe(false);
  });
});

describe('an unclear payment is settled on the same screen (never left at "failed")', () => {
  const unclear = async (documentId: string, err = new Error('Failed to fetch')) => {
    const log: Log = [];
    const storage = fakeStorage();
    const store = localStore(storage);
    const api = bitsign(log);
    const failures: SealFailure[] = [];
    const e = (await seal({
      log,
      store,
      documentId,
      api,
      keys: wallet(log, [err]),
      onFailure: (f) => failures.push(f),
    }).catch((x) => x)) as NativeSealError;
    return { log, storage, store, api, e, failures };
  };

  test('found in the wallet → /recover with its BEEF, signature recorded, no second payment', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const { log, store, api, e, failures } = await unclear('U1');
    expect(e.code).toBe('pending_recovery');
    expect(e.nonce).toBe('N1');
    expect(e.drawing).toBeUndefined(); // never a Try again while the money may have moved
    expect(retryAllowed(e, true)).toBe(false);
    expect(failures).toMatchObject([{ outcome: 'pending_recovery', step: 'paying' }]);
    const ledger = memLedger();
    const lookup: SealTxLookup = { find: async () => ({ found: true, txid: T2 }), beef: async () => [7, 7] };
    const r = await settleUnsureSeal({ api, store, nonce: e.nonce!, lookup, ledger, sleep: noSleep });
    expect(r.k).toBe('recorded');
    expect(count(log, 'recover')).toBe(1);
    expect(count(log, 'pay')).toBe(1);
    expect(count(log, 'cancel')).toBe(0);
    expect(store.list()).toEqual([]);
    expect(ledger.s.has(sealKey(SEAL_KEY, 'U1', ['f1']))).toBe(true);
    expect((await seal({ log, store, documentId: 'U1', ledger }).catch((x) => x)).code).toBe('already_sealed');
  });

  test('"not found" (twice, seconds apart) → nonce cancelled → Try again with the SAME drawing pays once', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const { log, store, api, e } = await unclear('U2');
    const waits: number[] = [];
    let asked = 0;
    const r = await settleUnsureSeal({
      api,
      store,
      nonce: e.nonce!,
      lookup: { find: async () => (asked++, { found: false }), beef: async () => null },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(r.k).toBe('not_paid');
    expect(asked).toBe(2);
    expect(waits).toEqual(SETTLE_DELAYS_MS.slice(0, 2));
    expect(count(log, 'cancel')).toBe(1);
    expect(store.list()).toEqual([]);
    const d = (r as { drawing: { svg: string } }).drawing;
    expect(d.svg).toBe(SVG);
    expect(NOT_SENT_AFTER_CHECK_MESSAGE).toContain('Nothing was paid');
    const out = await seal({ log, store, documentId: 'U2', svg: d.svg });
    expect(out.txid).toBe(TX);
    expect(count(log, 'pay')).toBe(2); // the failed attempt and this one: never two payments that went out
    expect(store.drawings!.get(sealKey(SEAL_KEY, 'U2', ['f1']))).toBeNull();
  });

  test('one "not found" then found: never released (a single answer is not proof)', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const { log, store, api, e } = await unclear('U3');
    const answers = [{ found: false as const }, { found: true as const, txid: T2 }];
    const r = await settleUnsureSeal({
      api,
      store,
      nonce: e.nonce!,
      lookup: { find: async () => answers.shift() ?? null, beef: async () => [7] },
      sleep: noSleep,
    });
    expect(r.k).toBe('recorded');
    expect(count(log, 'cancel')).toBe(0);
  });

  test('still unknown after polling → held: "Finishing your seal…", no Sign button, never a second seal', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const { log, store, api, e } = await unclear('U4');
    const waits: number[] = [];
    const r = await settleUnsureSeal({
      api,
      store,
      nonce: e.nonce!,
      // A lookup that fails is never "not found".
      lookup: { find: async () => null, beef: async () => null },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(r.k).toBe('unknown');
    expect(waits).toEqual([...SETTLE_DELAYS_MS]); // bounded: ≈28 s, growing
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30_000);
    expect(count(log, 'cancel') + count(log, 'recover')).toBe(0);
    expect(store.list()).toMatchObject([{ documentId: 'U4', beefHex: '', svg: SVG }]);
    expect(sealStateHere(SEAL_KEY, 'U4', ['f1'], store)).toBe('unsure');
    expect(openingNotice('unsure', false)).toEqual({ text: FINISHING_SEAL_LINE, busy: true });
    expect(openingNotice('unsure', true)?.text).toBe(HELD_FOR_REOPEN_MESSAGE);
    expect(heldSealFor('U4', store)).toBe(true); // the room's card says "Finishing your seal…"
    expect((await seal({ log, store, documentId: 'U4' }).catch((x) => x)).code).toBe('already_sealed');
    expect(count(log, 'pay')).toBe(1);
  });

  test('no lookup at all (or a lookup that throws) → unknown, held', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const { store, api, e } = await unclear('U5');
    expect((await settleUnsureSeal({ api, store, nonce: e.nonce!, sleep: noSleep })).k).toBe('unknown');
    const boom = { find: () => Promise.reject(new Error('db closed')), beef: async () => null };
    expect((await settleUnsureSeal({ api, store, nonce: e.nonce!, lookup: boom, sleep: noSleep })).k).toBe('unknown');
    expect(store.list()).toHaveLength(1);
  });

  test('a seal paying again in this app is never touched by the check', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const { store, api, e } = await unclear('U6');
    // Simulate the same seal running now: a hung payment for U6 holds its key.
    let release!: () => void;
    const hung: SealKeys = {
      createSignature: async () => ({ signature: [1] }),
      createAction: () => new Promise((r) => (release = () => r({ txid: TX, tx: [9] }))),
    };
    store.remove(e.nonce!); // (a different record would block the second seal)
    const running = seal({ log: [], store, documentId: 'U6', keys: hung, api });
    for (let i = 0; i < 50 && !release; i++) await Promise.resolve();
    let asked = 0;
    const r = await settleUnsureSeal({
      api,
      store,
      nonce: 'N2',
      lookup: { find: async () => (asked++, { found: false }), beef: async () => null },
      sleep: noSleep,
    });
    expect(r.k).toBe('unknown');
    expect(asked).toBe(0);
    release();
    await running;
  });
});

describe('the drawing is kept on this device and restored after a relaunch', () => {
  test('crash after an unclear payment → relaunch → recovery proves unpaid → "Seal again" with the same drawing', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Failed to fetch');
    const storage = fakeStorage();
    const log: Log = [];
    const api = bitsign(log);
    const e = await seal({
      log,
      store: localStore(storage),
      documentId: 'R1',
      api,
      keys: wallet(log, [new Error('Failed to fetch')]),
    }).catch((x) => x);
    expect(e.code).toBe('pending_recovery');
    // The app dies here. A NEW store instance over the same device storage (a relaunch):
    const after = localStore(storage);
    expect(after.list()).toMatchObject([{ documentId: 'R1', svg: SVG, fieldIds: ['f1'] }]);
    await recoverNativeSeals(api, after, 'R1', localLedger(storage), {
      find: async () => ({ found: false }),
      beef: async () => null,
    });
    const reopened = localStore(storage);
    expect(reopened.list()).toEqual([]);
    const key = sealKey(SEAL_KEY, 'R1', ['f1']);
    const d = reopened.drawings!.get(key);
    expect(d).toMatchObject({ svg: SVG, documentId: 'R1', identityKey: SEAL_KEY, fieldIds: ['f1'] });
    expect(drawingUsable(d, key, Date.now())).toBe(true);
    expect(sealStateHere(SEAL_KEY, 'R1', ['f1'], reopened)).toBe('none'); // the page offers "Seal again"
    await seal({ log, store: reopened, documentId: 'R1', svg: d!.svg, api });
    expect(count(log, 'pay')).toBe(2);
    expect(localStore(storage).drawings!.get(key)).toBeNull(); // cleared on success
  });

  test('a not-paid seal survives a relaunch WITH its kept session, and pays on it while it lasts', async () => {
    gate.expectLines('warn [nativeSeal] pay failed Not enough spendable BSV for this payment.');
    const storage = fakeStorage();
    const log: Log = [];
    const api = bitsign(log);
    await seal({
      log,
      store: localStore(storage),
      documentId: 'R2',
      api,
      keys: wallet(log, [new Error('Not enough spendable BSV for this payment.')]),
    }).catch((x) => x);
    const d = localStore(storage).drawings!.get(sealKey(SEAL_KEY, 'R2', ['f1']))!;
    expect(d.resume?.prepared.nonce).toBe('N1');
    await seal({ log, store: localStore(storage), documentId: 'R2', api, svg: d.svg, resume: d.resume });
    expect(log).toEqual(['prepare:', 'compose:N1', 'sign', 'pay', 'pay', 'receipt', 'commit']);
  });

  test('old or foreign drawings are not offered; storage stays small', () => {
    const now = 5 * DRAWING_MAX_AGE_MS;
    const d = { key: 'k', documentId: 'D', identityKey: SEAL_KEY, fieldIds: ['f1'], svg: SVG, savedAt: now };
    expect(drawingUsable(d, 'k', now)).toBe(true);
    expect(drawingUsable(d, 'other', now)).toBe(false);
    expect(drawingUsable({ ...d, savedAt: now - DRAWING_MAX_AGE_MS }, 'k', now)).toBe(false);
    expect(drawingUsable({ ...d, svg: 'x'.repeat(20_000) }, 'k', now)).toBe(false);
    const storage = fakeStorage();
    const s = localStore(storage, () => now);
    for (let i = 0; i < 25; i++) s.drawings!.save({ ...d, key: `k${i}` });
    expect(JSON.parse(storage.getItem('bwx.nativeSeal.drawings')!)).toHaveLength(10);
    // Blocked storage reads as empty and never throws.
    const blocked = localStore({
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    expect(blocked.list()).toEqual([]);
    expect(blocked.drawings!.get('k')).toBeNull();
    expect(() => blocked.drawings!.save(d)).not.toThrow();
  });
});

describe('the createAction error is reported to b, with no secrets', () => {
  const WIF = 'L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ';
  const ctx = { version: '5.2.63', channel: 'ios', edition: 'bWalletX', time: '2026-11-23T10:00:00.000Z' };

  test('kind, moneyMoved, step, version and platform; no txid, key, BEEF or attestation; a stable prefix', () => {
    const err = Object.assign(
      new Error(
        `Failed to fetch while broadcasting ${'cd'.repeat(32)} beef 0100beef${'00'.repeat(60)} key ${WIF} attestation 3045022100${'aa'.repeat(32)} base64 ${'QUJD'.repeat(20)}`,
      ),
      { name: 'TypeError' },
    );
    const sent: string[] = [];
    const warned: unknown[][] = [];
    reportSealFailure(
      { outcome: 'pending_recovery', step: 'paying', error: err },
      { send: (t) => void sent.push(t), ctx, warn: (...a) => void warned.push(a) },
    );
    return Promise.resolve().then(async () => {
      await Promise.resolve();
      expect(sent).toHaveLength(1);
      const text = sent[0];
      expect(text).toContain('pending_recovery');
      expect(text).toContain('Step: paying');
      expect(text).toContain('kind network · moneyMoved no');
      expect(text).toContain('TypeError');
      expect(text).toContain('Version: 5.2.63');
      expect(text).toContain('Platform: ios');
      for (const secret of ['cd'.repeat(32), WIF, '0100beef', '3045022100', 'QUJDQUJD'])
        expect(text).not.toContain(secret);
      expect(warned[0][0]).toBe(SEAL_FAILURE_PREFIX);
      expect(String(warned[0][1])).toMatch(/^pending_recovery step=paying kind=network moneyMoved=no: /);
      expect(String(warned[0][1])).not.toContain(WIF);
    });
  });

  test('the message is cut; the settle result is named; a failing send never throws', () => {
    expect(scrubSealText('x '.repeat(500)).length).toBeLessThanOrEqual(300);
    const t = sealFailureReportText(
      { outcome: 'not_paid', step: 'paying', error: new Error('Not enough spendable BSV for this payment.') },
      ctx,
      'not_paid',
    );
    expect(t).toContain('on-screen check: not_paid');
    expect(t).toContain('kind insufficient-funds · moneyMoved no');
    expect(() =>
      reportSealFailure(
        { outcome: 'not_paid', step: 'paying', error: 'x' },
        {
          send: () => {
            throw new Error('offline');
          },
          ctx,
          warn: () => undefined,
        },
      ),
    ).not.toThrow();
  });

  test('the seal tells its failures (pending_recovery and not_paid at the payment) and the page reports them', async () => {
    gate.expectLines(
      'warn [nativeSeal] pay failed Not enough spendable BSV for this payment.',
      'warn [nativeSeal] pay failed An internal error has occurred.',
    );
    const got: SealFailure[] = [];
    const store = localStore(fakeStorage());
    for (const [doc, msg] of [
      ['E1', 'Not enough spendable BSV for this payment.'],
      ['E2', 'An internal error has occurred.'],
    ] as const) {
      const log: Log = [];
      await seal({
        log,
        store,
        documentId: doc,
        keys: wallet(log, [new Error(msg)]),
        onFailure: (f) => got.push(f),
      }).catch((x) => x);
    }
    expect(got.map((f) => [f.outcome, f.step, (f.error as Error).message])).toEqual([
      ['not_paid', 'paying', 'Not enough spendable BSV for this payment.'],
      ['pending_recovery', 'paying', 'An internal error has occurred.'],
    ]);
    // The failure carries only the error: never the attestation or the BEEF.
    expect(JSON.stringify(got.map((f) => Object.keys(f)))).toBe(
      '[["outcome","step","error"],["outcome","step","error"]]',
    );
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('reportSealFailure(f, {');
    expect(page).toContain('sendOrQueueReport(apiContext, currentAccountId(chromeStorageService), text)');
    expect(page).toMatch(/onFailure: \(f\) => \{[\s\S]{0,80}reportFailure\(f\);/);
  });
});

describe('the page wires one signature per document (NativeSealPage.tsx)', () => {
  const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
  test('an unclear payment is checked on the same screen; never left at "failed"', () => {
    expect(page).toMatch(/e\.code === 'pending_recovery' && e\.nonce\)[\s\S]{0,80}setPhase\(\{ k: 'checking' \}\)/);
    expect(page).toContain('await settleUnsureSeal({');
    expect(page).toContain("setPhase({ k: 'held', text: HELD_FOR_REOPEN_MESSAGE })");
  });
  test('Try again / Seal again send the kept drawing (and kept seal); the restored drawing is checked first', () => {
    expect(page).toContain('onClick={() => void signAndSeal(phase.drawing.svg, phase.drawing.resume)}');
    expect(page).toMatch(/drawingUsable\(d, key, Date\.now\(\)\) && !checkStrictSvg\(d\.svg\)/);
    expect(page).toMatch(/if \(!svg \|\| checkStrictSvg\(svg\) \|\| !press\.take\(\)\) return;/);
    expect(page).toContain('label: SEAL_AGAIN_LABEL');
  });
  test('the room card shows "Finishing your seal…" for a held seal, never a fresh Sign button', () => {
    for (const f of ['./DocSignButton.tsx', './PendingDocBanner.tsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).toContain('heldSealFor(');
      expect(src).toContain('FINISHING_SEAL_LINE');
    }
  });
});
