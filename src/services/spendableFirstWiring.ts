/**
 * How initWallet runs the instant restore (services/spendableFirst.ts) for one open account. Everything here is
 * inert with the flag off: `spendableFirst` answers "not used" without asking anything, nothing is hooked, our server
 * is never connected, and the balance card and move notice read `loading() === false`.
 */
import {
  installSnapshotBeef,
  payFromVerifiedOnly,
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
import {
  validateListActionsArgs,
  validateListCertificatesArgs,
  validateListOutputsArgs,
} from '@bsv/sdk/wallet/validationHelpers';
import { withTimeout } from './restoreProgress';
import { buildsTransaction, LocalStoreNeededError } from './localFirst';
import { isInsufficientFunds } from './fundingPrep';
import { FillIncompleteError, fillError, type FillProgress, type FillReport } from './backupFill';

const CONNECT_MS = 8_000;
const COUNT_MS = 8_000;
/** How long a send waits for the background snapshot before it is refused with the wait line. */
export const SEND_WAIT_MS = 15_000;
/** After an unfinished fill of our server, the next try waits this long (by failures in a row), or the server's Retry-After if longer. */
export const OUR_BACKUP_RETRY_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** The backup check: between its reads of our server, and before its one re-read on a difference. */
export const CHECK_GAP_MS = 250;
export const CHECK_RECHECK_MS = 5_000;
/** Each read of the check (our server's, this device's) gets this long; past it the check gives up for this init. */
export const CHECK_READ_MS = 10_000;
/** A fill that stopped making progress is tried again from the start, no sooner than this. */
export const OUR_BACKUP_STALL_RETRY_MS = 15 * 60_000;

/** Our server's first fill didn't finish: kept per account, shown as "Backup incomplete, will retry". */
export type OurBackupIncomplete = {
  at: number;
  /** No try before this (the back-off, or the server's Retry-After). */
  retryAt: number;
  reason: string;
  kind: 'refused' | 'stalled' | 'failed';
  /** Unfinished tries in a row. */
  failures: number;
};
/** What is kept between tries: the device store it was for, how far the fill got, and why it stopped. */
type OurBackupFill = {
  deviceSik: string;
  progress?: FillProgress | null;
  incomplete?: OurBackupIncomplete;
  /**
   * The repair's whole two-pass fill (ensureOurBackup): sticky through every try (a stall, a refusal, progress kept)
   * until a fill finishes, so a later try never becomes a restore-point fill on our server's cursor (review of
   * 0c74701d, 1).
   */
  full?: boolean;
};

/** When the next try may run after `failures` unfinished tries in a row ending with `e`. */
export function ourBackupRetryMs(e: unknown, failures: number): number {
  const err = fillError(e);
  const backoff = OUR_BACKUP_RETRY_MS[Math.min(Math.max(1, failures), OUR_BACKUP_RETRY_MS.length) - 1];
  return Math.max(backoff, err.retryAfterMs ?? 0, err.kind === 'stalled' ? OUR_BACKUP_STALL_RETRY_MS : 0);
}

/**
 * The background's retry of our server's fill: one timer, never sooner than the first back-off step (review of
 * bcd8129b, 5: a try that returns early, the device not active yet, left a past retryAt and re-armed every second).
 */
export function ourBackupRetryTimer(o: {
  /** When the next try may run; undefined: nothing to retry. */
  retryAt: () => number | undefined;
  run: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  minMs?: number;
}) {
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown;
  return {
    /** Arm (or re-arm) the timer for the current retryAt. True when armed. */
    schedule(): boolean {
      const at = o.retryAt();
      if (at === undefined) return false;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(
        () => {
          timer = undefined;
          o.run();
        },
        Math.max(o.minMs ?? OUR_BACKUP_RETRY_MS[0], at - now()),
      );
      return true;
    },
    cancel() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}

/**
 * One try at our server's fill, as the background makes it: a try that didn't land (false) or threw arms the retry
 * timer; one that landed doesn't (review of f2de21bd, 4: a throw used to leave no retry at all).
 */
export function ourBackupAttempt(o: {
  add: () => Promise<boolean>;
  timer: { schedule(): boolean };
  log?: (...a: unknown[]) => void;
}): () => Promise<boolean> {
  return async () => {
    let ok = false;
    try {
      ok = await o.add();
    } catch (e) {
      o.log?.('[spendable-first] our server not added (threw):', e);
    }
    if (!ok) o.timer.schedule();
    return ok;
  };
}

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
          /**
           * The spend index answers a list in the order asked and names no outpoint (checked 21 Nov 2026), so a short or
           * reordered reply could be read against the wrong coin (1p re-review, F1). It is asked twice, in opposite
           * orders: an outpoint gets an answer only when both replies are whole and give it the same one.
           */
          spends: async (ops: string[]) => {
            const ask = (list: string[]) => txo.getSpends!.call(txo, list);
            const back = [...ops].reverse();
            const [a, b] = await Promise.all([ask(ops), ask(back)]);
            const out = new Map<string, string | null>();
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== ops.length || b.length !== ops.length)
              return out;
            const read = (x: unknown) =>
              x === null ? null : typeof x === 'string' && TXID.test(x) ? x.toLowerCase() : undefined;
            ops.forEach((op, i) => {
              const one = read(a[i]);
              const two = read(b[ops.length - 1 - i]);
              if (one !== undefined && one === two) out.set(op, one);
            });
            return out;
          },
        }
      : {}),
    ...(typeof beef?.getBeef === 'function' ? { chainBeef: (txid: string) => beef.getBeef!.call(beef, txid) } : {}),
  };
}

type CreateArgs = { inputs?: unknown[]; outputs?: unknown[] } | undefined;
type Paid<T> = { ok: true; value: T; setAside: number } | { ok: false; error: unknown; setAside: number };
export type SendGate = {
  /** This account was restored from our snapshot (flag on): coins without verified bytes may be on the device. */
  active: () => boolean;
  /** The snapshot is still coming in (spendableFirst loading()). */
  loading: () => boolean;
  /** Its first (lean) pages are: the device store may not even be active yet. */
  leanRunning: () => boolean;
  /** Run the payment funding only from verified coins (spendableFirst.payFromVerifiedOnly), between snapshot pages. */
  verifiedOnly: <T>(pay: () => Promise<T>) => Promise<Paid<T>>;
  /** Wait up to `ms` for the background snapshot: done (or stopped for good), still running, or paused (network). */
  settle: (ms: number) => Promise<'settled' | 'running' | 'paused'>;
  waitMs?: number;
  log?: (...a: unknown[]) => void;
};

/**
 * Only coins this device can broadcast fund a payment after an instant restore (1p checks, 21 Nov 2026: a send before
 * the full snapshot picked coins this device had no bytes for; it came back "failed", posted nothing and left an
 * unprocessed transaction). Wraps wallet.createAction, the one call every send goes through. A call that builds a
 * transaction funds from verified coins only (payFromVerifiedOnly) and goes at once (1p re-review, F2: never a wait
 * because the snapshot is still running). Only a payment those coins can't cover, while the snapshot is still coming
 * in, waits for it (SEND_WAIT_MS) and tries once more; still running or paused, it is refused with the wait line,
 * nothing built. The first pages still coming in: refused with the wait line. Returns false when there is no
 * createAction to wrap.
 */
export function holdSendsForSnapshot(wallet: unknown, g: SendGate): boolean {
  const w = wallet as { createAction?: (args: CreateArgs, originator?: string) => Promise<unknown> } | null;
  if (!w || typeof w.createAction !== 'function') return false;
  const original = w.createAction.bind(w);
  w.createAction = async (args: CreateArgs, originator?: string) => {
    if (!buildsTransaction(args) || !g.active()) return original(args, originator);
    if (g.leanRunning()) throw new LocalStoreNeededError(SNAPSHOT_SEND_WAIT);
    const first = await g.verifiedOnly(() => original(args, originator));
    if (first.ok) return first.value;
    // Needs a coin not verified yet: only the snapshot still coming in can change that.
    if (!first.setAside || !isInsufficientFunds(first.error) || !g.loading()) throw first.error;
    if ((await g.settle(g.waitMs ?? SEND_WAIT_MS)) !== 'settled') {
      g.log?.('[spendable-first] a payment needed coins still being verified: refused, nothing built');
      throw new LocalStoreNeededError(SNAPSHOT_SEND_WAIT);
    }
    const again = await g.verifiedOnly(() => original(args, originator));
    if (again.ok) return again.value;
    throw again.error;
  };
  return true;
}

/** Our server's client as the toolbox's StorageClient offers it (the few calls used here). */
export type OurServerClient = SnapshotClient & {
  makeAvailable(): Promise<{ storageIdentityKey: string }>;
  findOrInsertUser(identityKey: string): Promise<{ user: { userId: number } }>;
  setActive(auth: { identityKey: string; userId: number }, storageIdentityKey: string): Promise<unknown>;
  /** The toolbox StorageClient's listOutputs RPC (spendable outputs only; totalOutputs counts them). */
  listOutputs?(auth: { identityKey: string; userId: number }, vargs: unknown): Promise<{ totalOutputs: number }>;
  /** The toolbox StorageClient's listActions RPC (totalActions counts them). */
  listActions?(auth: { identityKey: string; userId: number }, vargs: unknown): Promise<{ totalActions: number }>;
  /** The toolbox StorageClient's listCertificates RPC (totalCertificates counts them). */
  listCertificates?(
    auth: { identityKey: string; userId: number },
    vargs: unknown,
  ): Promise<{ totalCertificates: number }>;
};

/** What the backup check compares: actions, and spendable outputs in each basket this device has. */
export type BackupCounts = { actions: number; certificates: number; baskets: Record<string, number> };

/**
 * The once-per-device check of our server's backup, as kept (kv `${markKey}:ourBackupCheck`): one record, written in
 * one store write. 'repair-pending' (with `full`) is the decision and the state of a repair at once: a close at any
 * point leaves it, and the next init repeats the repair.
 */
export type OurBackupCheckRecord = {
  deviceSik: string;
  check: 'match' | 'repair-pending' | 'repaired';
  full?: true;
  at: number;
  device?: BackupCounts;
  server?: BackupCounts;
};
export const ourBackupCheckKey = (markKey: string) => `${markKey}:ourBackupCheck`;

/**
 * At wallet init, before the stores connect: may our server (saved as a backup) join this session now? Only once this
 * device's check found it whole ('match' or 'repaired'). Not checked yet, or a repair pending: it is left out of the
 * session and joins only after the check (ensureOurBackup), never detached from a live session. A record that can't be
 * read: it joins as before, and the check runs again next init (never a drop on an error).
 */
export async function ourBackupInitPlan(
  kv: { get(key: string): Promise<Record<string, unknown> | undefined> },
  markKey: string,
  deviceSik: string,
): Promise<'attach' | 'defer'> {
  try {
    const key = ourBackupCheckKey(markKey);
    const r = (await kv.get(key))?.[key] as OurBackupCheckRecord | null | undefined;
    return r?.deviceSik === deviceSik && (r.check === 'match' || r.check === 'repaired') ? 'attach' : 'defer';
  } catch {
    return 'attach';
  }
}

/** One check per device and account in this process: a second init (or worker) joins the one running. */
const checksInFlight = new Map<string, Promise<boolean>>();

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
   * `resume`/`onProgress`: an unfinished fill goes on from the last page our server acknowledged.
   */
  fill: (
    writer: OurServerClient,
    restorePoint?: Date,
    o?: {
      resume?: FillProgress | null;
      onProgress?: (p: FillProgress | null) => Promise<void>;
      /** A fill is known unfinished: never "not-needed" on our server's cursor. */
      unfinished?: boolean;
      /** This session closed: the fill ends before its next page. */
      stopped?: () => boolean;
      /** The whole two-pass fill, never one from the restore point (a repair). */
      full?: boolean;
    },
  ) => Promise<FillReport>;
  /**
   * Our server is one of this session's backups (it joined at init): any kept "incomplete" state is stale (a closed
   * session's late write) and is dropped, unless a repair is pending.
   */
  registered?: () => boolean;
  /** This device's counts: its actions, certificates, and spendable outputs in each of its baskets (by name). */
  deviceCounts?: () => Promise<BackupCounts>;
  /**
   * Our server is saved as a backup but was left out of this session at init (ourBackupInitPlan 'defer'): it joins
   * only through ensureOurBackup, after the check (and a repair, if one is due).
   */
  deferred?: boolean;
  /** Our server joined this session (addRemote went through): the session's backup list now counts it. */
  onAttached?: () => void;
  /** Tests: how the check waits (between our server's reads, and before its one re-read). */
  sleep?: (ms: number) => Promise<void>;
  /** A payment of this wallet's own is waiting or going (ownPayments.waiting): no check runs beside it. */
  busy?: () => boolean;
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
  now?: () => number;
};

export function createSpendableFirst(d: SpendableFirstWiringDeps) {
  const log = d.log ?? (() => undefined);
  const now = d.now ?? Date.now;
  /** Our server's fill, as kept (kv `${markKey}:ourBackupFill`); read at open, written by every try. */
  const fillKey = `${d.markKey}:ourBackupFill`;
  let fillState: OurBackupFill | null = null;
  /**
   * The kept state, read again. `ok: false`: it couldn't be read, which is never "nothing kept": a fill run as if
   * nothing were kept would find our server's cursor from a finished pass, answer "not-needed" and register a
   * half-filled backup (review of f2de21bd, 1).
   */
  const loadFill = async (): Promise<{ ok: true; state: OurBackupFill | null } | { ok: false; error: unknown }> => {
    try {
      const v = (await d.kv.get(fillKey))?.[fillKey] as OurBackupFill | undefined;
      fillState = v && typeof v === 'object' && typeof v.deviceSik === 'string' ? v : null;
      return { ok: true, state: fillState };
    } catch (error) {
      log('[spendable-first] could not read the backup fill state:', error);
      return { ok: false, error };
    }
  };
  /** Set by stop(): a closed session's fill writes nothing more (a new session may have saved since). */
  let closed = false;
  /** `strict`: a failed write throws, so the fill counts as unfinished instead of carrying on unrecorded. */
  const saveFill = async (v: OurBackupFill | null, strict = false) => {
    if (closed) {
      log('[spendable-first] wallet closed: its backup fill state is not written');
      if (strict) throw new Error('the wallet closed');
      return;
    }
    fillState = v;
    try {
      await d.kv.set({ [fillKey]: v });
    } catch (e) {
      log('[spendable-first] could not save the backup fill state:', e);
      if (strict) throw e;
    }
  };
  /** Our server was added as a backup in this session, or is in the account's saved backups. */
  let added = false;
  const registered = () => added || (d.registered?.() ?? false);
  let client: OurServerClient | undefined;
  let connecting: Promise<OurServerClient> | undefined;
  let lean = false;
  let mark: SnapshotMark | null = null;
  let fullRun: Promise<void> | undefined;
  /** One at a time: a snapshot page's merge, or a payment's set-aside window (payFromVerifiedOnly). */
  let turn: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = turn.then(fn, fn);
    turn = r.catch(() => undefined);
    return r;
  };
  /** Each page's merge inside the storage manager's locks, and never inside a payment's set-aside window. */
  const pageLock = <T>(fn: () => Promise<T>) => serial(() => d.withLock(fn));
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
    await d.kv.set({ [d.markKey]: m }).catch((e) => log('[spendable-first] could not save the snapshot mark:', e));
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
          withLock: pageLock,
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
   * A fill that doesn't finish (refused, stalled, failed: mainnet 1p test, 22 Nov 2026) is never dropped silently: it
   * is kept with how far it got, shown as "Backup incomplete, will retry", and our server is not registered (it is not
   * a backup of anything it hasn't acknowledged). The next try (a timer in the background, or the next open) waits for
   * the back-off or the server's Retry-After, then goes on from the last page our server acknowledged.
   */
  let adding: Promise<boolean> | undefined;
  /** One try at a time (the background's retry timer and a wallet open may both ask). */
  const addOurBackup = (): Promise<boolean> =>
    (adding ??= tryOurBackup().finally(() => {
      adding = undefined;
    }));
  /** `repair`: the check found our server half-filled: the whole two-pass fill, as unfinished, whatever is kept. */
  const tryOurBackup = async (o: { repair?: boolean } = {}): Promise<boolean> => {
    if (!d.on || closed || !d.deviceActive()) return false;
    const deviceSik = d.device()?.getSettings().storageIdentityKey;
    if (!deviceSik) return false;
    const read = await loadFill();
    if (!read.ok) {
      // Unreadable is not "nothing kept": no try now, an honest "incomplete" and a retry later (in memory only: the
      // store just failed).
      const failures = (fillState?.incomplete?.failures ?? 0) + 1;
      const at = now();
      const err = new FillIncompleteError('failed', 'the kept backup fill state could not be read');
      fillState = {
        deviceSik,
        progress: fillState?.progress ?? null,
        incomplete: {
          at,
          retryAt: at + ourBackupRetryMs(err, failures),
          reason: err.message,
          kind: err.kind,
          failures,
        },
      };
      return false;
    }
    const kept = read.state;
    const st = kept?.deviceSik === deviceSik ? kept : null;
    // Our server is already a saved backup: nothing to fill, and kept state is stale (a closed session's late write).
    if (registered()) {
      if (kept) await saveFill(null);
      return false;
    }
    if (st?.incomplete && now() < st.incomplete.retryAt) {
      log(
        `[spendable-first] our server's backup incomplete, next try in ${Math.ceil((st.incomplete.retryAt - now()) / 1000)} s`,
      );
      return false;
    }
    let progress: FillProgress | null = st?.progress ?? null;
    const full = o.repair === true || st?.full === true || (progress?.stage === 'restart' && progress.full === true);
    const keep = (p: FillProgress | null, incomplete?: OurBackupIncomplete): OurBackupFill => ({
      deviceSik,
      progress: p,
      ...(incomplete ? { incomplete } : {}),
      ...(full ? { full: true } : {}),
    });
    try {
      const c = await connect();
      const identityKey = await d.identityKey();
      const { user } = await c.findOrInsertUser(identityKey);
      await c.setActive({ identityKey, userId: user.userId }, deviceSik);
      // Filled before it is registered: the ordinary push then starts from our server's cursor, never from the
      // beginning inside the storage locks (review, 20 Nov 2026, finding 4).
      const restorePoint = mark?.restoredAt ? new Date(mark.restoredAt) : undefined;
      const r = await d.fill(c, restorePoint, {
        resume: progress,
        onProgress: async (p) => {
          progress = p;
          // A progress write that fails ends the fill as unfinished (review of bcd8129b, 2): never a fill whose state
          // was lost carrying on to "done" while the kept state says otherwise.
          await saveFill(keep(p, st?.incomplete), true);
        },
        // Any kept state (even with no progress: a stall) means unfinished: never "not-needed" on our server's cursor.
        unfinished: !!st || o.repair === true,
        stopped: () => closed,
        ...(full ? { full: true } : {}),
      });
      if (closed) throw new Error('the wallet closed');
      log(
        `[spendable-first] our server filled (${r.how}): ${r.pages} page(s), ${r.unlockedMs} ms unlocked, locked ${r.lockedMs.join('+') || 0} ms`,
      );
      await d.addRemote(SNAPSHOT_SERVER_URL);
      added = true;
      d.onAttached?.();
      await saveFill(null);
      return true;
    } catch (e) {
      const err = fillError(e);
      const failures = (st?.incomplete?.failures ?? 0) + 1;
      const at = now();
      const incomplete: OurBackupIncomplete = {
        at,
        retryAt: at + ourBackupRetryMs(err, failures),
        reason: err.message,
        kind: err.kind,
        failures,
      };
      if (closed) {
        log("[spendable-first] wallet closed during our server's fill: the next session carries on");
        return false;
      }
      // A fill that stopped moving starts again from the beginning next time (a restart marker, never null: our
      // server may already hold a cursor from a finished pass); any other goes on from its last acknowledged page.
      const next: FillProgress | null =
        err.kind === 'stalled' ? { stage: 'restart', offsets: [], ...(full ? { full: true } : {}) } : progress;
      await saveFill(keep(next, incomplete));
      log(
        `[spendable-first] our server's backup incomplete (${err.kind}), will retry in ${Math.ceil((incomplete.retryAt - at) / 1000)} s:`,
        e,
      );
      return false;
    }
  };

  /** Our server's backup didn't finish: "Backup incomplete, will retry", and when the next try may run. */
  const ourBackup = (): { incomplete: boolean; retryAt?: number } => {
    const inc = d.on && !registered() ? fillState?.incomplete : undefined;
    return inc ? { incomplete: true, retryAt: inc.retryAt } : { incomplete: false };
  };

  /**
   * Builds before 30a4fbcd could register our server half-filled: their fill answered "not-needed" on any cursor our
   * server held (owner's iPhone ran build 153 with the flag on). Once per device and account, our server is left out of
   * the session at init (ourBackupInitPlan) and joins only here, so nothing is ever detached from a live session:
   *  - The check reads our server through a throwaway client of its own (never the session's), each read bounded, then
   *    this device: actions, certificates, and spendable outputs in each of this device's baskets. A difference is read
   *    again once after a pause (a coin arriving between the reads); it must hold.
   *  - Whole: 'match' is recorded and our server joins the session.
   *  - Half-filled: ONE store write records the decision and its state, {check: 'repair-pending', full: true}. The
   *    whole two-pass fill runs (sticky `full` through every try); only once it finishes does our server join the
   *    session, and then 'repaired' is recorded. A close at any point leaves 'repair-pending': the next init repeats it.
   *  - Any read failing or timing out: our server joins as before and the check runs again next init. Never a drop on
   *    an error; only our server's exact URL is ever left out.
   * Returns true once nothing is left to do here (our server joined, or isn't deferred); false: a repair's fill didn't
   * finish (its retry is kept: ourBackup().retryAt).
   */
  const checkKey = ourBackupCheckKey(d.markKey);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sameCounts = (a: BackupCounts, b: BackupCounts) =>
    a.actions === b.actions &&
    a.certificates === b.certificates &&
    Object.keys(a.baskets).every((k) => a.baskets[k] === b.baskets[k]) &&
    Object.keys(b.baskets).every((k) => a.baskets[k] === b.baskets[k]);
  /** Our server joins the session as it always did (the factory's addRemote). */
  const attach = async (): Promise<boolean> => {
    await d.addRemote(SNAPSHOT_SERVER_URL);
    added = true;
    d.onAttached?.();
    return true;
  };
  const record = (r: Omit<OurBackupCheckRecord, 'at'>) => d.kv.set({ [checkKey]: { ...r, at: now() } });
  const runCheck = async (deviceSik: string): Promise<boolean> => {
    let kept: OurBackupCheckRecord | null | undefined;
    try {
      kept = (await d.kv.get(checkKey))?.[checkKey] as OurBackupCheckRecord | null | undefined;
    } catch (e) {
      log('[spendable-first] backup check: its record could not be read; our server joins, checked next init:', e);
      return attach();
    }
    const pending = kept?.deviceSik === deviceSik && kept.check === 'repair-pending';
    if (!pending) {
      if (kept?.deviceSik === deviceSik && (kept.check === 'match' || kept.check === 'repaired')) return attach();
      // Snapshot still coming in, or a payment of its own going: the counts aren't settled. Joins; checked next init.
      if (lean || mark?.stage === 'full' || d.busy?.() || !d.deviceCounts) return attach();
      let counts: { device: BackupCounts; server: BackupCounts };
      try {
        const c = d.newClient();
        await withTimeout(c.makeAvailable(), CHECK_READ_MS, 'our storage server');
        if (typeof c.listOutputs !== 'function' || typeof c.listActions !== 'function') return attach();
        const identityKey = await d.identityKey();
        const { user } = await withTimeout(c.findOrInsertUser(identityKey), CHECK_READ_MS, 'our storage server');
        const auth = { identityKey, userId: user.userId };
        const bounded = <T>(p: Promise<T>) => withTimeout(p, CHECK_READ_MS, 'the backup check');
        // Our server first (nothing reaches it meanwhile: it isn't in the session), then this device.
        const read = async () => {
          const device0 = await bounded(d.deviceCounts!());
          const server: BackupCounts = {
            actions: Number(
              (await bounded(c.listActions!(auth, validateListActionsArgs({ labels: [], limit: 1 })))).totalActions,
            ),
            certificates:
              typeof c.listCertificates === 'function'
                ? Number(
                    (
                      await bounded(
                        c.listCertificates(auth, validateListCertificatesArgs({ certifiers: [], types: [], limit: 1 })),
                      )
                    ).totalCertificates,
                  )
                : device0.certificates,
            baskets: {},
          };
          for (const basket of Object.keys(device0.baskets)) {
            await sleep(CHECK_GAP_MS);
            const vargs = validateListOutputsArgs({ basket, limit: 1 });
            server.baskets[basket] = Number((await bounded(c.listOutputs!(auth, vargs))).totalOutputs);
          }
          const device = await bounded(d.deviceCounts!());
          const finite = (x: BackupCounts) =>
            Number.isFinite(x.actions) &&
            Number.isFinite(x.certificates) &&
            Object.values(x.baskets).every(Number.isFinite);
          if (!finite(device) || !finite(server)) throw new Error('no count');
          return { device, server };
        };
        counts = await read();
        if (!sameCounts(counts.device, counts.server)) {
          await sleep(CHECK_RECHECK_MS);
          counts = await read();
        }
      } catch (e) {
        log(
          '[spendable-first] backup check: our server or this device could not be read; joins, checked next init:',
          e,
        );
        return attach();
      }
      if (sameCounts(counts.device, counts.server)) {
        await record({ deviceSik, check: 'match', ...counts }).catch((e) =>
          log('[spendable-first] backup check: could not record it; checked again next init:', e),
        );
        return attach();
      }
      log(
        `[spendable-first] our server's backup differs (${JSON.stringify(counts.server)} there, ${JSON.stringify(counts.device)} here): it is filled again`,
      );
      try {
        // The decision and its state in one write: from here a close at any point repeats the repair next init.
        await record({ deviceSik, check: 'repair-pending', full: true, ...counts });
      } catch (e) {
        log(
          '[spendable-first] backup check: the repair could not be recorded; our server joins, checked next init:',
          e,
        );
        return attach();
      }
    }
    // The repair: the whole fill, then our server joins (tryOurBackup's addRemote), then 'repaired'.
    if (!(await tryOurBackup({ repair: true }))) return false;
    await record({ deviceSik, check: 'repaired' }).catch((e) =>
      log("[spendable-first] backup check: 'repaired' not recorded; the repair runs once more next init:", e),
    );
    return true;
  };
  /** This session's running check: a close lets the next init's check start at once (it never waits on a dead one). */
  let ownCheck: { key: string; run: Promise<boolean> } | undefined;
  const ensureOurBackup = async (): Promise<boolean> => {
    if (!d.on || !d.deferred || added || closed) return true;
    if (!d.deviceActive()) return false;
    const deviceSik = d.device()?.getSettings().storageIdentityKey;
    if (!deviceSik) return false;
    const key = `${d.markKey}|${deviceSik}`;
    // Another init's check is running: wait for it, then act on its record in this session (attach here, or carry on
    // a repair it left pending). Its counts are not read again.
    const running = checksInFlight.get(key);
    if (running) {
      await running.catch(() => undefined);
      return ensureOurBackup();
    }
    const run: Promise<boolean> = runCheck(deviceSik).finally(() => {
      if (checksInFlight.get(key) === run) checksInFlight.delete(key);
    });
    checksInFlight.set(key, run);
    ownCheck = { key, run };
    return run;
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
        withLock: pageLock,
        spends: d.spends,
        onPhase: (p) => void (lean = p === 'lean'),
        log,
      });
      if (!r.used) return { used: false };
      log(`[spendable-first] restored from our server's snapshot (backup ${remoteUrl} stays the history source)`);
      hook();
      // A new restore point (and maybe a new device store): an earlier unfinished fill doesn't carry on.
      await saveFill(null);
      await saveMark({ stage: 'full', after: 0, at: Date.now(), restoredAt });
      void runFull();
      // Our server becomes a saved backup only once its first fill is done (background addSnapshotRemote).
      return { used: true, remotes: [] };
    },
    /** At open: hook the BEEF builder and carry on an unfinished background snapshot. */
    resume: async () => {
      if (!d.on) return;
      // State kept while our server is one of this session's backups is stale (a closed session's late write): dropped.
      // Never while a repair is pending: our server is then left out of the session, and the repair's state stays.
      const read = await loadFill();
      let pending = true;
      try {
        const r = (await d.kv.get(checkKey))?.[checkKey] as OurBackupCheckRecord | null | undefined;
        pending = r?.check === 'repair-pending';
      } catch {
        // can't tell: keep the state
      }
      if (read.ok && read.state && registered() && !pending) await saveFill(null);
      mark = await loadMark();
      if (mark?.stage !== 'full') return;
      hook();
      void runFull();
    },
    addOurBackup,
    ensureOurBackup,
    ourBackup,
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
        active: () => d.on && (lean || mark !== null),
        verifiedOnly: async (pay) => {
          const dev = d.device();
          if (!dev) return { ok: true as const, value: await pay(), setAside: 0 };
          const { user } = await dev.findOrInsertUser(await d.identityKey());
          // Between snapshot pages: no page's merge or hold lands while coins are set aside.
          return serial(() => payFromVerifiedOnly(dev, user.userId, pay));
        },
        log,
      }),
    /** The card's "Loading older history…" and the hidden move notice: the snapshot is still coming in. */
    loading: () => d.on && (lean || mark?.stage === 'full'),
    leanRunning: () => d.on && lean,
    /** Tests and close. */
    /**
     * Close (and tests): the session's in-flight fill of our server ends before its next page, and nothing this
     * session does writes the kept fill state again (the next session may have written it already).
     */
    stop: () => {
      closed = true;
      if (ownCheck && checksInFlight.get(ownCheck.key) === ownCheck.run) checksInFlight.delete(ownCheck.key);
      unhook?.();
      unhook = undefined;
    },
  };
}
