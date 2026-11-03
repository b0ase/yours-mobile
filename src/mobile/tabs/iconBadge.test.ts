import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  appIconTotal,
  BADGE_MAX,
  clampBadge,
  iconBadgeText,
  resetIconBadge,
  setBadgeReporter,
  setIconBadge,
  type NativeBadge,
} from './iconBadge';
import { reportBadge } from '../push/register';
import { keepGlobals } from '../../testing/stubGlobals';

keepGlobals('localStorage', 'window');

const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};
// register.ts announces state changes on window; a bare EventTarget is enough here.
(globalThis as unknown as { window: EventTarget }).window ??= new EventTarget();

const fakeNative = () => {
  const calls: { count: number; clearDelivered: boolean }[] = [];
  const native: NativeBadge = { set: async (o) => void calls.push(o) };
  return { calls, native };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetIconBadge();
  setBadgeReporter(null);
});
afterEach(() => setBadgeReporter(null));

describe('app icon total', () => {
  test('chat + bMail', () => {
    expect(appIconTotal(3, 2)).toBe(5);
    expect(appIconTotal(0, 0)).toBe(0);
    expect(appIconTotal(0, 4)).toBe(4);
  });
  test('bad parts count as 0; never negative, whole, capped', () => {
    expect(appIconTotal(-5, 2)).toBe(2);
    expect(appIconTotal(NaN, 1)).toBe(1);
    expect(appIconTotal(1.9, 1.9)).toBe(2);
    expect(appIconTotal(BADGE_MAX, 10)).toBe(BADGE_MAX);
  });
  test('clamp', () => {
    expect(clampBadge(-1)).toBe(0);
    expect(clampBadge(Infinity)).toBe(0);
    expect(clampBadge(7.8)).toBe(7);
    expect(clampBadge(BADGE_MAX + 1)).toBe(BADGE_MAX);
  });
  test('extension text', () => {
    expect(iconBadgeText(0)).toBe('');
    expect(iconBadgeText(42)).toBe('42');
    expect(iconBadgeText(100)).toBe('99+');
  });
});

describe('setIconBadge: one call drives the extension toolbar and the native icon', () => {
  test('both get the number; repeats are skipped', async () => {
    const texts: string[] = [];
    const { calls, native } = fakeNative();
    const action = { setBadgeText: ({ text }: { text: string }) => void texts.push(text) };
    setIconBadge(3, action, native);
    setIconBadge(3, action, native);
    setIconBadge(120, action, native);
    await flush();
    expect(texts).toEqual(['3', '99+']);
    expect(calls.map((c) => c.count)).toEqual([3, 120]);
  });
  test('clears at 0; clearDelivered only when it drops from some to none', async () => {
    const { calls, native } = fakeNative();
    setIconBadge(0, undefined, native); // first value, nothing read yet
    setIconBadge(2, undefined, native);
    setIconBadge(0, undefined, native); // everything read
    setIconBadge(0, undefined, native); // repeat: skipped
    await flush();
    expect(calls).toEqual([
      { count: 0, clearDelivered: false },
      { count: 2, clearDelivered: false },
      { count: 0, clearDelivered: true },
    ]);
  });
  test('bad input clears instead of throwing', async () => {
    const { calls, native } = fakeNative();
    setIconBadge(4, undefined, native);
    setIconBadge(NaN, undefined, native);
    await flush();
    expect(calls.at(-1)).toEqual({ count: 0, clearDelivered: true });
  });
  test('a shell without the plugin (UNIMPLEMENTED) is not asked again', async () => {
    let tries = 0;
    const native: NativeBadge = {
      set: () => {
        tries++;
        return Promise.reject(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
      },
    };
    setIconBadge(1, undefined, native);
    await flush();
    setIconBadge(2, undefined, native);
    await flush();
    expect(tries).toBe(1);
  });
  test('other plugin errors are swallowed and retried on the next change', async () => {
    let tries = 0;
    const native: NativeBadge = {
      set: () => {
        tries++;
        return Promise.reject(new Error('busy'));
      },
    };
    setIconBadge(1, undefined, native);
    await flush();
    setIconBadge(2, undefined, native);
    await flush();
    expect(tries).toBe(2);
  });
  test('the reporter (push server) gets every number, clamped', () => {
    const got: number[] = [];
    setBadgeReporter((n) => void got.push(n));
    setIconBadge(5, undefined, undefined);
    setIconBadge(-3, undefined, undefined);
    expect(got).toEqual([5, 0]);
  });
});

describe('reportBadge (push server)', () => {
  const PUSH_KEY = 'bwallet.push';
  const sent: { bearer: string; count: number }[] = [];
  const api = (bearer: string) => ({
    badge: async (count: number) => {
      sent.push({ bearer, count });
      return { ok: true };
    },
  });
  const wait = () => new Promise((r) => setTimeout(r, 5));
  beforeEach(() => {
    sent.length = 0;
    mem.clear();
  });

  test('nothing without a registered device', async () => {
    reportBadge(3, false, { api, delayMs: 0 });
    await wait();
    expect(sent).toEqual([]);
  });
  test('debounced: only the settled number goes; repeats skipped unless forced', async () => {
    mem.set(PUSH_KEY, JSON.stringify({ enabled: true, deviceId: 'd1', handle: 'bob', bearer: 'tok', key: 'k' }));
    reportBadge(0, false, { api, delayMs: 1 });
    reportBadge(4, false, { api, delayMs: 1 });
    await wait();
    expect(sent).toEqual([{ bearer: 'tok', count: 4 }]);
    reportBadge(4, false, { api, delayMs: 0 });
    await wait();
    expect(sent.length).toBe(1);
    reportBadge(4, true, { api, delayMs: 0 });
    await wait();
    expect(sent.length).toBe(2);
  });
});
