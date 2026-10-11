import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ADDRESS_RESYNC_MIN_GAP_MS, pageHidden, shouldResync, singleFlight } from './addressResync';

describe('singleFlight', () => {
  test('one run at a time: callers during a run share it', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = singleFlight(async () => {
      calls++;
      await gate;
      return calls;
    });
    const a = f.run();
    const b = f.run();
    expect(f.busy()).toBe(true);
    expect(a).toBe(b);
    release();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(calls).toBe(1);
    expect(f.busy()).toBe(false);
  });

  test('a new run starts after the last one finished, and records when it finished', async () => {
    let t = 1000;
    let calls = 0;
    const f = singleFlight(
      async () => ++calls,
      () => t,
    );
    await f.run();
    expect(f.lastFinishedAt()).toBe(1000);
    t = 5000;
    await f.run();
    expect(calls).toBe(2);
    expect(f.lastFinishedAt()).toBe(5000);
  });

  test('a failed run frees the slot', async () => {
    let n = 0;
    const f = singleFlight(async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return n;
    });
    await expect(f.run()).rejects.toThrow('boom');
    expect(f.busy()).toBe(false);
    expect(await f.run()).toBe(2);
  });
});

describe('shouldResync', () => {
  const base = { unlocked: true, busy: false, lastFinishedAt: 0, now: 10 * 60_000 };
  test('runs while unlocked and visible', () => expect(shouldResync(base)).toBe(true));
  test('never while locked', () => expect(shouldResync({ ...base, unlocked: false })).toBe(false));
  test('pauses while the page is hidden', () => expect(shouldResync({ ...base, hidden: true })).toBe(false));
  test('runs in a service worker (no page)', () => expect(shouldResync({ ...base, hidden: undefined })).toBe(true));
  test('not while a run is in flight', () => expect(shouldResync({ ...base, busy: true })).toBe(false));
  test('not again within the minimum gap', () => {
    expect(shouldResync({ ...base, lastFinishedAt: base.now - ADDRESS_RESYNC_MIN_GAP_MS + 1 })).toBe(false);
    expect(shouldResync({ ...base, lastFinishedAt: base.now - ADDRESS_RESYNC_MIN_GAP_MS })).toBe(true);
  });
});

describe('pageHidden', () => {
  test('hidden page', () => expect(pageHidden({ visibilityState: 'hidden' })).toBe(true));
  test('visible page', () => expect(pageHidden({ visibilityState: 'visible' })).toBe(false));
  test('no page (service worker)', () => expect(pageHidden(undefined)).toBeUndefined());
});

describe('wiring', () => {
  const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
  const init = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../pages/BsvWallet.tsx', import.meta.url), 'utf8');
  test('background schedules the resync alarm and only runs it with an account context', () => {
    expect(bg).toContain('chrome.alarms.create(ADDRESS_RESYNC_ALARM');
    expect(bg).toMatch(/const ctx = accountContext;\s*if \(\s*!ctx \|\|/);
    expect(bg).toContain('ctx.resyncAddresses({ quiet: true })');
  });
  test('startup sync goes through the shared single run', () => {
    expect(init).toContain('singleFlight(');
    expect(init).toContain('void resyncAddresses();');
  });
  test('refresh button asks the wallet to run the shared sync first', () => {
    expect(page).toContain("action: 'RESYNC_ADDRESSES'");
  });
});
