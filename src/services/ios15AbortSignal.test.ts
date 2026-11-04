/**
 * Final check of 7fdfe423, blocker B1: iOS 15 (the app's target) has no AbortSignal.timeout / AbortSignal.any. With the
 * 8 s lookup deadline built on AbortSignal.timeout, every chain lookup threw inside its try and read "unclear", so no
 * release path (unsentExpiry, stuckSends, releaseAfterHandoff, nullTxidRepair, the Store's orphan release, a refusal)
 * could ever free a coin on those phones. These tests run with both removed, as on iOS 15.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  chainLookups,
  chainMayHave,
  chainSaysUnknown,
  defaultLookups,
  releaseLookups,
  wocLookup,
  arcLookup,
} from './unsentGuard';
import { deadline, installAbortSignalPolyfill, timeoutSignal } from '../utils/abortTimeout';

const T = 'ab'.repeat(32);
const notFound = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;

type A = { timeout?: unknown; any?: unknown };
let saved: { timeout: unknown; any: unknown };
const asIos15 = () => {
  const a = AbortSignal as unknown as A;
  delete a.timeout;
  delete a.any;
  a.timeout = undefined;
  a.any = undefined;
};

beforeEach(() => {
  const a = AbortSignal as unknown as A;
  saved = { timeout: a.timeout, any: a.any };
  asIos15();
});
afterEach(() => {
  const a = AbortSignal as unknown as A;
  a.timeout = saved.timeout;
  a.any = saved.any;
});

describe('iOS 15: no AbortSignal.timeout / AbortSignal.any', () => {
  test('a clean 404 still counts as missing; the release checks can say "not there"', async () => {
    expect(typeof (AbortSignal as unknown as A).timeout).not.toBe('function');
    expect(await wocLookup(notFound)(T)).toBe('missing');
    expect(await arcLookup(notFound)(T)).toBe('missing');
    expect(await chainMayHave(T, chainLookups(notFound))).toBe(false);
    expect(await chainSaysUnknown(T, { lookups: releaseLookups(notFound), delaysMs: [0] })).toBe(true);
    expect(await chainSaysUnknown(T, { lookups: defaultLookups(notFound), delaysMs: [0] })).toBe(true);
  });

  test('each lookup still carries a deadline signal, and clears its timer once answered', async () => {
    const signals: unknown[] = [];
    const f = (async (_u: string, init?: RequestInit) => (
      signals.push(init?.signal),
      new Response('{}', { status: 404 })
    )) as unknown as typeof fetch;
    const realClear = globalThis.clearTimeout;
    let cleared = 0;
    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => (
      cleared++,
      realClear(id)
    )) as typeof clearTimeout;
    try {
      await wocLookup(f)(T);
      await arcLookup(f)(T);
    } finally {
      globalThis.clearTimeout = realClear;
    }
    expect(signals.length).toBe(2);
    for (const s of signals) expect(s).toBeInstanceOf(AbortSignal);
    expect(cleared).toBeGreaterThanOrEqual(2);
  });

  test('deadline / timeoutSignal abort on time without the native API', async () => {
    const d = deadline(5);
    await new Promise((r) => setTimeout(r, 20));
    expect(d.signal.aborted).toBe(true);
    expect((d.signal.reason as Error).name).toBe('TimeoutError');
    const s = timeoutSignal(5);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.aborted).toBe(true);
    const kept = deadline(5);
    kept.clear();
    await new Promise((r) => setTimeout(r, 20));
    expect(kept.signal.aborted).toBe(false);
  });

  test('the polyfill adds AbortSignal.timeout and AbortSignal.any (for the toolbox and every other caller)', async () => {
    expect(installAbortSignalPolyfill()).toEqual({ timeout: true, any: true });
    const a = AbortSignal as unknown as {
      timeout: (ms: number) => AbortSignal;
      any: (s: AbortSignal[]) => AbortSignal;
    };
    const t = a.timeout(5);
    const c = new AbortController();
    const both = a.any([c.signal, t]);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.aborted).toBe(true);
    expect(both.aborted).toBe(true);
    // Installed once: a platform that has them is left alone.
    expect(installAbortSignalPolyfill()).toEqual({ timeout: false, any: false });
  });

  test('every entry installs it before anything else', () => {
    for (const entry of [
      'src/index.tsx',
      'src/mobile/main.ts',
      'src/background.ts',
      'src/mobile/background.worker.ts',
      'src/prompt-tab.tsx',
      'src/permissions-tab.tsx',
      'src/usb-tab.tsx',
      'src/sweep-tab.tsx',
      'src/mobile/push/extBackground.ts',
    ]) {
      const src = readFileSync(entry, 'utf8');
      const firstImport = src.split('\n').find((l) => l.startsWith('import '));
      expect(firstImport).toContain('abortSignalPolyfill');
    }
  });
});
