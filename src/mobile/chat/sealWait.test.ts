import { describe, expect, test } from 'bun:test';
import {
  ALREADY_SEALED_MESSAGE,
  NativeSealError,
  nativeSignAndSeal,
  recoverNativeSeals,
  sealedHere,
  type PendingSeal,
  type SealApi,
  type SealKeys,
  type SealLedger,
} from './nativeSeal';
import { COIN_WAIT_CAP_MS, COIN_WAIT_SLOW_MS, type WakeClock } from './coinWait';
import { COIN_SLOW_LINE, FRESH_COIN_LINE, retryAllowed, sealProgress } from './sealScreen';

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
    // An hour in the background: no tick ever ran. The wall clock moved.
    f.advance(60 * 60_000);
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
    await until(() => f.listeners() > 0);
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
      t += 10 * 60_000;
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
    await until(() => f.listeners() > 0);
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
    await until(() => f.listeners() > 0);
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
    expect(ledger.s.has('D')).toBe(true);
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
    expect(sealedHere('D', store, memLedger())).toBe(true);
    expect(sealedHere('OTHER', store, memLedger())).toBe(false);
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
    expect(sealedHere('D-flight', memStore(), memLedger())).toBe(false);
  });

  test('the server says another seal landed since prepare (signer_race) → "Already sealed", no button back', async () => {
    const log: string[] = [];
    const e = await seal({
      log,
      api: api(log, {
        compose: () => ({ ok: false, status: 409, body: { error: 'Another party sealed…', code: 'signer_race' } }),
      }),
    }).catch((x) => x);
    expect(e.code).toBe('already_sealed');
    expect(e.message).toBe(ALREADY_SEALED_MESSAGE);
    expect(log).not.toContain('pay');
    expect(retryAllowed(e, false)).toBe(false);
  });

  test('an orphaned result (another party sealed first) is recorded as sealed here too', async () => {
    const ledger = memLedger();
    const log: string[] = [];
    await seal({
      log,
      ledger,
      api: api(log, { commit: () => ({ ok: true, status: 200, body: { orphaned: true, success: false } }) }),
    }).catch((x) => x);
    expect(ledger.s.has('D')).toBe(true);
  });

  test('a seal finished by recovery on reopen is recorded as sealed', async () => {
    const store = memStore();
    store.save({ documentId: 'D', nonce: 'N0', txid: TX, beefHex: '99', attestation: 'aa', savedAt: 1 });
    const ledger = memLedger();
    const n = await recoverNativeSeals(api([]), store, 'D', ledger);
    expect(n).toBe(1);
    expect(ledger.s.has('D')).toBe(true);
    expect(sealedHere('D', store, ledger)).toBe(true);
  });
});
