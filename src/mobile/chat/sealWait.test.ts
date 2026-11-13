import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ALREADY_SEALED_MESSAGE,
  BUSY_ELSEWHERE_MESSAGE,
  LEFT_PAGE_MESSAGE,
  MAY_HAVE_PAID_MESSAGE,
  NEWER_VERSION_MESSAGE,
  NativeSealError,
  SEAL_HOLD_MAX_MS,
  abandonSeal,
  findSealAction,
  type ListActionsFn,
  nativeSignAndSeal,
  recoverNativeSeals,
  sealKey,
  sealStateHere,
  type PendingSeal,
  type SealApi,
  type SealKeys,
  type SealLedger,
} from './nativeSeal';
import { COIN_WAIT_CAP_MS, COIN_WAIT_SLOW_MS, type WakeClock } from './coinWait';
import { SEAL_HTML, SEAL_KEY, composedFor, preparedFor } from './nativeSeal.fixtures';
import {
  COIN_SLOW_LINE,
  FRESH_COIN_LINE,
  RECORDING_LINE,
  STILL_RECORDING_LINE,
  openingNotice,
  retryAllowed,
  sealProgress,
} from './sealScreen';

/** The seal()'s default key: no identity key, document D, block f1. */
/** The seal output the wallet builds for block f1 of the fixture document (its ref is the manifest's, any id). */
const SEAL_SCRIPT = composedFor({ documentId: 'D', fieldIds: ['f1'], svg: '<svg/>', nonce: 'N1' }).lockingScriptHex;
const KEY_D = sealKey(SEAL_KEY, 'D', ['f1']);
const stateD = (store: Parameters<typeof sealStateHere>[3], ledger?: Parameters<typeof sealStateHere>[4]) =>
  sealStateHere(SEAL_KEY, 'D', ['f1'], store, ledger);

/**
 * The seal must never sit on "Finding a fresh coin…" (owner's iPhone, 6 Nov 2026, doc 2ddfb0ce): the app woke from an
 * hour in the background, the coin check queued behind a failing backup heal, and the wait was a plain 45 s setTimeout
 * that WKWebView freezes while the app is in the background. He gave up, sealed again from the desktop, and the
 * document was paid twice.
 */

const TX = 'ab'.repeat(32);
const memStore = () => {
  const m = new Map<string, PendingSeal>();
  return {
    list: () => [...m.values()],
    save: (p: PendingSeal) => void m.set(p.nonce, p),
    remove: (n: string) => void m.delete(n),
    m,
  };
};
const memLedger = (): SealLedger & { s: Set<string> } => {
  const s = new Set<string>();
  return { has: (d) => s.has(d), add: (d) => void s.add(d), s };
};
const keys = (log: string[]): SealKeys => ({
  createSignature: async () => (log.push('sign'), { signature: [1, 2, 3] }),
  createAction: async () => (log.push('pay'), { txid: TX, tx: [9, 9] }),
});
const api = (
  log: string[],
  over: Partial<Record<string, () => { ok: boolean; status: number; body: Record<string, unknown> }>> = {},
  /** The signer bit-sign has linked (its prepare and compose name it). */
  key = SEAL_KEY,
): SealApi => {
  let prepared = { documentId: 'D', fieldIds: ['f1'] as string[] };
  return async (path, body) => {
    log.push(path);
    const o = over[path];
    if (o) return o();
    if (path === 'prepare') {
      prepared = body as typeof prepared;
      return { ok: true, status: 200, body: preparedFor('N1', key) };
    }
    if (path === 'compose')
      return {
        ok: true,
        status: 200,
        body: composedFor({ ...prepared, svg: String(body.svg), nonce: String(body.nonce), identityKey: key }),
      };
    return { ok: true, status: 200, body: { signatureId: 'S', txid: TX, docHash: 'H', complete: true, sealed: true } };
  };
};

/** A clock whose timers never fire (a frozen WKWebView) unless the test fires them; `now` moves only when told. */
const frozenClock = () => {
  let t = 1_000_000;
  const ticks: (() => void)[] = [];
  const wakes: (() => void)[] = [];
  const clock: WakeClock = {
    now: () => t,
    every: (_ms, fn) => {
      ticks.push(fn);
      return () => void ticks.splice(ticks.indexOf(fn), 1);
    },
    onWake: (fn) => {
      wakes.push(fn);
      return () => void wakes.splice(wakes.indexOf(fn), 1);
    },
  };
  return {
    clock,
    advance: (ms: number) => void (t += ms),
    tick: () => [...ticks].forEach((f) => f()),
    wake: () => [...wakes].forEach((f) => f()),
    listeners: () => ticks.length + wakes.length,
  };
};
const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
/** Resolves once `cond` holds, flushing microtasks only (no timers: they are what this file distrusts). */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await flush(1);
  if (!cond()) throw new Error('condition never held');
};
const never = new Promise<void>(() => undefined);

const seal = (extra: Partial<Parameters<typeof nativeSignAndSeal>[0]> & { log?: string[]; steps?: string[] }) => {
  const log = extra.log ?? [];
  const steps = extra.steps ?? [];
  return nativeSignAndSeal({
    documentId: 'D',
    documentHtml: SEAL_HTML,
    identityKey: SEAL_KEY,
    fieldIds: ['f1'],
    svg: '<svg/>',
    api: api(log, {}, extra.identityKey ?? SEAL_KEY),
    keys: keys(log),
    store: memStore(),
    approve: async () => true,
    onStep: (s) => steps.push(s),
    ...extra,
  });
};

describe('the coin wait runs on the wall clock, never on a timer that can freeze', () => {
  test('timers never fire, Date.now moves on: the page waking up lets the seal pay', async () => {
    const f = frozenClock();
    const log: string[] = [];
    const steps: string[] = [];
    let out: unknown = null;
    void seal({ log, steps, clock: f.clock, coins: { pending: () => true, done: never } }).then((o) => (out = o));
    await until(() => steps.includes('healing'));
    // Minutes in the background: no tick ever ran. The wall clock moved.
    f.advance(5 * 60_000);
    expect(log).not.toContain('pay');
    f.wake(); // visibilitychange / pageshow / focus
    await until(() => out !== null);
    expect(log).toContain('pay');
    expect(steps).toEqual(['preparing', 'approving', 'healing', 'composing', 'signing', 'paying', 'committing']);
    expect(f.listeners()).toBe(0); // nothing left listening
  });

  test('in the foreground the short tick moves on by itself at the cap (about 8 s), not 45 s', async () => {
    expect(COIN_WAIT_CAP_MS).toBeLessThanOrEqual(8_000);
    const f = frozenClock();
    const log: string[] = [];
    let out: unknown = null;
    void seal({ log, clock: f.clock, coins: { pending: () => true, done: never } }).then((o) => (out = o));
    await until(() => f.listeners() > 2); // the hold's deadline (2) and the coin wait's (2)
    f.advance(COIN_WAIT_CAP_MS - 1);
    f.tick();
    await flush();
    expect(log).not.toContain('pay');
    f.advance(1);
    f.tick();
    await until(() => out !== null);
    expect(log).toContain('pay');
  });

  test('the real browser clock: setTimeout and setInterval frozen, Date.now moving, a visibilitychange wakes it', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { st: g.setTimeout, si: g.setInterval, now: Date.now, doc: g.document };
    let t = 5_000_000;
    const doc = new EventTarget() as EventTarget & { visibilityState: string };
    doc.visibilityState = 'visible';
    try {
      g.setTimeout = (() => 0) as never; // frozen: never fires
      g.setInterval = (() => 0) as never;
      Date.now = () => t;
      g.document = doc;
      const log: string[] = [];
      const steps: string[] = [];
      let out: unknown = null;
      void seal({ log, steps, coins: { pending: () => true, done: never } }).then((o) => (out = o));
      await until(() => steps.includes('healing'));
      t += 5 * 60_000;
      doc.dispatchEvent(new Event('visibilitychange'));
      await until(() => out !== null);
      expect(log).toContain('pay');
    } finally {
      g.setTimeout = saved.st;
      g.setInterval = saved.si;
      Date.now = saved.now;
      g.document = saved.doc;
    }
  });

  test('a coin check that finishes first still goes straight on', async () => {
    const f = frozenClock();
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const log: string[] = [];
    let out: unknown = null;
    void seal({ log, clock: f.clock, coins: { pending: () => true, done } }).then((o) => (out = o));
    await until(() => f.listeners() > 2); // the hold's deadline (2) and the coin wait's (2)
    finish();
    await until(() => out !== null);
    expect(log).toContain('pay');
  });
});

describe('a backup heal or sync holding the storage locks: no coin wait at all', () => {
  test('storage busy → pays at once; the clock never has to move', async () => {
    const f = frozenClock();
    const log: string[] = [];
    let asked = 0;
    const out = await seal({
      log,
      clock: f.clock,
      coins: { pending: () => true, done: never, storageBusy: async () => (asked++, true) },
    });
    expect(out.txid).toBe(TX);
    expect(asked).toBe(1);
    expect(log).toContain('pay');
  });

  test('storage not busy → still waits for the coin check (up to the cap)', async () => {
    const f = frozenClock();
    const log: string[] = [];
    void seal({
      log,
      documentId: 'D-hangs',
      clock: f.clock,
      coins: { pending: () => true, done: never, storageBusy: async () => false },
    });
    await flush(100);
    expect(log).not.toContain('pay');
  });
});

describe('a wait over 2 s says what it is doing', () => {
  test('the line under "Finding a fresh coin…"', () => {
    expect(COIN_SLOW_LINE).toBe('Checking your coins — this can take a few seconds after the app wakes');
    expect(sealProgress('healing').map((l) => l.text)).toEqual([FRESH_COIN_LINE]);
    expect(sealProgress('healing', true).map((l) => l.text)).toEqual([FRESH_COIN_LINE, COIN_SLOW_LINE]);
  });

  test('onSlow fires once the wall clock passes 2 s, then the cap moves on by itself', async () => {
    expect(COIN_WAIT_SLOW_MS).toBe(2_000);
    const f = frozenClock();
    const slow: string[] = [];
    const log: string[] = [];
    let out: unknown = null;
    void seal({ log, clock: f.clock, onSlow: (s) => slow.push(s), coins: { pending: () => true, done: never } }).then(
      (o) => (out = o),
    );
    await until(() => f.listeners() > 2); // the hold's deadline (2) and the coin wait's (2)
    f.advance(1_900);
    f.tick();
    expect(slow).toEqual([]);
    f.advance(200);
    f.tick();
    f.tick();
    expect(slow).toEqual(['healing']);
    f.advance(COIN_WAIT_CAP_MS);
    f.tick();
    await until(() => out !== null);
    expect(log).toContain('pay');
  });
});

describe('no second seal for a document already sealed (or being sealed) from this device', () => {
  test('sealed here before → "Already sealed", nothing asked of the server, nothing paid', async () => {
    const ledger = memLedger();
    const log: string[] = [];
    await seal({ log, ledger });
    expect(ledger.s.has(KEY_D)).toBe(true);
    const e = await seal({ log, ledger }).catch((x) => x);
    expect(e).toBeInstanceOf(NativeSealError);
    expect(e.code).toBe('already_sealed');
    expect(e.message).toBe(ALREADY_SEALED_MESSAGE);
    expect(e.message.startsWith('Already sealed')).toBe(true);
    expect(log.filter((l) => l === 'pay').length).toBe(1);
    expect(log.filter((l) => l === 'prepare').length).toBe(1);
  });

  test('a paid-but-unrecorded seal saved for this document → "Already sealed", no prepare', async () => {
    const store = memStore();
    store.save({ documentId: 'D', nonce: 'N0', txid: TX, beefHex: '99', attestation: 'aa', savedAt: 1 });
    const log: string[] = [];
    const e = await seal({ log, store }).catch((x) => x);
    expect(e.code).toBe('already_sealed');
    expect(log).toEqual([]);
    expect(stateD(store, memLedger())).toBe('recording');
    expect(sealStateHere(SEAL_KEY, 'OTHER', ['f1'], store, memLedger())).toBe('none');
  });

  test('a seal in flight for this document → a second one is refused', async () => {
    let release!: () => void;
    const held = new Promise<boolean>((r) => (release = () => r(true)));
    const log: string[] = [];
    const first = seal({ log, documentId: 'D-flight', approve: () => held });
    await until(() => log.includes('prepare'));
    const e = await seal({ log, documentId: 'D-flight' }).catch((x) => x);
    expect(e.code).toBe('already_sealed');
    release();
    await first;
    expect(log.filter((l) => l === 'pay').length).toBe(1);
    // Done and not recorded as sealed (no ledger given): the in-flight hold is gone.
    expect(sealStateHere(SEAL_KEY, 'D-flight', ['f1'], memStore(), memLedger())).toBe('none');
  });

  test('signer_race (another party sealed since this started) → "open the latest version", not "Already sealed"', async () => {
    const log: string[] = [];
    const e = await seal({
      log,
      documentId: 'D-race',
      api: api(log, {
        compose: () => ({ ok: false, status: 409, body: { error: 'Another party sealed…', code: 'signer_race' } }),
      }),
    }).catch((x) => x);
    expect(e.code).toBe('newer_version');
    expect(e.message).toBe(NEWER_VERSION_MESSAGE);
    expect(e.message).not.toContain('Already sealed');
    expect(log).not.toContain('pay');
    expect(retryAllowed(e, false)).toBe(false); // the page offers "Open the latest version" instead
  });

  test('the server says already_sealed → "Already sealed", no button back', async () => {
    const log: string[] = [];
    const e = await seal({
      log,
      documentId: 'D-sealed',
      api: api(log, { prepare: () => ({ ok: false, status: 409, body: { code: 'already_sealed' } }) }),
    }).catch((x) => x);
    expect(e.code).toBe('already_sealed');
    expect(e.message).toBe(ALREADY_SEALED_MESSAGE);
    expect(retryAllowed(e, false)).toBe(false);
  });

  test("signer_busy (being sealed on another of your devices) → a plain refusal, the server's words, nothing paid", async () => {
    const log: string[] = [];
    const words = 'This document is being sealed on another of your devices';
    const e = await seal({
      log,
      documentId: 'D-busy',
      api: api(log, { prepare: () => ({ ok: false, status: 409, body: { error: words, code: 'signer_busy' } }) }),
    }).catch((x) => x);
    expect(e.code).toBe('refused');
    expect(e.message).toBe(words);
    expect(log).not.toContain('pay');
    expect(retryAllowed(e, false)).toBe(true); // nothing paid: the button comes back with that line, no spinner
    const bare = await seal({
      documentId: 'D-busy2',
      api: api([], { compose: () => ({ ok: false, status: 409, body: { code: 'signer_busy' } }) }),
    }).catch((x) => x);
    expect(bare.message).toBe(BUSY_ELSEWHERE_MESSAGE);
  });

  test('an orphaned result (another party sealed first) is recorded as sealed here too', async () => {
    const ledger = memLedger();
    const log: string[] = [];
    await seal({
      log,
      ledger,
      api: api(log, { commit: () => ({ ok: true, status: 200, body: { orphaned: true, success: false } }) }),
    }).catch((x) => x);
    expect(ledger.s.has(KEY_D)).toBe(true);
  });

  test('a seal finished by recovery on reopen is recorded as sealed', async () => {
    const store = memStore();
    store.save({
      documentId: 'D',
      nonce: 'N0',
      txid: TX,
      beefHex: '99',
      attestation: 'aa',
      savedAt: 1,
      identityKey: SEAL_KEY,
      fieldIds: ['f1'],
    });
    const ledger = memLedger();
    const n = await recoverNativeSeals(api([]), store, 'D', ledger);
    expect(n).toBe(1);
    expect(ledger.s.has(KEY_D)).toBe(true);
    expect(stateD(store, ledger)).toBe('sealed');
  });
});

describe('the ledger is keyed by who signs which blocks of which document', () => {
  test('another account on this phone, or other blocks, still sign; the same account and blocks do not', async () => {
    const ledger = memLedger();
    const log: string[] = [];
    await seal({ log, ledger, documentId: 'K', identityKey: '02AAA', fieldIds: ['b', 'a'] });
    // Same signer, same blocks (any order, any case of the key): refused before the server is asked.
    const again = await seal({ log, ledger, documentId: 'K', identityKey: '02aaa', fieldIds: ['a', 'b'] }).catch(
      (x) => x,
    );
    expect(again.code).toBe('already_sealed');
    // Another account on this phone: signs.
    await seal({ log, ledger, documentId: 'K', identityKey: '02bbb', fieldIds: ['a', 'b'] });
    // The same account, another block: signs.
    await seal({ log, ledger, documentId: 'K', identityKey: '02aaa', fieldIds: ['c'] });
    expect(log.filter((l) => l === 'pay').length).toBe(3);
    expect(ledger.s.has('K')).toBe(false); // never by document id alone
  });

  test('a saved payment carries its signer and blocks, so it only holds that seal', async () => {
    const store = memStore();
    let ok = true;
    await seal({
      documentId: 'P',
      identityKey: '02aaa',
      store,
      api: api(
        [],
        {
          commit: () => ({ ok: false, status: 503, body: {} }),
          recover: () => ({ ok: false, status: 503, body: {} }),
        },
        '02aaa',
      ),
    }).catch(() => (ok = false));
    expect(ok).toBe(false); // pending_recovery: saved
    expect(store.list()[0]).toMatchObject({ documentId: 'P', identityKey: '02aaa', fieldIds: ['f1'] });
    expect(sealStateHere('02aaa', 'P', ['f1'], store)).toBe('recording');
    expect(sealStateHere('02bbb', 'P', ['f1'], store)).toBe('none');
    expect(sealStateHere('02aaa', 'P', ['f2'], store)).toBe('none');
    // One saved before keys were stored matches by document id alone (the safe side).
    store.save({ documentId: 'OLD', nonce: 'N9', txid: TX, beefHex: '99', attestation: 'aa', savedAt: 1 });
    expect(sealStateHere('02bbb', 'OLD', ['x'], store)).toBe('recording');
  });
});

describe('on open: a paid-but-unrecorded seal says "Paid, being recorded…", then the real result', () => {
  test('before recovery ends: being recorded (busy), never "Already sealed"', () => {
    expect(RECORDING_LINE).toBe('Paid, being recorded…');
    expect(openingNotice('recording', false)).toEqual({ text: RECORDING_LINE, busy: true });
    expect(openingNotice('recording', false)?.text).not.toContain('Already sealed');
  });
  test('after recovery: recorded → Already sealed; still saved → still being recorded; refused → the pad', async () => {
    const store = memStore();
    const ledger = memLedger();
    store.save({
      documentId: 'D',
      nonce: 'N0',
      txid: TX,
      beefHex: '99',
      attestation: 'aa',
      savedAt: 1,
      identityKey: SEAL_KEY,
      fieldIds: ['f1'],
    });
    expect(openingNotice(stateD(store, ledger), false)?.text).toBe(RECORDING_LINE);
    await recoverNativeSeals(api([]), store, 'D', ledger);
    expect(openingNotice(stateD(store, ledger), true)?.text).toBe(ALREADY_SEALED_MESSAGE);
    expect(openingNotice('recording', true)).toEqual({ text: STILL_RECORDING_LINE, busy: false });
    expect(openingNotice('none', true)).toBeNull();
  });
});

describe('a hung seal never blocks its document until restart', () => {
  test('left before paying: the hold is released and the abandoned seal never pays', async () => {
    let approve!: (ok: boolean) => void;
    const log: string[] = [];
    const first = seal({ log, documentId: 'H1', approve: () => new Promise<boolean>((r) => (approve = r)) }).catch(
      (x) => x,
    );
    await until(() => typeof approve === 'function'); // the approval sheet is up
    const key = sealKey(SEAL_KEY, 'H1', ['f1']);
    expect(sealStateHere(SEAL_KEY, 'H1', ['f1'], memStore())).toBe('in_flight');
    expect(abandonSeal(key)).toBe(true); // the page unmounted
    expect(sealStateHere(SEAL_KEY, 'H1', ['f1'], memStore())).toBe('none');
    approve(true); // the old flow wakes up after the page is gone
    const e = await first;
    expect(e.code).toBe('cancelled');
    expect(e.message).toBe(LEFT_PAGE_MESSAGE);
    expect(log).not.toContain('pay');
    await seal({ log, documentId: 'H1' }); // a new page seals it once
    expect(log.filter((l) => l === 'pay').length).toBe(1);
  });

  test('left while paying: the hold stays (a second seal could pay twice)', async () => {
    const log: string[] = [];
    let paid!: () => void;
    const hung: SealKeys = {
      createSignature: async () => ({ signature: [1] }),
      createAction: () => new Promise((r) => (paid = () => r({ txid: TX, tx: [9, 9] }))),
    };
    const first = seal({ log, documentId: 'H2', keys: hung, steps: log });
    await until(() => log.includes('paying'));
    expect(abandonSeal(sealKey(SEAL_KEY, 'H2', ['f1']))).toBe(false);
    expect((await seal({ documentId: 'H2' }).catch((x) => x)).code).toBe('already_sealed');
    paid();
    await first;
    expect(sealStateHere(SEAL_KEY, 'H2', ['f1'], memStore())).toBe('none'); // released on settle
  });

  test('a seal hung BEFORE paying lets go after SEAL_HOLD_MAX_MS on the wall clock, and then never pays', async () => {
    const f = frozenClock();
    const log: string[] = [];
    let approve!: (ok: boolean) => void;
    let out: unknown = null;
    void seal({
      log,
      documentId: 'H3',
      clock: f.clock,
      approve: () => new Promise<boolean>((r) => (approve = r)),
    }).catch((x) => (out = x));
    await until(() => typeof approve === 'function');
    f.advance(SEAL_HOLD_MAX_MS);
    f.wake();
    await flush();
    expect(sealStateHere(SEAL_KEY, 'H3', ['f1'], memStore())).toBe('none');
    approve(true);
    await until(() => out !== null);
    expect((out as NativeSealError).code).toBe('cancelled');
    expect(log).not.toContain('pay');
  });

  test('a PAYING seal survives a 10+ minute sleep: the hold stays, and its unsure record is on the phone', async () => {
    const f = frozenClock();
    const log: string[] = [];
    const store = memStore();
    const hung: SealKeys = {
      createSignature: async () => ({ signature: [1] }),
      createAction: () => new Promise(() => undefined),
    };
    void seal({ log, documentId: 'H5', store, keys: hung, clock: f.clock, steps: log });
    await until(() => log.includes('paying'));
    expect(store.list()).toMatchObject([{ documentId: 'H5', nonce: 'N1', beefHex: '', lockingScriptHex: SEAL_SCRIPT }]);
    f.advance(SEAL_HOLD_MAX_MS + 60 * 60_000); // asleep for over an hour mid-payment
    f.wake();
    f.tick();
    await flush();
    expect(sealStateHere(SEAL_KEY, 'H5', ['f1'], store)).toBe('in_flight');
    expect((await seal({ documentId: 'H5', store }).catch((x) => x)).code).toBe('already_sealed');
    // Recovery leaves a seal that is still paying alone.
    let asked = 0;
    await recoverNativeSeals(api([]), store, 'H5', null, {
      find: async () => (asked++, { found: false }),
      beef: async () => null,
    });
    expect(asked).toBe(0);
    expect(store.m.size).toBe(1);
  });

  test('released on an error too', async () => {
    const e = await seal({
      documentId: 'H4',
      api: api([], { compose: () => ({ ok: false, status: 500, body: { error: 'boom' } }) }),
    }).catch((x) => x);
    expect(e.code).toBe('refused');
    expect(sealStateHere(SEAL_KEY, 'H4', ['f1'], memStore())).toBe('none');
  });
});

describe('the page wires the guard (NativeSealPage.tsx)', () => {
  const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
  test('the seal key carries the identity key; the opening notice waits for recovery; the hold is let go on unmount', () => {
    expect(page).toContain('identityKey: myKey');
    expect(page).toMatch(/sealStateHere\(myKey, doc\.documentId, ids/);
    expect(page).toMatch(/recovery\.current \?\? Promise\.resolve\(0\)\)[\s\S]{0,80}show\(true\)/);
    expect(page).toMatch(/\(\) => \(\) => \{\s*if \(holdKey\.current\) abandonSeal\(holdKey\.current\);/);
    expect(page).not.toContain('ALREADY_SEALED_MESSAGE });'); // never "Already sealed" straight from the saved payment
  });
  test('signer_race offers the latest version, never the same button', () => {
    expect(page).toContain("e.code === 'newer_version'");
    expect(page).toContain('Open the latest version');
    expect(page).toContain('setReload((n) => n + 1)');
  });
});

describe('bit-sign seal cancel: only when createAction proves nothing went out', () => {
  const failingPay = (log: string[], errs: unknown[]): SealKeys => ({
    createSignature: async () => ({ signature: [1, 2, 3] }),
    createAction: async () => {
      log.push('pay');
      const e = errs.shift();
      if (e) throw e;
      return { txid: TX, tx: [9, 9] };
    },
  });

  test('a definite refusal cancels the nonce, then a clean retry seals once', async () => {
    const log: string[] = [];
    const store = memStore();
    const ledger = memLedger();
    const keys = failingPay(log, [new Error('Not enough spendable BSV for this payment.')]);
    const e = await seal({ log, documentId: 'C1', store, ledger, keys }).catch((x) => x);
    expect(e.code).toBe('not_paid');
    expect(retryAllowed(e, true)).toBe(true); // the button comes back
    expect(log.filter((l) => l === 'cancel')).toHaveLength(1);
    expect(log.indexOf('cancel')).toBeGreaterThan(log.indexOf('pay'));
    expect(store.m.size).toBe(0);
    expect(sealStateHere(SEAL_KEY, 'C1', ['f1'], store, ledger)).toBe('none');
    const out = await seal({ log, documentId: 'C1', store, ledger, keys }); // the retry
    expect(out.txid).toBe(TX);
    expect(log.filter((l) => l === 'pay')).toHaveLength(2);
    expect(log.filter((l) => l === 'cancel')).toHaveLength(1);
  });

  test('a user decline and a pre-payment failure cancel too (nothing was ever paid)', async () => {
    const log: string[] = [];
    await seal({ log, documentId: 'C2', approve: async () => false }).catch((x) => x);
    expect(log).toEqual(['prepare', 'cancel']);
    const log2: string[] = [];
    await seal({
      log: log2,
      documentId: 'C3',
      keys: { createSignature: () => Promise.reject(new Error('locked')), createAction: async () => ({}) },
    }).catch((x) => x);
    expect(log2).toEqual(['prepare', 'compose', 'cancel']);
  });

  for (const [name, err] of [
    ['a network error during the broadcast', new Error('Failed to fetch')],
    ['a timeout', new Error('The request timed out')],
    ['a broadcast that needs review', new Error('Undelayed createAction or signAction results require review.')],
    [
      'an answer carrying a txid',
      Object.assign(new Error('Payment refused: Nothing was sent.'), { txid: 'cd'.repeat(32) }),
    ],
    ['an unknown error', new Error('something odd')],
  ] as const)
    test(`${name}: no cancel, the record is kept, "may have been paid", no retry`, async () => {
      const log: string[] = [];
      const store = memStore();
      const docId = `U-${name}`;
      const e = await seal({ log, documentId: docId, store, keys: failingPay(log, [err]) }).catch((x) => x);
      expect(e.code).toBe('pending_recovery');
      expect(e.message).toBe(MAY_HAVE_PAID_MESSAGE);
      expect(retryAllowed(e, true)).toBe(false);
      expect(log).not.toContain('cancel');
      expect(log).not.toContain('commit');
      expect(store.list()).toMatchObject([{ documentId: docId, nonce: 'N1', beefHex: '' }]);
      expect(sealStateHere(SEAL_KEY, docId, ['f1'], store)).toBe('unsure');
      expect((await seal({ documentId: docId, store }).catch((x) => x)).code).toBe('already_sealed');
    });

  const unsure = (over: Partial<PendingSeal> = {}): PendingSeal => ({
    documentId: 'U9',
    nonce: 'N9',
    txid: '',
    beefHex: '',
    attestation: 'aa',
    savedAt: 1_000,
    identityKey: SEAL_KEY,
    fieldIds: ['f1'],
    lockingScriptHex: '006a',
    ...over,
  });
  const T2 = 'ef'.repeat(32);

  test("an unsure record is found in the wallet's own storage, saved with its BEEF and recorded by /recover", async () => {
    const store = memStore();
    store.save(unsure());
    const ledger = memLedger();
    const bodies: Record<string, unknown>[] = [];
    const found: string[] = [];
    const n = await recoverNativeSeals(
      async (path, body) => (path === 'recover' && bodies.push(body), api([])(path, body)),
      store,
      'U9',
      ledger,
      { find: async (script) => (found.push(script), { found: true, txid: T2 }), beef: async () => [9, 9] },
    );
    expect(found).toEqual(['006a']);
    expect(bodies).toEqual([{ nonce: 'N9', attestation: 'aa', txid: T2, beefHex: '0909' }]);
    expect(n).toBe(1);
    expect(store.m.size).toBe(0);
    expect(ledger.s.has(sealKey(SEAL_KEY, 'U9', ['f1']))).toBe(true);
  });

  test('none was ever built → nothing was paid: released and the nonce cancelled', async () => {
    const store = memStore();
    store.save(unsure());
    const log: string[] = [];
    await recoverNativeSeals(api(log), store, 'U9', null, {
      find: async () => ({ found: false }),
      beef: async () => null,
    });
    expect(store.m.size).toBe(0);
    expect(log).toEqual(['cancel']);
  });

  test('unknown → never dropped: no lookup, a failed lookup, or no BEEF yet (the txid learnt is kept)', async () => {
    const store = memStore();
    store.save(unsure());
    const log: string[] = [];
    await recoverNativeSeals(api(log), store, 'U9');
    await recoverNativeSeals(api(log), store, 'U9', null, { find: async () => null, beef: async () => [1] });
    await recoverNativeSeals(api(log), store, 'U9', null, {
      find: () => Promise.reject(new Error('db closed')),
      beef: async () => [1],
    });
    expect(store.list()).toMatchObject([{ nonce: 'N9', beefHex: '', txid: '' }]);
    await recoverNativeSeals(api(log), store, 'U9', null, {
      find: async () => ({ found: true, txid: T2 }),
      beef: async () => null,
    });
    expect(store.list()).toMatchObject([{ nonce: 'N9', beefHex: '', txid: T2 }]);
    expect(log).toEqual([]); // never /recover without the BEEF, never a cancel
    expect(openingNotice(sealStateHere(SEAL_KEY, 'U9', ['f1'], store), true)?.text).toBe(MAY_HAVE_PAID_MESSAGE);
  });

  test('a storage error (QuotaExceeded) during createAction may come after the broadcast: no cancel, held', async () => {
    for (const msg of ['QuotaExceededError: The quota has been exceeded.', 'WERR_STORAGE_REMOTE_FAILING']) {
      const log: string[] = [];
      const store = memStore();
      const keys: SealKeys = {
        createSignature: async () => ({ signature: [1] }),
        createAction: async () => (log.push('pay'), Promise.reject(new Error(msg))),
      };
      const e = await seal({ log, documentId: `Q-${msg}`, store, keys }).catch((x) => x);
      expect(e.code).toBe('pending_recovery');
      expect(e.message).toBe(MAY_HAVE_PAID_MESSAGE);
      expect(log).not.toContain('cancel');
      expect(store.list()).toMatchObject([{ beefHex: '', lockingScriptHex: SEAL_SCRIPT }]);
    }
  });

  test('a txid with no transaction: held with that txid, "may have been paid", then recovered by its BEEF', async () => {
    const log: string[] = [];
    const store = memStore();
    const keys: SealKeys = {
      createSignature: async () => ({ signature: [1] }),
      createAction: async () => (log.push('pay'), { txid: T2.toUpperCase() }),
    };
    const e = await seal({ log, documentId: 'T1', store, keys }).catch((x) => x);
    expect(e.code).toBe('pending_recovery');
    expect(e.message).toBe(MAY_HAVE_PAID_MESSAGE);
    expect(retryAllowed(e, true)).toBe(false);
    expect(log).not.toContain('cancel');
    expect(log).not.toContain('commit');
    expect(store.list()).toMatchObject([{ documentId: 'T1', txid: T2, beefHex: '' }]);
    expect(sealStateHere(SEAL_KEY, 'T1', ['f1'], store)).toBe('unsure');
    let found = 0;
    const n = await recoverNativeSeals(api([]), store, 'T1', null, {
      find: async () => (found++, { found: false }),
      beef: async (t) => (t === T2 ? [7] : null),
    });
    expect(found).toBe(0); // the txid is known: no search, never "none was built"
    expect(n).toBe(1);
    expect(store.m.size).toBe(0);
  });

  test('a cancel that fails (404, 409, 503, a network error, or never answers) is ignored', async () => {
    const answers: (() => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>)[] = [
      async () => ({ ok: false, status: 404, body: { code: 'not_yours' } }),
      async () => ({ ok: false, status: 409, body: { code: 'commit_in_progress' } }),
      async () => ({ ok: false, status: 503, body: { code: 'seal_v2_unavailable' } }),
      () => Promise.reject(new Error('Failed to fetch')),
    ];
    for (const [i, answer] of answers.entries()) {
      const log: string[] = [];
      const base = api(log);
      const e = await seal({
        log,
        documentId: `X${i}`,
        api: (path, body) => (path === 'cancel' ? (log.push('cancel'), answer()) : base(path, body)),
        keys: failingPay(log, [new Error('Not enough spendable BSV for this payment.')]),
      }).catch((x) => x);
      expect(e.code).toBe('not_paid');
      expect(log.filter((l) => l === 'cancel')).toHaveLength(1); // once: no retry loop
    }
    // Never answers: the seal goes on after CANCEL_TIMEOUT_MS on the wall clock.
    const f = frozenClock();
    const log: string[] = [];
    const base = api(log);
    let out: unknown = null;
    void seal({
      log,
      documentId: 'X-hang',
      clock: f.clock,
      api: (path, body) => (path === 'cancel' ? (log.push('cancel'), new Promise(() => undefined)) : base(path, body)),
      keys: failingPay(log, [new Error('Not enough spendable BSV for this payment.')]),
    }).catch((x) => (out = x));
    await until(() => log.includes('cancel'));
    await flush();
    expect(out).toBeNull();
    f.advance(3_000);
    f.wake();
    await until(() => out !== null);
    expect((out as NativeSealError).code).toBe('not_paid');
  });
});

describe("findSealAction: the unsure seal in the wallet's own storage, failed ones and old ones too", () => {
  const FAILED = 'failed-spec-op-label';
  type Row = { txid: string; status: string; at: number; script: string };
  /** The toolbox's listActions on IndexedDB, as far as this needs it (listActionsIdb): status filter, BRC-114 from, paging. */
  const wallet = (rows: Row[], o: { rejectTime?: boolean; failFailed?: boolean } = {}) => {
    const calls: string[][] = [];
    const list: ListActionsFn = async (args) => {
      calls.push(args.labels);
      const fromLabel = args.labels.find((l) => l.startsWith('action time from '));
      if (fromLabel && o.rejectTime) throw new Error('WERR_INVALID_PARAMETER: labels');
      const failed = args.labels.includes(FAILED);
      if (failed && o.failFailed) throw new Error('db closed');
      const from = fromLabel ? Number(fromLabel.slice('action time from '.length)) : 0;
      const ordinary = ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal'];
      const hits = rows
        .filter((r) => (failed ? r.status === 'failed' : ordinary.includes(r.status)) && r.at >= from)
        .sort((a, b) => a.at - b.at);
      return {
        totalActions: hits.length,
        actions: hits
          .slice(args.offset, args.offset + args.limit)
          .map((r) => ({ txid: r.txid, outputs: [{ lockingScript: r.script }] })),
      };
    };
    return { list, calls };
  };
  const SEAL = '006a7b22';
  const T = (i: number) => i.toString(16).padStart(64, '0');
  const others = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => ({ txid: T(i + 1000), status: 'completed', at: from + i, script: '76a9' }));

  test('a seal the toolbox marked failed is found (so it is NOT released): ARC can still mine it', async () => {
    const w = wallet([...others(5, 10_000), { txid: T(1), status: 'failed', at: 10_500, script: SEAL }]);
    expect(await findSealAction(w.list, SEAL, 10_400, FAILED)).toEqual({ found: true, txid: T(1) });
    expect(w.calls.some((l) => l.includes(FAILED))).toBe(true);
    expect(w.calls.flat()).not.toContain('unfail'); // read only: never rewrites a status

    // Through recovery: the record is held (no BEEF yet), never released or cancelled.
    const store = memStore();
    store.save({
      documentId: 'F1',
      nonce: 'NF',
      txid: '',
      beefHex: '',
      attestation: 'aa',
      savedAt: 10_400,
      identityKey: SEAL_KEY,
      fieldIds: ['f1'],
      lockingScriptHex: SEAL,
    });
    const log: string[] = [];
    await recoverNativeSeals(api(log), store, 'F1', null, {
      find: (script, since) => findSealAction(w.list, script, since, FAILED),
      beef: async () => null,
    });
    expect(store.list()).toMatchObject([{ nonce: 'NF', txid: T(1), beefHex: '' }]);
    expect(log).not.toContain('cancel');
  });

  test('a seal older than 200 actions is still found: searched from its own time, paged to the end', async () => {
    const rows = [
      ...others(20, 1_000), // before the record: outside the time filter
      ...others(260, 100_000),
      { txid: T(2), status: 'unproven', at: 100_400, script: SEAL },
      ...others(300, 110_000), // 300 newer actions on top
    ];
    const w = wallet(rows);
    expect(await findSealAction(w.list, SEAL, 100_100, FAILED)).toEqual({ found: true, txid: T(2) });
    expect(w.calls.every((l) => l[0] === 'action time from 40100')).toBe(true); // savedAt − 60 s
    expect(w.calls.length).toBeGreaterThan(2); // more than one page
  });

  test('"none was built" only when BOTH lists answered to the end with no match', async () => {
    const w = wallet([...others(250, 1_000)]);
    expect(await findSealAction(w.list, SEAL, 1_000, FAILED)).toEqual({ found: false });
    expect(w.calls.filter((l) => l.includes(FAILED)).length).toBeGreaterThan(0);
    const half = wallet([...others(3, 1_000)], { failFailed: true });
    expect(await findSealAction(half.list, SEAL, 1_000, FAILED)).toBeNull();
  });

  test('storage rejects the time filter → null, and the seal stays held', async () => {
    const w = wallet([{ txid: T(3), status: 'completed', at: 5_000, script: SEAL }], { rejectTime: true });
    expect(await findSealAction(w.list, SEAL, 5_000, FAILED)).toBeNull();
    const store = memStore();
    store.save({
      documentId: 'R1',
      nonce: 'NR',
      txid: '',
      beefHex: '',
      attestation: 'aa',
      savedAt: 5_000,
      identityKey: SEAL_KEY,
      fieldIds: ['f1'],
      lockingScriptHex: SEAL,
    });
    const log: string[] = [];
    await recoverNativeSeals(api(log), store, 'R1', null, {
      find: (script, since) => findSealAction(w.list, script, since, FAILED),
      beef: async () => [1],
    });
    expect(store.list()).toMatchObject([{ nonce: 'NR', beefHex: '' }]);
    expect(log).toEqual([]);
  });

  test("the page searches with the toolbox's own failed-actions label, from the record's time", () => {
    const page = readFileSync(new URL('./NativeSealPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('toolboxSdk.specOpFailedActions');
    expect(page).toMatch(/find: \(script, sinceMs\) =>\s*findSealAction\(/);
    expect(page).not.toContain('97d4eb1e49215e3374cc2c1939a7c43a55e95c7427bf2d45ed63e3b4e0c88153');
    expect(page).not.toContain("'unfail'");
  });
});
