/**
 * A bounded full re-pull from the backup (CEO, 6 Nov 2026): the sync state rewound to the start, every row through the
 * inbound check (services/inboundSync.ts) as on any pull.
 *
 * Why: the toolbox pulls from a time cursor and rows carry the clock of the copy that wrote them, so a row another copy
 * pushed late (with an older time) is never sent (the 6 Nov incident). A row that is never touched again would stay
 * missing for good; a pass from the start brings it.
 *
 * When (requestFullPass):
 *  (a) once a day: a pull (wallet open/unlock, "Sync with my other devices") when the last full pass is 24 h old;
 *  (b) after a failed heal merge, or a page the device couldn't file (UNFILED_PAGE), on the next heal;
 *  (c) on a store that has never finished one (a fresh install, a restore, the first open of this release).
 * How:
 *  - The mark lives in this device store's sync state for that backup (its syncMap, which the toolbox keeps as a whole),
 *    never in localStorage: { startedAt, doneAt, due }.
 *  - The pass resumes from the toolbox's own checkpoint (offsets and an empty cursor, written after every page).
 *  - It never blocks sending (review 23, M2): a device-sync pull runs in slices of FULL_PASS_SLICE_MS (each page under
 *    the toolbox's sync lock; the slice then ends the pull) and asks for the next slice FULL_PASS_NEXT_SLICE_MS later;
 *    every backup request in it has a deadline (withDeadlines). A heal never runs a pass from the start (its merge stops
 *    at the first such page, the pulls carry it on), so a heal stays short.
 *  - Between full passes an incremental pull starts PULL_OVERLAP_MS before its cursor (M1), for the common late push.
 *  - It is the normal sync with its cursor moved: it can't run beside another sync (the manager's lock, deviceSync's
 *    one-at-a-time), and a failure is a failed pull like any other: deviceSync retries it on its back-off. It never
 *    sets a backup aside on its own.
 */
import { EntitySyncState } from '@bsv/wallet-toolbox-client';

export const FULL_PASS_EVERY_MS = 24 * 3_600_000;
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
  /** Asked for by a failure: 'unfiled' restarts a pass in progress; 'failed' starts one if none is running. */
  due?: 'unfiled' | 'failed';
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

/** Start the next pass at the beginning: no time cursor, every offset 0, the id maps kept; marked as ours. */
export const rewind = (store: SyncStateStore, row: SyncStateRow, now = Date.now()) =>
  write(store, row, (ss) => {
    ss.when = undefined;
    for (const m of Object.values(ss.syncMap as unknown as Record<string, unknown>))
      if (m && typeof m === 'object' && 'count' in m) (m as { count: number }).count = 0;
    setMark(ss, { ...markOf(row), startedAt: now, due: undefined });
  });

/** A pass from the start is under way (or the first one will be): the cursor is empty. */
export const passFromStart = (row: SyncStateRow | undefined) => !row || row.when == null;

export type FullPassRequest = {
  /** The storage manager: the rewind is written under its sync lock, between syncs. */
  manager: { runAsSync<T>(fn: (sync: unknown) => Promise<T>): Promise<T> };
  store: SyncStateStore;
  identityKey: string;
  /** The backup's storage identity key (whose sync state on this device is rewound). */
  readerSik: string;
  /** The last heal merge failed (b). */
  failed?: boolean;
  now?: number;
};

/**
 * Rewind this device's sync state for the backup when a full pass is due ((a), (b), (c) above), unless one is under
 * way: that one resumes from its checkpoint. 'started': the next pull is a pass from the start.
 */
export function requestFullPass(o: FullPassRequest): Promise<'started' | 'resuming' | 'not-due'> {
  return o.manager.runAsSync(async () => {
    const now = o.now ?? Date.now();
    const row = await syncStateFor(o.store, o.identityKey, o.readerSik);
    if (!row || typeof row.syncStateId !== 'number') return 'resuming'; // never pulled: the first pull is one
    const mark = markOf(row);
    const due = mark.due ?? (o.failed ? 'failed' : undefined);
    if (passFromStart(row) && due !== 'unfiled') return 'resuming';
    const stale = typeof mark.doneAt !== 'number' || now - mark.doneAt >= FULL_PASS_EVERY_MS;
    if (!due && !stale) return 'not-due';
    await rewind(o.store, row, now);
    return 'started';
  });
}

// ── how a merge into this device runs a pass we started ──

type Mode = 'slice' | 'defer';
const modes = new Map<string, Mode>();
const sliceStart = new Map<string, number>();

/**
 * Run a sync with this device store in a mode: 'slice' (a device-sync pull: it ends after FULL_PASS_SLICE_MS and the
 * next slice is asked for) or 'defer' (a heal: the same for an incremental pass, and a pass from the start is left to
 * the pulls). Other merges (a restore, the factory's open, an import) run as before.
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

/**
 * For the guard, before a page: 'stop' ends this sync here, the page not merged. A heal stops at any page of a pass
 * from the start (it leaves those to the device-sync pulls); a pull starts its slice's clock.
 */
export function beforePage(deviceSik: string, fromStart: boolean, now = Date.now()): 'stop' | 'go' {
  const mode = modes.get(deviceSik);
  if (mode === 'defer' && fromStart) return 'stop';
  if (mode && !sliceStart.has(deviceSik)) sliceStart.set(deviceSik, now);
  return 'go';
}

/** For the guard, after a merged page: 'yield' ends this sync (its slice is used up; the checkpoint has the page). */
export function afterPage(deviceSik: string, now = Date.now()): 'yield' | 'go' {
  if (!modes.get(deviceSik)) return 'go';
  const start = sliceStart.get(deviceSik);
  return start !== undefined && now - start >= sliceMs ? 'yield' : 'go';
}

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
