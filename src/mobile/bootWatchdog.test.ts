import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  __resetBootWatchdogForTests,
  addStage,
  BOOT_TIMEOUT_MS,
  BOOT_TRACE_KEY,
  BOOT_TRACE_PREV_KEY,
  bootWatchdogDecision,
  markBootReady,
  markBootStage,
  startBootWatchdog,
  type BootTrace,
} from './bootWatchdog';

describe('bootWatchdogDecision', () => {
  it('waits before the timeout, shows after it, and stands down once ready or shown', () => {
    const base = { startedAt: 1000, ready: false, shown: false };
    expect(bootWatchdogDecision({ ...base, now: 1000 + BOOT_TIMEOUT_MS - 1 })).toBe('wait');
    expect(bootWatchdogDecision({ ...base, now: 1000 + BOOT_TIMEOUT_MS })).toBe('show');
    expect(bootWatchdogDecision({ ...base, now: 1000 + 60_000, ready: true })).toBe('done');
    expect(bootWatchdogDecision({ ...base, now: 1000 + 60_000, shown: true })).toBe('done');
    expect(bootWatchdogDecision({ ...base, now: 1500, timeoutMs: 400 })).toBe('show');
  });
});

describe('addStage', () => {
  it('appends rounded stages, caps the list and marks ready', () => {
    let t: BootTrace = { startedAt: 'x', stages: [] };
    t = addStage(t, 'a', 1.6);
    expect(t.stages).toEqual([{ stage: 'a', ms: 2 }]);
    expect(t.ready).toBeUndefined();
    for (let i = 0; i < 80; i++) t = addStage(t, `s${i}`, i);
    expect(t.stages.length).toBe(50);
    expect(t.stages.at(-1)?.stage).toBe('s79');
    expect(addStage(t, 'ready', 5, true).ready).toBe(true);
  });
});

describe('trace in localStorage', () => {
  const store = new Map<string, string>();
  const g = globalThis as { localStorage?: unknown };
  let had: unknown;
  beforeEach(() => {
    had = g.localStorage;
    store.clear();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    __resetBootWatchdogForTests();
  });
  afterEach(() => {
    __resetBootWatchdogForTests();
    g.localStorage = had;
  });

  it('is a no-op until started (extension, tests)', () => {
    markBootStage('x');
    markBootReady();
    expect(store.size).toBe(0);
  });

  it('keeps the previous boot, records stages, and stops on ready', () => {
    store.set(BOOT_TRACE_KEY, '{"old":true}');
    startBootWatchdog(60_000);
    expect(store.get(BOOT_TRACE_PREV_KEY)).toBe('{"old":true}');
    markBootStage('background: ready');
    markBootReady('services: ready');
    markBootStage('switch: reloading');
    const t = JSON.parse(store.get(BOOT_TRACE_KEY)!) as BootTrace;
    expect(t.stages.map((s) => s.stage)).toEqual([
      'main: start',
      'background: ready',
      'services: ready',
      'switch: reloading',
    ]);
    expect(t.ready).toBe(true);
  });

  it('survives storage that throws', () => {
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => {
      startBootWatchdog(60_000);
      markBootStage('a');
      markBootReady();
    }).not.toThrow();
  });
});
