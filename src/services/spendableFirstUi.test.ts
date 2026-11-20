/**
 * Instant restore, what the owner sees (owner's restore on 5.2.59, 20 Nov 2026: "Retry moving this account to this
 * device" and "Arriving from your other device: $27.49" read as nonsense). While a snapshot restore runs: one calm line,
 * no "Arriving…", no copy progress, no move notice. Flag off (no `snapshot`): the lines exactly as before. And the
 * initWallet wiring is inert with the flag off: nothing connects, nothing is added.
 */
import { describe, expect, test } from 'bun:test';
import { SNAPSHOT_LOADING_LINE, truthLines, type BalanceTruth } from './balanceTruth';
import { moveNoticeShows } from '../components/moveToDevice';
import { createSpendableFirst, type OurServerClient, type SpendableFirstWiringDeps } from './spendableFirstWiring';
import { SNAPSHOT_SERVER_URL } from './spendableFirst';

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
    await w.addOurBackup();
    expect(log).toEqual(['connect', 'user', 'setActive:device-sik', `addRemote:${SNAPSHOT_SERVER_URL}`]);
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
    expect(wiring.match(/withLock: d\.withLock/g)?.length).toBe(2); // the lean pages and the background pages
  });
});
