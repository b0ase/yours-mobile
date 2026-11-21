/**
 * Instant restore, what the owner sees (owner's restore on 5.2.59, 20 Nov 2026: "Retry moving this account to this
 * device" and "Arriving from your other device: $27.49" read as nonsense). While a snapshot restore runs: one calm line,
 * no "Arriving…", no copy progress, no move notice. Flag off (no `snapshot`): the lines exactly as before. And the
 * initWallet wiring is inert with the flag off: nothing connects, nothing is added.
 */
import { describe, expect, test } from 'bun:test';
import { SNAPSHOT_LOADING_LINE, truthLines, type BalanceTruth } from './balanceTruth';
import { moveNoticeShows } from '../components/moveToDevice';
import {
  createSpendableFirst,
  holdSendsForSnapshot,
  oneSatSnapshotLookups,
  type OurServerClient,
  type SendGate,
  type SpendableFirstWiringDeps,
} from './spendableFirstWiring';
import { SNAPSHOT_SEND_WAIT, SNAPSHOT_SERVER_URL } from './spendableFirst';

const NOW = Date.UTC(2026, 10, 20, 12);
const usd = (n: number) => `$${(n / 1e6).toFixed(2)}`;
const truth = (over: Partial<BalanceTruth> = {}): BalanceTruth => ({
  held: [],
  arrivingSats: 27_490_000,
  syncApplies: true,
  sync: { okAt: NOW - 4 * 60_000 },
  restore: { phase: 'checking', arrivingSats: 27_490_000, done: 10, total: 10 },
  ...over,
});

describe('the balance card during an instant restore', () => {
  test('one calm line; never "Arriving…" or the copy progress', () => {
    const texts = truthLines(truth({ snapshot: true }), usd, NOW).map((l) => l.text);
    expect(texts).toContain(SNAPSHOT_LOADING_LINE);
    expect(SNAPSHOT_LOADING_LINE).toBe('Loading older history…');
    expect(texts.join('\n')).not.toMatch(/Arriving|Moving your wallet|Retry/);
  });

  test('flag off (no snapshot field): exactly the lines as before', () => {
    const before = truthLines(truth(), usd, NOW).map((l) => l.text);
    expect(before).toContain('Arriving from your other device: $27.49');
    expect(truthLines(truth({ snapshot: false }), usd, NOW)).toEqual(truthLines(truth(), usd, NOW));
  });

  test('the move notice ("Retry moving this account to this device") is hidden while it runs', () => {
    expect(moveNoticeShows({ onDevice: false })).toBe(true);
    expect(moveNoticeShows({ onDevice: false, snapshotLoading: true })).toBe(false);
    expect(moveNoticeShows({ onDevice: true })).toBe(false);
    expect(moveNoticeShows(null)).toBe(false);
  });
});

describe('initWallet wiring', () => {
  const harness = (on: boolean, over: Partial<SpendableFirstWiringDeps> = {}) => {
    const log: string[] = [];
    const kvStore: Record<string, unknown> = {};
    const client = {
      makeAvailable: async () => (log.push('connect'), { storageIdentityKey: 'server-sik' }),
      getSettings: () => ({ storageIdentityKey: 'server-sik' }),
      findOrInsertUser: async () => (log.push('user'), { user: { userId: 7 } }),
      setActive: async (_a: unknown, sik: string) => void log.push(`setActive:${sik}`),
      rpcCall: async (m: string) => {
        log.push(m);
        return {};
      },
    } as unknown as OurServerClient;
    const w = createSpendableFirst({
      on,
      newClient: () => client,
      device: () => ({ getSettings: () => ({ storageIdentityKey: 'device-sik' }) }) as never,
      identityKey: async () => '02ab',
      deviceActive: () => true,
      tracker: async () => ({ isValidRootForHeight: async () => true }),
      remoteDefaultCoins: async () => 0,
      makeDeviceActive: async () => void log.push('makeDeviceActive'),
      withLock: (fn) => fn(),
      fill: async (_w, restorePoint) => {
        log.push(`fill:${restorePoint ? 'restore-point' : 'full'}`);
        return { how: 'full', pages: 1, unlockedPages: 0, unlockedMs: 0, lockedMs: [] };
      },
      addRemote: async (url) => void log.push(`addRemote:${url}`),
      kv: { get: async (k) => ({ [k]: kvStore[k] }), set: async (i) => void Object.assign(kvStore, i) },
      markKey: 'mark',
      ...over,
    });
    return { w, log };
  };

  test('flag off: not used, no connection, no backup added, never loading', async () => {
    const { w, log } = harness(false);
    expect(await w.spendableFirst('https://wallet.1sat.app')).toEqual({ used: false });
    await w.addOurBackup();
    await w.resume();
    expect(w.loading()).toBe(false);
    expect(log).toEqual([]);
  });

  test('flag on: our server is added as a backup only after its user row names this device', async () => {
    const { w, log } = harness(true);
    expect(await w.addOurBackup()).toBe(true);
    // Review 4: the first fill runs before our server is registered, so no ordinary push sends the whole wallet in
    // the storage locks.
    expect(log).toEqual(['connect', 'user', 'setActive:device-sik', 'fill:full', `addRemote:${SNAPSHOT_SERVER_URL}`]);
  });

  test('flag on, our server offers no snapshot: not used, today’s path runs', async () => {
    const { w, log } = harness(true);
    expect(await w.spendableFirst('https://wallet.1sat.app')).toEqual({ used: false });
    expect(log).toContain('getCapabilities');
    expect(log).not.toContain('makeDeviceActive');
    expect(w.loading()).toBe(false);
  });
});

describe('review 7: flag off never connects or pushes to our server', () => {
  test('our server is left out of the backups with the flag off, even if an earlier session saved it', async () => {
    const { backupsFor } = await import('./spendableFirst');
    const saved = ['https://wallet.1sat.app', SNAPSHOT_SERVER_URL];
    expect(backupsFor(saved, false)).toEqual(['https://wallet.1sat.app']);
    expect(backupsFor(saved, true)).toEqual(saved);
    expect(backupsFor(undefined, false)).toBeUndefined();
  });

  test('wired: both of initWallet’s storage openings filter the backups by the flag', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(src.match(/backupsFor\(resolved\.backups, await spendableFirstOn\(/g)?.length).toBe(2);
  });
});

describe('review 5: wired', () => {
  test('initWallet runs every snapshot page inside the storage manager’s locks', async () => {
    const { readFileSync } = await import('node:fs');
    const init = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(init).toContain('withLock: (fn) => storage.runAsSync(() => fn())');
    const wiring = readFileSync(new URL('./spendableFirstWiring.ts', import.meta.url), 'utf8');
    expect(wiring.match(/withLock: pageLock/g)?.length).toBe(2); // the lean pages and the background pages
    expect(wiring).toContain('const pageLock = <T>(fn: () => Promise<T>) => serial(() => d.withLock(fn));');
  });
});

describe('1p checks, 21 Nov 2026 (3) and re-review F2: payments fund from coins this device can broadcast', () => {
  // A send before the full snapshot built from coins this device had no bytes for: it came back "failed", posted
  // nothing, and left an unprocessed transaction. Every send (all go through wallet.createAction) funds from verified
  // coins only; only one that needs an unverified coin waits for the snapshot (re-review F2: no wait otherwise).
  const insufficient = Object.assign(new Error('Insufficient funds in the available inputs'), {
    code: 'WERR_INSUFFICIENT_FUNDS',
  });
  const gated = (g: Partial<SendGate> = {}, short = 0) => {
    const built: unknown[] = [];
    let tries = 0;
    const wallet = {
      createAction: async (args: unknown) => {
        if (++tries <= short) throw insufficient;
        built.push(args);
        return { txid: 'ab'.repeat(32) };
      },
    };
    const calls: string[] = [];
    holdSendsForSnapshot(wallet, {
      active: () => true,
      loading: () => true,
      leanRunning: () => false,
      verifiedOnly: async <T>(pay: () => Promise<T>) => {
        calls.push('verifiedOnly');
        try {
          return { ok: true as const, value: await pay(), setAside: 3 };
        } catch (error) {
          return { ok: false as const, error, setAside: 3 };
        }
      },
      settle: async () => (calls.push('settle'), 'settled' as const),
      waitMs: 5,
      ...g,
    });
    return { wallet, built, calls };
  };
  const send = { description: 'a payment', outputs: [{ lockingScript: '00', satoshis: 1, outputDescription: 'x' }] };

  test('not restored from a snapshot (or flag off): goes as before, nothing asked', async () => {
    const x = gated({ active: () => false });
    await x.wallet.createAction(send);
    expect(x.built).toHaveLength(1);
    expect(x.calls).toEqual([]);
  });

  test('first pages still coming in: refused with the wait line, nothing built', async () => {
    const x = gated({ leanRunning: () => true });
    await expect(x.wallet.createAction(send)).rejects.toThrow(SNAPSHOT_SEND_WAIT);
    expect(x.built).toHaveLength(0);
  });

  test('the rest still coming in, verified coins enough: goes at once, never waits', async () => {
    const x = gated({ settle: async () => (x.calls.push('settle'), 'running' as const) });
    await x.wallet.createAction(send);
    expect(x.calls).toEqual(['verifiedOnly']);
    expect(x.built).toHaveLength(1);
  });

  test('needs an unverified coin: waits for the snapshot, then tries once more from verified coins', async () => {
    const x = gated({}, 1);
    await x.wallet.createAction(send);
    expect(x.calls).toEqual(['verifiedOnly', 'settle', 'verifiedOnly']);
    expect(x.built).toHaveLength(1);
  });

  test('needs an unverified coin, snapshot still running (or paused): refused with the wait line, nothing built', async () => {
    for (const state of ['running', 'paused'] as const) {
      const x = gated({ settle: async () => state }, 1);
      await expect(x.wallet.createAction(send)).rejects.toThrow(SNAPSHOT_SEND_WAIT);
      expect(x.built).toHaveLength(0);
    }
  });

  test('short of funds with nothing set aside, or the snapshot done: the toolbox’s own error, as today', async () => {
    const none = gated(
      {
        verifiedOnly: async <T>(pay: () => Promise<T>) => {
          try {
            return { ok: true as const, value: await pay(), setAside: 0 };
          } catch (error) {
            return { ok: false as const, error, setAside: 0 };
          }
        },
      },
      1,
    );
    await expect(none.wallet.createAction(send)).rejects.toThrow(/Insufficient funds/);
    const done = gated({ loading: () => false }, 1);
    await expect(done.wallet.createAction(send)).rejects.toThrow(/Insufficient funds/);
    expect(done.calls).toEqual(['verifiedOnly']);
  });

  test('a sendWith-only call builds nothing: never gated', async () => {
    const x = gated({ leanRunning: () => true });
    await x.wallet.createAction({ description: 'send the batch', options: { sendWith: ['ab'.repeat(32)] } });
    expect(x.built).toHaveLength(1);
  });

  test('flag off: today’s path unchanged: every send goes straight through, the device is never read', async () => {
    let read = 0;
    const { w } = harnessOff(() => void read++);
    const built: unknown[] = [];
    const wallet = { createAction: async (a: unknown) => (built.push(a), { txid: 'cd'.repeat(32) }) };
    expect(w.guardSends(wallet)).toBe(true);
    await w.resume();
    await wallet.createAction(send);
    expect(built).toEqual([send]);
    expect(read).toBe(0);
    expect(await w.spendableFirst('https://wallet.1sat.app')).toEqual({ used: false });
    expect(read).toBe(0);
  });

  test('wired: initWallet guards the base wallet’s createAction with it', async () => {
    const { readFileSync } = await import('node:fs');
    const init = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(init).toContain('spendableFirst.guardSends(baseWallet)');
  });
});

/** The wiring with the flag off; `touched` runs if anything reads the device or connects. */
function harnessOff(touched: () => void) {
  const w = createSpendableFirst({
    on: false,
    newClient: () => (touched(), {}) as unknown as OurServerClient,
    device: () => (touched(), undefined),
    identityKey: async () => (touched(), '02ab'),
    deviceActive: () => true,
    tracker: async () => (touched(), { isValidRootForHeight: async () => true }),
    remoteDefaultCoins: async () => (touched(), 0),
    makeDeviceActive: async () => touched(),
    withLock: (fn) => fn(),
    fill: async () => (touched(), { how: 'full', pages: 0, unlockedPages: 0, unlockedMs: 0, lockedMs: [] }),
    addRemote: async () => touched(),
    kv: { get: async () => (touched(), {}), set: async () => touched() },
    markKey: 'mark',
  });
  return { w };
}

describe('1p checks, 21 Nov 2026 (1, 2): the chain lookups the snapshot asks', () => {
  const A = 'aa'.repeat(32);
  const B = 'bb'.repeat(32);
  const ops = [`${A}.0`, `${A}.1`, `${B}.0`];
  test('spends, by outpoint: asked in both orders; an answer counts only where both agree (re-review F1)', async () => {
    const asked: string[][] = [];
    const index = new Map<string, string | null>([
      [ops[0], 'cd'.repeat(32)],
      [ops[1], null],
      [ops[2], null],
    ]);
    const l = oneSatSnapshotLookups({
      txo: { getSpends: async (o: string[]) => (asked.push(o), o.map((x) => index.get(x) ?? null)) },
      beef: { getBeef: async () => [1, 2, 3] },
    });
    const m = await l.spends!(ops);
    expect([...m.entries()]).toEqual([
      [ops[0], 'cd'.repeat(32)],
      [ops[1], null],
      [ops[2], null],
    ]);
    expect(asked).toEqual([ops, [...ops].reverse()]);
    expect(await l.chainBeef!('ef'.repeat(32))).toEqual([1, 2, 3]);
  });

  test('a reply in its own order (sorted): the coins whose answers moved get none', async () => {
    const index = new Map<string, string | null>([
      [ops[0], 'cd'.repeat(32)],
      [ops[1], null],
      [ops[2], null],
    ]);
    const l = oneSatSnapshotLookups({
      txo: {
        getSpends: async (o: string[]) =>
          [...o]
            .sort()
            .reverse()
            .map((x) => index.get(x) ?? null),
      },
    });
    const m = await l.spends!(ops);
    expect(m.has(ops[0])).toBe(false); // the spent answer lands on another coin in one of the two orders
    expect(m.has(ops[2])).toBe(false);
    expect(m.get(ops[1])).toBe(null); // the middle one stays put in both orders
  });

  test('a short reply: no answers at all', async () => {
    const l = oneSatSnapshotLookups({ txo: { getSpends: async (o: string[]) => o.slice(1).map(() => null) } });
    expect((await l.spends!(ops)).size).toBe(0);
  });

  test('no 1Sat services: no lookups (the restore then falls back to today’s path)', () => {
    expect(oneSatSnapshotLookups(undefined)).toEqual({});
  });
});
