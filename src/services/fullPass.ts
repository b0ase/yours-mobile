/**
 * Re-pulls from the backup beyond the incremental cursor (CEO, 6 Nov 2026; review 23 and its re-check). Every row still
 * goes through the inbound check (services/inboundSync.ts) as on any pull.
 *
 * Why: the toolbox pulls from a time cursor and rows carry the clock of the copy that wrote them, so a row another copy
 * pushed late (with an older time) is never sent (the 6 Nov incident). A row never touched again would stay missing.
 *
 * The schedule (requestFullPass, on every device-sync pull and heal; never restarting a pass under way):
 *  - every pull: from PULL_OVERLAP_MS (15 min) before the cursor;
 *  - daily: a deep pull, from DEEP_OVERLAP_MS (48 h) before it (the cursor itself moved back for one pass);
 *  - weekly: a true full pass from the start, on Wi-Fi only on a phone (the web wallet and the extension: any network).
 *    A phone off Wi-Fi (or on a network it can't tell) for 14 days runs it once on mobile data, with a one-line notice
 *    of its size. The first one after this release waits a random 0-72 h (spreading the load on wallet.1sat.app); a
 *    fresh install or a restore pulls from the start at once anyway;
 *  - on demand: a page the device couldn't file, or a failed heal merge: a full pass, at most one per 24 h from errors
 *    (persisted), on any network.
 * An unfiled page escalates: an incremental pass rewinds to the deep pull, a deep pass to a full one (if the 24 h
 * allows), a full pass stops (UNFILED_PAGE; the backup can't send that transaction) and waits 24 h.
 * How:
 *  - The marks live in this device store's sync state for that backup (its syncMap), never in localStorage.
 *  - A pass resumes from the toolbox's own checkpoint (offsets and cursor, written after every page).
 *  - It never blocks sending (review 23, M2): a device-sync pull runs in slices of FULL_PASS_SLICE_MS and asks for the
 *    next slice FULL_PASS_NEXT_SLICE_MS later; every backup request in it has a deadline (withDeadlines). A heal, and
 *    any merge with no mode (the factory's merge at open: re-check N2), leaves a deep or full pass we started to the
 *    pulls. An explicit restore (asRestore) runs as before.
 *  - It is the normal sync with its cursor moved: it can't run beside another sync (the manager's lock, deviceSync's
 *    one-at-a-time), and a failure is a failed pull like any other: deviceSync retries it on its back-off, which
 *    resumes it and never starts a new one. It never sets a backup aside on its own.
 */
import { EntitySyncState } from '@bsv/wallet-toolbox-client';
import { ownPayments, type OwnPaymentGate } from './ownPayments';

const HOUR = 3_600_000;
/** A true full pass, weekly (review 23 re-check: the cost schedule). */
export const FULL_PASS_EVERY_MS = 7 * 24 * HOUR;
/**
 * A phone that hasn't been on Wi-Fi (or whose network can't be told) for this long: the weekly full pass runs once on
 * mobile data, with a one-line notice (CEO, 6 Nov 2026).
 */
export const FULL_PASS_NO_WIFI_MS = 14 * 24 * HOUR;
/** The notice's size estimate: a coin's row, and a transaction's row with its proof and proof request. */
const OUTPUT_BYTES = 2_000;
const TRANSACTION_BYTES = 60_000;
/** The daily deep pull, from this far before the cursor. */
export const DEEP_PULL_EVERY_MS = 24 * HOUR;
export const DEEP_OVERLAP_MS = 48 * HOUR;
/** Full passes asked for by errors (an unfiled page, a failed heal): at most one per this long. */
export const ON_DEMAND_GAP_MS = 24 * HOUR;
/** The first full pass after this release: a random delay up to this. */
export const FIRST_PASS_SPREAD_MS = 72 * HOUR;
export const FULL_PASS_SLICE_MS = 3_000;
export const FULL_PASS_NEXT_SLICE_MS = 2_000;
/**
 * An incremental pull asks from this long before the newest time it has seen (review 23, M1): a row another copy
 * pushed late (the Monitor's 5-minute BackupSync, the 20 s push debounce) still comes, at the cost of rows this device
 * holds coming again as no-ops. A later row than that is the daily full pass's to bring.
 */
export const PULL_OVERLAP_MS = 15 * 60_000;
let overlapMs = PULL_OVERLAP_MS;
/** A pull's cursor with the overlap: undefined stays undefined (a pass from the start). */
export const overlapped = (since: Date | string | undefined): Date | undefined =>
  since == null ? undefined : new Date(new Date(since).getTime() - overlapMs);
/** Test hook: the overlap (ms); no argument restores the default. */
export const _setPullOverlap = (ms?: number) => void (overlapMs = ms ?? PULL_OVERLAP_MS);

export type FullPassMark = {
  /** A pass from the start we started (ms). Cleared when it completes. */
  startedAt?: number;
  /** The last pass from the start that completed (ms). */
  doneAt?: number;
  /** A deep pull we started (the cursor moved back DEEP_OVERLAP_MS). Cleared when it completes. */
  deepStartedAt?: number;
  /** The last deep pull (or full pass) that completed (ms). */
  deepDoneAt?: number;
  /** The last full pass asked for by an error, or the last full pass that met an unfiled row (ms): the 24 h limit. */
  onDemandAt?: number;
  /** Asked for by a failure: a full pass when the 24 h limit allows. */
  due?: 'unfiled' | 'failed';
  /** An install that synced before this release: its first full pass is not before this (ms). */
  firstAt?: number;
  /** The last request made on Wi-Fi (ms), at most hourly: a phone off Wi-Fi 14 days runs one pass on mobile data. */
  wifiAt?: number;
};

export type SyncStateRow = { syncStateId?: number; when?: unknown; syncMap?: unknown };
export type SyncStateStore = {
  findUsers(a: { partial: { identityKey: string } }): Promise<{ userId: number }[]>;
  findSyncStates(a: { partial: { storageIdentityKey: string; userId: number } }): Promise<unknown[]>;
};

const MARK = 'bwxFullPass';

const parse = (raw: unknown): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

export const markOf = (row: SyncStateRow | undefined): FullPassMark =>
  ((parse(row?.syncMap)?.[MARK] as FullPassMark | undefined) ?? {}) as FullPassMark;

/** This device's sync state for that backup, if it has one: by its id when the caller has it (the toolbox's own). */
export async function syncStateFor(
  store: SyncStateStore,
  identityKey: string | undefined,
  readerSik: string | undefined,
  syncStateId?: number,
): Promise<SyncStateRow | undefined> {
  if (!identityKey || !readerSik) return undefined;
  const user = (await store.findUsers({ partial: { identityKey } }))[0];
  if (!user) return undefined;
  const partial: Record<string, unknown> = { storageIdentityKey: readerSik, userId: user.userId };
  if (typeof syncStateId === 'number') partial.syncStateId = syncStateId;
  return (await store.findSyncStates({ partial } as never))[0] as SyncStateRow | undefined;
}

const write = async (store: SyncStateStore, row: SyncStateRow, f: (ss: EntitySyncState) => void) => {
  const ss = new EntitySyncState(row as never);
  f(ss);
  await ss.updateStorage(store as never, false);
};
const setMark = (ss: EntitySyncState, mark: FullPassMark) => {
  const clean = Object.fromEntries(Object.entries(mark).filter(([, v]) => v !== undefined));
  (ss.syncMap as unknown as Record<string, unknown>)[MARK] = clean;
};

/** Change the mark on this sync state row (as just read). */
export const updateMark = (store: SyncStateStore, row: SyncStateRow, patch: FullPassMark) =>
  write(store, row, (ss) => setMark(ss, { ...markOf(row), ...patch }));

const resetCounts = (ss: EntitySyncState) => {
  for (const m of Object.values(ss.syncMap as unknown as Record<string, unknown>))
    if (m && typeof m === 'object' && 'count' in m) (m as { count: number }).count = 0;
};

/** Start the next pass at the beginning: no time cursor, every offset 0, the id maps kept; marked as ours. */
export const rewind = (store: SyncStateStore, row: SyncStateRow, now = Date.now(), patch: FullPassMark = {}) =>
  write(store, row, (ss) => {
    ss.when = undefined;
    resetCounts(ss);
    setMark(ss, { ...markOf(row), deepStartedAt: undefined, ...patch, startedAt: now, due: undefined });
  });

/**
 * Start the next pass DEEP_OVERLAP_MS before the cursor: offsets 0, the id maps kept, marked as ours. The toolbox sets
 * the cursor back to the newest time it has ever seen when the pass completes, so this moves it back for one pass only.
 */
export const rewindDeep = (store: SyncStateStore, row: SyncStateRow, now = Date.now()) =>
  write(store, row, (ss) => {
    const when = row.when == null ? undefined : new Date(row.when as string | Date).getTime();
    ss.when = when === undefined ? undefined : new Date(when - DEEP_OVERLAP_MS);
    resetCounts(ss);
    setMark(ss, { ...markOf(row), deepStartedAt: now });
  });

/** A pass from the start is under way (or the first one will be): the cursor is empty. */
export const passFromStart = (row: SyncStateRow | undefined) => !row || row.when == null;

/** A pass is part-way (some offset moved): never restarted by a retry, only resumed. */
export const passUnderWay = (row: SyncStateRow | undefined) => {
  const m = parse(row?.syncMap);
  return (
    !!m && Object.values(m).some((e) => !!e && typeof e === 'object' && ((e as { count?: number }).count ?? 0) > 0)
  );
};

/** May an error start a full pass now (at most one per ON_DEMAND_GAP_MS)? */
export const onDemandAllowed = (mark: FullPassMark, now = Date.now()) =>
  typeof mark.onDemandAt !== 'number' || now - mark.onDemandAt >= ON_DEMAND_GAP_MS;

export type FullPassRequest = {
  /** The storage manager: the rewind is written under its sync lock, between syncs. */
  manager: { runAsSync<T>(fn: (sync: unknown) => Promise<T>): Promise<T> };
  store: SyncStateStore;
  identityKey: string;
  /** The backup's storage identity key (whose sync state on this device is rewound). */
  readerSik: string;
  /** The last heal merge failed (on demand). */
  failed?: boolean;
  now?: number;
  /** On Wi-Fi (true), on another network (false), or unknown (undefined). */
  wifi?: () => Promise<boolean | undefined>;
  /** A phone (the Wi-Fi rule applies); the web wallet and the extension: false. */
  phone?: boolean;
  /** For the first pass's spread: [0, 1). */
  random?: () => number;
  /** A full pass is starting on mobile data (a phone off Wi-Fi 14 days): about this many MB. */
  onMobileData?: (mb: number) => void;
};

export type FullPassPlan = 'started' | 'deep' | 'resuming' | 'not-due';

/** About how many MB a full pass from this backup brings, from what this device holds. */
export async function fullPassMb(store: unknown, identityKey: string): Promise<number> {
  const s = store as {
    findUsers(a: { partial: { identityKey: string } }): Promise<{ userId: number }[]>;
    countOutputs?(a: { partial: { userId: number } }): Promise<number>;
    countTransactions?(a: { partial: { userId: number } }): Promise<number>;
  };
  const user = (await s.findUsers({ partial: { identityKey } }))[0];
  if (!user || !s.countOutputs || !s.countTransactions) return 0;
  const outputs = await s.countOutputs({ partial: { userId: user.userId } });
  const txs = await s.countTransactions({ partial: { userId: user.userId } });
  return Math.max(1, Math.round((outputs * OUTPUT_BYTES + txs * TRANSACTION_BYTES) / 1_048_576));
}

/**
 * Move this device's cursor for the backup back when the schedule says so (see the header), unless a pass is under
 * way: that one resumes from its checkpoint, whatever a retry asks. 'started': the next pull is a pass from the start;
 * 'deep': the next pull starts DEEP_OVERLAP_MS back.
 */
export async function requestFullPass(o: FullPassRequest): Promise<FullPassPlan> {
  const wifi = o.wifi ? await o.wifi().catch(() => undefined) : undefined;
  return o.manager.runAsSync(async () => {
    const now = o.now ?? Date.now();
    const row = await syncStateFor(o.store, o.identityKey, o.readerSik);
    if (!row || typeof row.syncStateId !== 'number') return 'resuming'; // never pulled: the first pull is one
    const mark = markOf(row);
    const onDemand = (mark.due !== undefined || o.failed === true) && onDemandAllowed(mark, now);
    if (passFromStart(row) || passUnderWay(row)) {
      // A pass under way is resumed, whatever a retry asks; unless it stopped at a row it can't file and the 24 h
      // limit allows one more pass from the start.
      if (mark.due === 'unfiled' && onDemand) {
        await rewind(o.store, row, now, { onDemandAt: now });
        return 'started';
      }
      return 'resuming';
    }
    if (onDemand) {
      await rewind(o.store, row, now, { onDemandAt: now });
      return 'started';
    }
    const fresh = () => syncStateFor(o.store, o.identityKey, o.readerSik).then((r) => r ?? row);
    // A phone remembers when it was last on Wi-Fi (at most an hourly write), and from when it has been off it.
    let wifiAt = mark.wifiAt;
    let firstAt = mark.firstAt;
    const patch: FullPassMark = {};
    if (o.phone && wifi === true && (wifiAt === undefined || now - wifiAt >= HOUR)) patch.wifiAt = wifiAt = now;
    const lastFull = typeof mark.doneAt === 'number' ? mark.doneAt : undefined;
    const fullDue = lastFull === undefined || now - lastFull >= FULL_PASS_EVERY_MS;
    if (fullDue && lastFull === undefined && firstAt === undefined)
      patch.firstAt = firstAt = now + Math.floor((o.random ?? Math.random)() * FIRST_PASS_SPREAD_MS);
    if (Object.keys(patch).length) await updateMark(o.store, row, patch);
    if (fullDue && !(lastFull === undefined && now < (firstAt ?? 0))) {
      const offWifiSince = Math.max(wifiAt ?? 0, lastFull ?? firstAt ?? now);
      const mobile = !!o.phone && wifi !== true;
      if (!mobile || now - offWifiSince >= FULL_PASS_NO_WIFI_MS) {
        if (mobile) o.onMobileData?.(await fullPassMb(o.store, o.identityKey).catch(() => 0));
        await rewind(o.store, await fresh(), now);
        return 'started';
      }
    }
    if (typeof mark.deepDoneAt !== 'number' || now - mark.deepDoneAt >= DEEP_PULL_EVERY_MS) {
      await rewindDeep(o.store, await fresh(), now);
      return 'deep';
    }
    return 'not-due';
  });
}

// ── how a merge into this device runs a pass we started ──

type Mode = 'slice' | 'defer';
const modes = new Map<string, Mode>();
const sliceStart = new Map<string, number>();
let restoring = 0;

/**
 * Run a sync with this device store in a mode: 'slice' (a device-sync pull: it ends after FULL_PASS_SLICE_MS and the
 * next slice is asked for) or 'defer' (a heal: the same, and a deep or full pass is left to the pulls). A merge with no
 * mode (the factory's at open, an import) also leaves a deep or full pass we started to the pulls (re-check N2).
 */
export async function withFullPassMode<T>(deviceSik: string | undefined, mode: Mode, fn: () => Promise<T>) {
  if (!deviceSik) return fn();
  const prev = modes.get(deviceSik);
  modes.set(deviceSik, mode);
  sliceStart.delete(deviceSik);
  try {
    return await fn();
  } finally {
    if (prev) modes.set(deviceSik, prev);
    else modes.delete(deviceSik);
    sliceStart.delete(deviceSik);
  }
}

/** An explicit restore (services/restoreFromRemote.ts): its merges run whole, as before, whatever pass is under way. */
export async function asRestore<T>(fn: () => Promise<T>): Promise<T> {
  restoring++;
  try {
    return await fn();
  } finally {
    restoring--;
  }
}

export type PageKind = {
  /** A pass from the start (no cursor). */
  fromStart: boolean;
  /** A deep or full pass this device started (its marks): the pulls' to carry. */
  ours: boolean;
};

/** For the guard, before a page: 'stop' ends this sync here, the page not merged. A pull starts its slice's clock. */
export function beforePage(deviceSik: string, page: PageKind, now = Date.now()): 'stop' | 'go' {
  if (restoring > 0) return 'go';
  const mode = modes.get(deviceSik);
  if (mode === 'defer' && (page.fromStart || page.ours)) return 'stop';
  if (mode === undefined && page.ours) return 'stop';
  if (mode && !sliceStart.has(deviceSik)) sliceStart.set(deviceSik, now);
  return 'go';
}

/**
 * For the guard, after a merged page: 'yield' ends this sync (its slice is used up, or an own payment is waiting; the
 * checkpoint has the page). A device-sync pull ('slice') lets a payment from the wallet's own pages go first (owner's
 * seal, 7 Nov 2026: services/ownPayments.ts); the same device-sync run carries on once it has finished.
 *
 * ⚠ WHY A PULL MAY PAUSE MID-PASS WHEN A PUSH MAY NOT (review, 7 Nov 2026; services/pushView.ts). A checkpoint's
 * offsets index the READER's rows filtered by updated_at. A push reads this device's store, which the payment writes, so
 * a paused push cycle can skip a row. A pull reads the BACKUP: the payment writes only this device's store, and this
 * device's push can't run while the pull is paused (it comes after the pull in the same run, and a Store payment's
 * pushNow waits for the running run), so the pause changes nothing the pull's offsets index. Rows other devices push to
 * the backup can land between any two pages, paused or not (there is no lock across devices); those are what the
 * 3-second slices already live with and the 15-minute overlap (PULL_OVERLAP_MS) and the daily full pass bring in. The
 * merge keeps the newer updated_at, so the payment's own rows are not overwritten by older backup copies.
 */
export function afterPage(
  deviceSik: string,
  now = Date.now(),
  payments: Pick<OwnPaymentGate, 'waiting'> = ownPayments,
): 'yield' | 'go' {
  if (restoring > 0 || !modes.get(deviceSik)) return 'go';
  if (modes.get(deviceSik) === 'slice' && payments.waiting()) {
    paymentYieldCount++;
    return 'yield';
  }
  const start = sliceStart.get(deviceSik);
  return start !== undefined && now - start >= sliceMs ? 'yield' : 'go';
}

/** Pulls ended for an own payment so far: the device-sync pull compares it before and after to carry on at once. */
let paymentYieldCount = 0;
export const paymentYields = () => paymentYieldCount;

let sliceMs = FULL_PASS_SLICE_MS;
/** Test hook: the slice length (ms); no argument restores the default. */
export const _setFullPassSlice = (ms?: number) => void (sliceMs = ms ?? FULL_PASS_SLICE_MS);

// ── a deadline on the device-sync pull (review 23, M2) ──

/** Each backup request in a device-sync pull gets this long, and the whole pull this long (then requests fail at once). */
export const PULL_CALL_MS = 20_000;
export const PULL_TOTAL_MS = 45_000;
const READER_CALLS = new Set(['makeAvailable', 'getSyncChunk', 'getSyncCheckpoint', 'findOrInsertUser']);

/**
 * The backup as a device-sync pull reads it, with a deadline on each request: a backup that stops answering fails the
 * pull in seconds (and frees the storage locks) instead of holding every read and payment until fetch gives up. A view,
 * never a change to the connection itself (a heal may be arming its own deadlines on it).
 */
export function withDeadlines<T extends object>(reader: T, callMs = PULL_CALL_MS, totalMs = PULL_TOTAL_MS): T {
  const endsAt = Date.now() + totalMs;
  return new Proxy(reader, {
    get(target, p) {
      const v = Reflect.get(target, p, target) as unknown;
      if (typeof v !== 'function') return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (!READER_CALLS.has(String(p))) return fn.bind(target);
      return (...a: unknown[]) => {
        const ms = Math.max(0, Math.min(callMs, endsAt - Date.now()));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const call = Promise.resolve().then(() => fn.apply(target, a));
        call.catch(() => undefined);
        return Promise.race([
          call,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`network: the backup did not answer in time (${String(p)})`)),
              ms,
            );
          }),
        ]).finally(() => clearTimeout(timer));
      };
    },
  });
}
