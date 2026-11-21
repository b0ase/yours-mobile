/**
 * How initWallet runs the instant restore (services/spendableFirst.ts) for one open account. Everything here is
 * inert with the flag off: `spendableFirst` answers "not used" without asking anything, nothing is hooked, our server
 * is never connected, and the balance card and move notice read `loading() === false`.
 */
import {
  holdUnverified,
  installSnapshotBeef,
  restoreSpendableFirst,
  runFullSnapshot,
  SNAPSHOT_SEND_WAIT,
  SNAPSHOT_SERVER_URL,
  type ChainTrackerLike,
  type SnapOutput,
  type SnapshotClient,
  type SnapshotDevice,
  type SnapshotMark,
  type SpendsLookup,
} from './spendableFirst';
import { withTimeout } from './restoreProgress';
import { buildsTransaction, LocalStoreNeededError } from './localFirst';
import type { FillReport } from './backupFill';

const CONNECT_MS = 8_000;
const COUNT_MS = 8_000;
/** How long a send waits for the background snapshot before it is refused with the wait line. */
export const SEND_WAIT_MS = 15_000;

const TXID = /^[0-9a-f]{64}$/i;
type Bytes = number[] | Uint8Array;

/**
 * The chain lookups the snapshot asks (1p checks, 21 Nov 2026), from the 1Sat services the wallet factory returns:
 *  - spends: the spend index, one POST for a batch of outpoints (a txid: spent; null: unspent; else no answer);
 *  - chainBeef: an unconfirmed transaction's BEEF back to proven parents, when our server has none.
 * No such services: none (a restore without the chain check falls back to today's path).
 */
export function oneSatSnapshotLookups(services: unknown): {
  spends?: SpendsLookup;
  chainBeef?: (txid: string) => Promise<Bytes>;
} {
  const s = services as {
    txo?: { getSpends?: (ops: string[]) => Promise<unknown[]> };
    beef?: { getBeef?: (txid: string) => Promise<Bytes> };
  } | null;
  const txo = s?.txo;
  const beef = s?.beef;
  return {
    ...(typeof txo?.getSpends === 'function'
      ? {
          spends: async (ops: string[]) =>
            (await txo.getSpends!.call(txo, ops)).map((a) =>
              a === null ? null : typeof a === 'string' && TXID.test(a) ? a.toLowerCase() : undefined,
            ),
        }
      : {}),
    ...(typeof beef?.getBeef === 'function' ? { chainBeef: (txid: string) => beef.getBeef!.call(beef, txid) } : {}),
  };
}

type CreateArgs = { inputs?: unknown[]; outputs?: unknown[] } | undefined;
export type SendGate = {
  /** The snapshot is still coming in (spendableFirst loading()). */
  loading: () => boolean;
  /** Its first (lean) pages are: the device store may not even be active yet. */
  leanRunning: () => boolean;
  /** Wait up to `ms` for the background snapshot: done (or stopped for good), still running, or paused (network). */
  settle: (ms: number) => Promise<'settled' | 'running' | 'paused'>;
  /** Hold every spendable coin this device has no verified bytes for (spendableFirst.holdUnverified). */
  holdUnverified: () => Promise<number>;
  waitMs?: number;
  log?: (...a: unknown[]) => void;
};

/**
 * No payment is built while the snapshot is still coming in (1p checks, 21 Nov 2026: a send before the full snapshot
 * picked coins this device had no bytes for; it came back "failed", posted nothing and left an unprocessed
 * transaction). Wraps wallet.createAction, the one call every send goes through: a call that builds a transaction
 * waits for the background snapshot (SEND_WAIT_MS), then goes; still running, or the first pages still coming in, it
 * is refused with the wait line before anything is built. Paused (our server unreachable): the coins without verified
 * bytes are held first, so the payment funds only from coins this device can broadcast. Returns false when there is
 * no createAction to wrap.
 */
export function holdSendsForSnapshot(wallet: unknown, g: SendGate): boolean {
  const w = wallet as { createAction?: (args: CreateArgs, originator?: string) => Promise<unknown> } | null;
  if (!w || typeof w.createAction !== 'function') return false;
  const original = w.createAction.bind(w);
  w.createAction = async (args: CreateArgs, originator?: string) => {
    if (buildsTransaction(args) && g.loading()) {
      if (g.leanRunning()) throw new LocalStoreNeededError(SNAPSHOT_SEND_WAIT);
      const state = await g.settle(g.waitMs ?? SEND_WAIT_MS);
      if (state === 'running') {
        g.log?.('[spendable-first] a payment waited for the snapshot and was refused: nothing built');
        throw new LocalStoreNeededError(SNAPSHOT_SEND_WAIT);
      }
      if (state === 'paused') await g.holdUnverified();
    }
    return original(args, originator);
  };
  return true;
}

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
  /**
   * The first fill of our server from this device (services/backupFill.ts): the bulk outside the storage locks, and a
   * device restored from our snapshot from its restore point. Runs before our server is registered as a backup.
   */
  fill: (writer: OurServerClient, restorePoint?: Date) => Promise<FillReport>;
  /** The factory's addRemote: register a backup for this session. */
  addRemote: (url: string) => Promise<void>;
  owns?: (row: SnapOutput, scriptHex: string) => Promise<boolean>;
  /** The chain's word on coins (oneSatSnapshotLookups): no lean coin counts without it. */
  spends?: SpendsLookup;
  /** An unconfirmed transaction's BEEF from the chain, when our server has none (oneSatSnapshotLookups). */
  chainBeef?: (txid: string) => Promise<Bytes>;
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
          chainBeef: d.chainBeef,
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
  const addOurBackup = async (): Promise<boolean> => {
    if (!d.on || !d.deviceActive()) return false;
    try {
      const c = await connect();
      const identityKey = await d.identityKey();
      const { user } = await c.findOrInsertUser(identityKey);
      const deviceSik = d.device()?.getSettings().storageIdentityKey;
      if (!deviceSik) return false;
      await c.setActive({ identityKey, userId: user.userId }, deviceSik);
      // Filled before it is registered: the ordinary push then starts from our server's cursor, never from the
      // beginning inside the storage locks (review, 20 Nov 2026, finding 4).
      const restorePoint = mark?.restoredAt ? new Date(mark.restoredAt) : undefined;
      const r = await d.fill(c, restorePoint);
      log(
        `[spendable-first] our server filled (${r.how}): ${r.pages} page(s), ${r.unlockedMs} ms unlocked, locked ${r.lockedMs.join('+') || 0} ms`,
      );
      await d.addRemote(SNAPSHOT_SERVER_URL);
      return true;
    } catch (e) {
      log('[spendable-first] our server not added as a backup this session:', e);
      return false;
    }
  };

  return {
    /** For ensureLocalStore (services/localFirst.ts). */
    spendableFirst: async (remoteUrl: string): Promise<{ used: true; remotes: string[] } | { used: false }> => {
      if (!d.on) return { used: false };
      const remoteActive = !d.deviceActive();
      const restoredAt = Date.now();
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
        spends: d.spends,
        onPhase: (p) => void (lean = p === 'lean'),
        log,
      });
      if (!r.used) return { used: false };
      log(`[spendable-first] restored from our server's snapshot (backup ${remoteUrl} stays the history source)`);
      hook();
      await saveMark({ stage: 'full', after: 0, at: Date.now(), restoredAt });
      void runFull();
      // Our server becomes a saved backup only once its first fill is done (background addSnapshotRemote).
      return { used: true, remotes: [] };
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
    /** Every send waits for (or is refused while) the snapshot is still coming in: holdSendsForSnapshot. */
    guardSends: (wallet: unknown) =>
      holdSendsForSnapshot(wallet, {
        loading: () => d.on && (lean || mark?.stage === 'full'),
        leanRunning: () => d.on && lean,
        settle: async (ms) => {
          if (mark?.stage !== 'full') return 'settled';
          const run = runFull();
          if (!run) return 'paused';
          let timer: ReturnType<typeof setTimeout> | undefined;
          const ended = await Promise.race([
            run.then(() => true),
            new Promise<boolean>((r) => {
              timer = setTimeout(() => r(false), ms);
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (!ended) return 'running';
          return (mark as SnapshotMark | null)?.stage === 'full' ? 'paused' : 'settled';
        },
        holdUnverified: async () => {
          const dev = d.device();
          if (!dev) return 0;
          const { user } = await dev.findOrInsertUser(await d.identityKey());
          const n = await holdUnverified(dev, user.userId);
          if (n) log(`[spendable-first] our server unreachable: ${n} unverified coin(s) held before a payment`);
          return n;
        },
        log,
      }),
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
