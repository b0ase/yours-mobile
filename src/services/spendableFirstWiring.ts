/**
 * How initWallet runs the instant restore (services/spendableFirst.ts) for one open account. Everything here is
 * inert with the flag off: `spendableFirst` answers "not used" without asking anything, nothing is hooked, our server
 * is never connected, and the balance card and move notice read `loading() === false`.
 */
import {
  installSnapshotBeef,
  restoreSpendableFirst,
  runFullSnapshot,
  SNAPSHOT_SERVER_URL,
  type ChainTrackerLike,
  type SnapOutput,
  type SnapshotClient,
  type SnapshotDevice,
  type SnapshotMark,
} from './spendableFirst';
import { withTimeout } from './restoreProgress';

const CONNECT_MS = 8_000;
const COUNT_MS = 8_000;

/** Our server's client as the toolbox's StorageClient offers it (the few calls used here). */
export type OurServerClient = SnapshotClient & {
  makeAvailable(): Promise<{ storageIdentityKey: string }>;
  findOrInsertUser(identityKey: string): Promise<{ user: { userId: number } }>;
  setActive(auth: { identityKey: string; userId: number }, storageIdentityKey: string): Promise<unknown>;
};

export type SpendableFirstWiringDeps = {
  on: boolean;
  /** A new client for SNAPSHOT_SERVER_URL (not registered with the storage manager). */
  newClient: () => OurServerClient;
  device: () => SnapshotDevice | undefined;
  identityKey: () => Promise<string>;
  /** This device's store is the active one. */
  deviceActive: () => boolean;
  tracker: () => Promise<ChainTrackerLike>;
  /** While the 1Sat backup is the active store: its count of spendable default-basket coins (one listOutputs). */
  remoteDefaultCoins: () => Promise<number>;
  /** Make this device's store active without the toolbox's full copy (a remote-active account). */
  makeDeviceActive: () => Promise<void>;
  /**
   * Run one snapshot page's merge inside the storage manager's locks (runAsSync): no device-sync pull or other merge
   * interleaves with it (review, 20 Nov 2026). The network fetch stays outside.
   */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The factory's addRemote: register a backup for this session. */
  addRemote: (url: string) => Promise<void>;
  owns?: (row: SnapOutput, scriptHex: string) => Promise<boolean>;
  kv: {
    get(key: string): Promise<Record<string, unknown> | undefined>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  markKey: string;
  /** The background snapshot finished (or stopped for good): the ordinary pull may run now. */
  onSettled?: (mark: SnapshotMark) => void;
  log?: (...a: unknown[]) => void;
};

export function createSpendableFirst(d: SpendableFirstWiringDeps) {
  const log = d.log ?? (() => undefined);
  let client: OurServerClient | undefined;
  let connecting: Promise<OurServerClient> | undefined;
  let lean = false;
  let mark: SnapshotMark | null = null;
  let fullRun: Promise<void> | undefined;
  let unhook: (() => void) | undefined;

  const connect = (): Promise<OurServerClient> => {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const c = d.newClient();
      await withTimeout(c.makeAvailable(), CONNECT_MS, 'our storage server');
      client = c;
      return c;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };
  const saveMark = async (m: SnapshotMark) => {
    mark = m;
    await d.kv.set({ [d.markKey]: m }).catch(() => undefined);
  };
  const loadMark = async (): Promise<SnapshotMark | null> => {
    try {
      const v = (await d.kv.get(d.markKey))?.[d.markKey] as SnapshotMark | undefined;
      return v && typeof v === 'object' && typeof v.stage === 'string' ? v : null;
    } catch {
      return null;
    }
  };
  const hook = () => {
    const dev = d.device();
    if (!dev || unhook) return;
    unhook = installSnapshotBeef(dev, {
      client: () => client,
      tracker: d.tracker,
      identityKey: d.identityKey,
      owns: d.owns,
      log,
    });
  };

  /** Stage 3 in the background, from the mark; at most one run at a time. */
  const runFull = () => {
    if (fullRun || !mark || mark.stage !== 'full') return fullRun;
    fullRun = (async () => {
      try {
        const c = await connect();
        const dev = d.device();
        const serverSik = c.getSettings?.()?.storageIdentityKey;
        if (!dev || !serverSik || !d.deviceActive()) return;
        const end = await runFullSnapshot({
          client: c,
          device: dev,
          identityKey: await d.identityKey(),
          serverSik,
          tracker: await d.tracker(),
          owns: d.owns,
          withLock: d.withLock,
          mark: mark!,
          save: saveMark,
          log,
        });
        if (end.stage !== 'full') d.onSettled?.(end);
      } catch (e) {
        log('[spendable-first] background snapshot did not run:', e);
      } finally {
        fullRun = undefined;
      }
    })();
    return fullRun;
  };

  /**
   * Our server as a backup for this session, without the toolbox's merge-and-copy (which would hold every storage lock
   * while it pushed the whole wallet): its user row is pointed at this device first, so it registers as a plain
   * backup and the ordinary pushes fill it.
   */
  const addOurBackup = async () => {
    if (!d.on || !d.deviceActive()) return;
    try {
      const c = await connect();
      const identityKey = await d.identityKey();
      const { user } = await c.findOrInsertUser(identityKey);
      const deviceSik = d.device()?.getSettings().storageIdentityKey;
      if (!deviceSik) return;
      await c.setActive({ identityKey, userId: user.userId }, deviceSik);
      await d.addRemote(SNAPSHOT_SERVER_URL);
    } catch (e) {
      log('[spendable-first] our server not added as a backup this session:', e);
    }
  };

  return {
    /** For ensureLocalStore (services/localFirst.ts). */
    spendableFirst: async (remoteUrl: string): Promise<{ used: true; remotes: string[] } | { used: false }> => {
      if (!d.on) return { used: false };
      const remoteActive = !d.deviceActive();
      const r = await restoreSpendableFirst({
        enabled: async () => d.on,
        client: connect,
        device: d.device,
        identityKey: d.identityKey,
        backupDefaultCoins: remoteActive
          ? () => withTimeout(d.remoteDefaultCoins(), COUNT_MS, 'the backup (count)')
          : undefined,
        makeDeviceActive: remoteActive ? d.makeDeviceActive : undefined,
        withLock: d.withLock,
        onPhase: (p) => void (lean = p === 'lean'),
        log,
      });
      if (!r.used) return { used: false };
      log(`[spendable-first] restored from our server's snapshot (backup ${remoteUrl} stays the history source)`);
      hook();
      await saveMark({ stage: 'full', after: 0, at: Date.now() });
      void runFull();
      void addOurBackup();
      return { used: true, remotes: [SNAPSHOT_SERVER_URL] };
    },
    /** At open: hook the BEEF builder and carry on an unfinished background snapshot. */
    resume: async () => {
      if (!d.on) return;
      mark = await loadMark();
      if (mark?.stage !== 'full') return;
      hook();
      void runFull();
    },
    addOurBackup,
    /** The card's "Loading older history…" and the hidden move notice: the snapshot is still coming in. */
    loading: () => d.on && (lean || mark?.stage === 'full'),
    leanRunning: () => d.on && lean,
    /** Tests and close. */
    stop: () => {
      unhook?.();
      unhook = undefined;
    },
  };
}
