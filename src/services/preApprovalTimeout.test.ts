import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  FUNDING_TIMEOUT_CODE,
  FUNDING_TIMEOUT_MESSAGE,
  SingleFlight,
  WALLET_LOCKED_TIMEOUT_CODE,
  WALLET_NOT_READY_CODE,
  fundingTimeoutError,
  walletWithDeadline,
  withStepTimeout,
} from './preApprovalTimeout';
import { withPromptNotShownCode } from './promptWatchdog';

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const clock = () => {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
};

const settle = <T>(p: Promise<T>) => {
  const s: { v?: T; e?: unknown; done: boolean } = { done: false };
  p.then(
    (v) => Object.assign(s, { v, done: true }),
    (e) => Object.assign(s, { e, done: true }),
  );
  return s;
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { p, resolve, reject };
};

describe('withStepTimeout', () => {
  test('passes a fast result through and clears its timer', async () => {
    const c = clock();
    const s = settle(withStepTimeout(Promise.resolve(7), 5000, fundingTimeoutError, c));
    await flush();
    expect(s.v).toBe(7);
    expect(c.pending()).toBe(0);
  });

  test('a stuck step rejects with the coded error at the deadline', async () => {
    const c = clock();
    const d = deferred<number>();
    const s = settle(withStepTimeout(d.p, 5000, fundingTimeoutError, c));
    c.advance(4999);
    await flush();
    expect(s.done).toBe(false);
    c.advance(1);
    await flush();
    expect((s.e as { code: string }).code).toBe(FUNDING_TIMEOUT_CODE);
    expect((s.e as { status: number }).status).toBe(504);
    // A late result is ignored, never unhandled.
    d.resolve(1);
    await flush();
  });
});

describe('walletWithDeadline', () => {
  test('an open wallet returns at once without calling open', async () => {
    let opened = 0;
    const s = settle(
      walletWithDeadline({
        ready: () => 'w',
        open: () => (opened++, Promise.resolve('x')),
        awaitingUnlock: () => false,
      }),
    );
    await flush();
    expect(s.v).toBe('w');
    expect(opened).toBe(0);
  });

  test('a wallet still settling after 8 s: ERR_WALLET_NOT_READY (not at 5 s)', async () => {
    const c = clock();
    const s = settle(
      walletWithDeadline({
        ...c,
        ready: () => undefined,
        open: () => deferred<string>().p,
        awaitingUnlock: () => false,
      }),
    );
    c.advance(5000);
    await flush();
    expect(s.e).toBeUndefined();
    c.advance(2999);
    await flush();
    expect(s.e).toBeUndefined();
    c.advance(1);
    await flush();
    expect((s.e as { code: string }).code).toBe(WALLET_NOT_READY_CODE);
  });

  test('a cold-waking worker is not charged for its wake: the 8 s starts after the warm-up answers', async () => {
    const c = clock();
    const warm = deferred<void>();
    const s = settle(
      walletWithDeadline({
        ...c,
        ready: () => undefined,
        open: () => deferred<string>().p,
        awaitingUnlock: () => false,
        warmUp: () => warm.p,
      }),
    );
    c.advance(10_000); // still waking: no error yet
    await flush();
    expect(s.e).toBeUndefined();
    warm.resolve();
    await flush();
    c.advance(7999);
    await flush();
    expect(s.e).toBeUndefined();
    c.advance(1);
    await flush();
    expect((s.e as { code: string }).code).toBe(WALLET_NOT_READY_CODE);
  });

  test('wallet opens during or right after warm-up: resolves, no error', async () => {
    const c = clock();
    const warm = deferred<void>();
    const w = deferred<string>();
    const s = settle(
      walletWithDeadline({
        ...c,
        ready: () => undefined,
        open: () => w.p,
        awaitingUnlock: () => false,
        warmUp: () => warm.p,
      }),
    );
    c.advance(12_000);
    warm.resolve();
    await flush();
    c.advance(3000);
    w.resolve('w');
    await flush();
    expect(s.v).toBe('w');
    expect(c.pending()).toBe(0);
  });

  test('a warm-up that never answers is still capped: ERR_WALLET_NOT_READY', async () => {
    const c = clock();
    const s = settle(
      walletWithDeadline({
        ...c,
        ready: () => undefined,
        open: () => deferred<string>().p,
        awaitingUnlock: () => false,
        warmUp: () => deferred<void>().p,
        warmUpCapMs: 30_000,
      }),
    );
    c.advance(29_999);
    await flush();
    expect(s.e).toBeUndefined();
    c.advance(1);
    await flush();
    expect((s.e as { code: string }).code).toBe(WALLET_NOT_READY_CODE);
  });

  test('locked: the unlock UI is shown at once and the person gets 60 s in all', async () => {
    const c = clock();
    let unlockShown = false;
    const d = deferred<string>();
    const s = settle(
      walletWithDeadline({
        ...c,
        ready: () => undefined,
        open: () => ((unlockShown = true), d.p),
        awaitingUnlock: () => true,
      }),
    );
    expect(unlockShown).toBe(true);
    c.advance(30_000);
    await flush();
    expect(s.done).toBe(false);
    c.advance(30_000);
    await flush();
    expect((s.e as { code: string }).code).toBe(WALLET_LOCKED_TIMEOUT_CODE);
  });

  test('locked then unlocked in time: resolves with the wallet', async () => {
    const c = clock();
    const d = deferred<string>();
    const s = settle(walletWithDeadline({ ...c, ready: () => undefined, open: () => d.p, awaitingUnlock: () => true }));
    c.advance(20_000);
    d.resolve('w');
    await flush();
    expect(s.v).toBe('w');
    expect(c.pending()).toBe(0);
  });

  test('ensureWallet errors (no wallet) pass through unchanged', async () => {
    const s = settle(
      walletWithDeadline({
        ready: () => undefined,
        open: () => Promise.reject(new Error('No wallet exists - create wallet first')),
        awaitingUnlock: () => false,
      }),
    );
    await flush();
    expect((s.e as Error).message).toContain('No wallet exists');
  });
});

describe('SingleFlight', () => {
  test('a retry joins the run going for the same account; another account starts its own', async () => {
    const f = new SingleFlight<number>();
    let runs = 0;
    const d = deferred<number>();
    const a = f.run('acct1', () => (runs++, d.p));
    const b = f.run('acct1', () => (runs++, Promise.resolve(2)));
    expect(a).toBe(b);
    await flush();
    expect(runs).toBe(1);
    void f.run('acct2', () => (runs++, Promise.resolve(3)));
    await flush();
    expect(runs).toBe(2);
    d.resolve(1);
    await a;
    await flush();
    void f.run('acct1', () => (runs++, Promise.resolve(4)));
    await flush();
    expect(runs).toBe(3);
  });
});

test('a site reply with a pre-approval timeout carries {code, status}', () => {
  const r = withPromptNotShownCode({ success: false, error: FUNDING_TIMEOUT_MESSAGE });
  expect(r).toMatchObject({ code: FUNDING_TIMEOUT_CODE, status: 504 });
});

describe('background wiring', () => {
  const bg = src('../background.ts');
  test('site requests use the deadline wallet; our own pages do not', () => {
    expect(bg).toContain('(isFromExtension ? ensureWallet(true) : walletForSiteRequest(message.originator))');
  });
  test('funding preparation is capped, before signing', () => {
    const i = bg.indexOf('withStepTimeout(prep, STEP_TIMEOUT_MS, fundingTimeoutError)');
    const sign = bg.indexOf('return await signer.createAction(args, message.originator)');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(sign);
  });
});
