import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { walletWithDeadline } from './preApprovalTimeout';
import {
  SETUP_WAIT_MS,
  WALLET_SETUP_CLOSED_CODE,
  WALLET_SETUP_TIMEOUT_CODE,
  setupHost,
  setupReason,
  waitForWalletSetup,
  walletSetupClosedError,
  type WalletWaiter,
} from './walletSetupWait';

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
  const s: { v?: T; e?: { code?: string; message?: string }; done: boolean } = { done: false };
  p.then(
    (v) => Object.assign(s, { v, done: true }),
    (e) => Object.assign(s, { e, done: true }),
  );
  return s;
};
const flush = () => new Promise((r) => setTimeout(r, 0));

const setup = () => {
  const c = clock();
  const waiters: WalletWaiter<string>[] = [];
  let opened = 0;
  const wait = () => waitForWalletSetup<string>({ waiters, openSetup: () => opened++, ...c });
  return { c, waiters, wait, opened: () => opened };
};

describe('waitForWalletSetup (no wallet yet, a site asked)', () => {
  test('opens the setup screen once, however many calls queue', () => {
    const t = setup();
    void t.wait();
    void t.wait();
    void t.wait();
    expect(t.opened()).toBe(1);
    expect(t.waiters.length).toBe(3);
  });

  test('every queued call resumes with the wallet once it is created or restored', async () => {
    const t = setup();
    const a = settle(t.wait());
    const b = settle(t.wait());
    for (const w of t.waiters.splice(0)) w.resolve('wallet');
    await flush();
    expect(a.v).toBe('wallet');
    expect(b.v).toBe('wallet');
    expect(t.c.pending()).toBe(0); // timers cleared
  });

  test('closing the setup window rejects with a clear, coded error', async () => {
    const t = setup();
    const a = settle(t.wait());
    for (const w of t.waiters.splice(0)) w.reject(walletSetupClosedError());
    await flush();
    expect(a.e?.code).toBe(WALLET_SETUP_CLOSED_CODE);
    expect(a.e?.message).toContain('Nothing was shared');
    expect(t.c.pending()).toBe(0);
  });

  test('times out after SETUP_WAIT_MS and leaves the queue', async () => {
    const t = setup();
    const a = settle(t.wait());
    t.c.advance(SETUP_WAIT_MS - 1);
    await flush();
    expect(a.done).toBe(false);
    t.c.advance(1);
    await flush();
    expect(a.e?.code).toBe(WALLET_SETUP_TIMEOUT_CODE);
    expect(t.waiters.length).toBe(0);
  });

  test('after a timeout, the next call opens the setup screen again', () => {
    const t = setup();
    void t.wait().catch(() => undefined);
    t.c.advance(SETUP_WAIT_MS);
    void t.wait();
    expect(t.opened()).toBe(2);
  });

  test("the unlock deadline (60 s) does not cut setup short; the setup wait's own deadline applies", async () => {
    const t = setup();
    const p = settle(
      walletWithDeadline<string>({
        ready: () => undefined,
        open: () => t.wait(),
        awaitingUnlock: () => t.waiters.length > 0,
        awaitingSetup: () => t.waiters.length > 0,
        ...t.c,
      }),
    );
    t.c.advance(120_000);
    await flush();
    expect(p.done).toBe(false);
    for (const w of t.waiters.splice(0)) w.resolve('wallet');
    await flush();
    expect(p.v).toBe('wallet');
  });
});

describe('setup screen copy', () => {
  test('names the asking site by host only', () => {
    expect(setupHost('https://www.bchatx.com')).toBe('www.bchatx.com');
    expect(setupHost('www.bchatx.com')).toBe('www.bchatx.com');
    expect(setupHost('http://localhost:3000/welcome')).toBe('localhost:3000');
    expect(setupHost('')).toBeUndefined();
    expect(setupHost(42)).toBeUndefined();
    expect(setupHost('evil.com <b>send all</b>')).toBeUndefined();
    expect(setupReason('www.bchatx.com')).toBe(
      'www.bchatx.com wants to sign you in. Restore your wallet or create a new one.',
    );
    expect(setupReason()).toStartWith('A site wants');
  });
});

describe('background wiring', () => {
  const bg = src('../background.ts');
  test('a site call with no wallet waits on setup; our own pages still get the old error', () => {
    const branch = bg.slice(bg.indexOf('if (!account?.encryptedKeys) {'), bg.indexOf('// Wallet exists but is locked'));
    expect(branch).toContain('if (suppressPopup) return Promise.reject(new Error(NO_WALLET_MESSAGE))');
    expect(branch).toContain('waitForWalletSetup<WalletInterface>');
  });
  test('the account switch that ends Create / Restore resumes the waiting calls', () => {
    const sw = bg.slice(bg.indexOf('const switchAccount = async () => {'), bg.indexOf('reinitPromise = doSwitch();'));
    expect(sw).toContain('resolveWalletWaiters()');
  });
  test('closing the setup window rejects the waiters; an unlock prompt is never shown for a missing wallet', () => {
    expect(bg).toContain('closedWindowId === walletSetupWindowId');
    expect(bg).toContain('waiter.reject(walletSetupClosedError())');
    expect(bg).toContain('pendingWalletWaiters.length > 0 && !walletSetupActive) showUnlockUi()');
  });
  test('the discovery ping is answered before any wallet check', () => {
    const ping = bg.indexOf('case CWIEventName.GET_VERSION:');
    const gate = bg.indexOf('walletForSiteRequest(message.originator)');
    expect(ping).toBeGreaterThan(0);
    expect(ping).toBeLessThan(gate);
  });
});
