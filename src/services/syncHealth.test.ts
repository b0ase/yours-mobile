import { describe, expect, test } from 'bun:test';
import { STUCK_PASS_MS } from './fullPass';
import type { IntegrityReport } from './pullIntegrity';
import {
  EMPTY_SYNC_HEALTH,
  createPullRecord,
  createSyncHealth,
  deviceSyncPullKey,
  onSyncHealth,
  registerSyncHealth,
  syncHealth,
} from './syncHealth';

const MIN = 60_000;
const report = (p: Partial<IntegrityReport>): IntegrityReport => ({
  plan: 'none',
  caughtUp: true,
  checked: 0,
  resolved: 0,
  missingTx: 0,
  missingOutputs: 0,
  awaiting: 0,
  knownMissing: 0,
  givenUp: 0,
  ...p,
});

describe('syncHealth: what the UI line reads', () => {
  test('a pull that caught up records its time; one part-way says a pass is under way', () => {
    let t = 1_000_000;
    const h = createSyncHealth({ now: () => t });
    h.attempt();
    h.succeeded(report({ caughtUp: false, plan: 'busy' }));
    expect(h.get()).toMatchObject({ lastPullOkAt: 0, passUnderWay: true, stuck: false, lastAttemptAt: t });
    t += MIN;
    h.attempt();
    h.succeeded(report({ pullOkAt: t }));
    expect(h.get()).toMatchObject({ lastPullOkAt: t, passUnderWay: false, stuck: false });
  });

  test('pulls failing for 30 min of uptime are stuck; gaps (asleep) count at most 5 min each; a success clears it', () => {
    let t = 0;
    const h = createSyncHealth({ now: () => t });
    h.failed(new Error('network: the backup did not answer in time (getSyncChunk)'));
    // Two hours apart: only 5 minutes each.
    for (let i = 0; i < 5; i++) {
      t += 2 * 60 * MIN;
      h.failed(new Error('again'));
    }
    expect(h.get().stuck).toBe(false);
    t += 2 * 60 * MIN;
    h.failed(new Error('again'));
    expect(STUCK_PASS_MS).toBe(30 * MIN);
    expect(h.get()).toMatchObject({ stuck: true, reason: 'failing', lastError: 'again' });
    h.succeeded(report({ pullOkAt: t }));
    expect(h.get()).toMatchObject({ stuck: false, lastError: undefined, lastPullOkAt: t });
  });

  test("a pass that doesn't move is stuck until a pull catches up; one given up is not", () => {
    const h = createSyncHealth({ now: () => 5 });
    h.plan('stuck');
    expect(h.get()).toMatchObject({ stuck: true, reason: 'no-progress' });
    h.succeeded(report({ caughtUp: false, plan: 'busy' }));
    expect(h.get().stuck).toBe(true);
    h.succeeded(report({}));
    expect(h.get().stuck).toBe(false);
    h.plan('abandoned');
    expect(h.get()).toMatchObject({ stuck: false, lastAbandonedAt: 5 });
  });

  test('payments waiting for coins: healing while a heal pass runs; stuck once heals ran out', () => {
    const h = createSyncHealth({ now: () => 9 });
    h.succeeded(report({ plan: 'healing', missingTx: 2, knownMissing: 2, awaiting: 2 }));
    expect(h.get()).toMatchObject({ missingOutputs: 2, healing: true, stuck: false });
    h.succeeded(report({ plan: 'busy', caughtUp: false, knownMissing: 2, awaiting: 2 }));
    expect(h.get().healing).toBe(true);
    h.succeeded(report({ plan: 'full-due', knownMissing: 1, givenUp: 1, awaiting: 1 }));
    expect(h.get()).toMatchObject({ missingOutputs: 1, healing: false, stuck: true, reason: 'missing-outputs' });
    h.succeeded(report({ plan: 'none' }));
    expect(h.get()).toMatchObject({ missingOutputs: 0, stuck: false });
  });

  test("the module getter follows the open wallet's tracker", () => {
    const seen: boolean[] = [];
    const off = onSyncHealth((x) => seen.push(x.stuck));
    const h = createSyncHealth({ now: () => 1 });
    registerSyncHealth(h);
    h.plan('stuck');
    expect(syncHealth().stuck).toBe(true);
    registerSyncHealth(undefined);
    expect(syncHealth()).toEqual(EMPTY_SYNC_HEALTH);
    off();
    expect(seen).toContain(true);
    h.hydrate(42);
    expect(h.get().lastPullOkAt).toBe(42);
  });

  test('the per-account record (deviceSyncPull:<address>) is merged, in order, other fields kept', async () => {
    const store: Record<string, unknown> = { [deviceSyncPullKey('1Abc')]: { okAt: 5, other: 'fix 5' } };
    const kv = {
      get: async (k: string) => ({ [k]: store[k] }),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
    };
    const rec = createPullRecord(kv, '1Abc');
    void rec({ attemptAt: 10 });
    await rec({ okAt: 11, stuck: false });
    expect(store['deviceSyncPull:1Abc']).toEqual({ okAt: 11, other: 'fix 5', attemptAt: 10, stuck: false });
    await createPullRecord(kv, undefined)({ attemptAt: 1 }); // no account: nothing written
    expect(Object.keys(store)).toEqual(['deviceSyncPull:1Abc']);
  });
});
