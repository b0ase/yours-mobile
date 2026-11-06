import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ALREADY_SEALED_MESSAGE,
  BUSY_ELSEWHERE_MESSAGE,
  LEFT_PAGE_MESSAGE,
  NEWER_VERSION_MESSAGE,
  NativeSealError,
  SEAL_HOLD_MAX_MS,
  abandonSeal,
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
const KEY_D = sealKey('', 'D', ['f1']);
const stateD = (store: Parameters<typeof sealStateHere>[3], ledger?: Parameters<typeof sealStateHere>[4]) =>
  sealStateHere('', 'D', ['f1'], store, ledger);

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
const api =
  (
    log: string[],
    over: Partial<Record<string, () => { ok: boolean; status: number; body: Record<string, unknown> }>> = {},
  ): SealApi =>
  async (path) => {
    log.push(path);
    const o = over[path];
    if (o) return o();
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
    fieldIds: ['f1'],
    svg: '<svg/>',
    api: api(log),
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
    expect(sealStateHere('', 'OTHER', ['f1'], store, memLedger())).toBe('none');
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
    expect(sealStateHere('', 'D-flight', ['f1'], memStore(), memLedger())).toBe('none');
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
      identityKey: '',
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
      api: api([], {
        commit: () => ({ ok: false, status: 503, body: {} }),
        recover: () => ({ ok: false, status: 503, body: {} }),
      }),
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
      identityKey: '',
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
    const key = sealKey('', 'H1', ['f1']);
    expect(sealStateHere('', 'H1', ['f1'], memStore())).toBe('in_flight');
    expect(abandonSeal(key)).toBe(true); // the page unmounted
    expect(sealStateHere('', 'H1', ['f1'], memStore())).toBe('none');
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
    expect(abandonSeal(sealKey('', 'H2', ['f1']))).toBe(false);
    expect((await seal({ documentId: 'H2' }).catch((x) => x)).code).toBe('already_sealed');
    paid();
    await first;
    expect(sealStateHere('', 'H2', ['f1'], memStore())).toBe('none'); // released on settle
  });

  test('a seal that hangs forever lets go after SEAL_HOLD_MAX_MS on the wall clock (frozen timers, a wake)', async () => {
    const f = frozenClock();
    const log: string[] = [];
    const hung: SealKeys = {
      createSignature: async () => ({ signature: [1] }),
      createAction: () => new Promise(() => undefined),
    };
    void seal({ log, documentId: 'H3', keys: hung, clock: f.clock, steps: log });
    await until(() => log.includes('paying'));
    expect(sealStateHere('', 'H3', ['f1'], memStore())).toBe('in_flight');
    f.advance(SEAL_HOLD_MAX_MS - 1);
    f.wake();
    await flush();
    expect(sealStateHere('', 'H3', ['f1'], memStore())).toBe('in_flight');
    f.advance(1);
    f.wake();
    await flush();
    expect(sealStateHere('', 'H3', ['f1'], memStore())).toBe('none');
  });

  test('released on an error too', async () => {
    const e = await seal({
      documentId: 'H4',
      api: api([], { compose: () => ({ ok: false, status: 500, body: { error: 'boom' } }) }),
    }).catch((x) => x);
    expect(e.code).toBe('refused');
    expect(sealStateHere('', 'H4', ['f1'], memStore())).toBe('none');
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
