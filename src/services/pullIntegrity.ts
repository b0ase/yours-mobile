/**
 * A device-sync pull can't half-arrive (balance integrity plan, fix 3; owner's phone, Nov 2026).
 *
 * What happened: the phone's incremental pull merged two completed transactions from the backup WITHOUT their output
 * rows (one also without its proof link), so two BRC-29 change coins were missing until "Find missing coins" copied them
 * from the backup. Change can only be spent with the derivation stored on its output row.
 *
 * Why it can happen (the toolbox's sync, @bsv/wallet-toolbox-client getSyncChunk / EntitySyncState.processSyncChunk):
 *  - A page is atomic (its rows and the checkpoint commit in one IndexedDB transaction, StorageIdb.transaction), but a
 *    transaction and its outputs are NOT in one page: a pass sends every changed transaction before any output (entity
 *    order provenTx, basket, tag, label, transaction, output, ...), so the boundary between them is a page boundary in
 *    every pass with more than one page.
 *  - Each entity is filtered on its own `updated_at >= since`. A transaction updated after the cursor (mined →
 *    completed, its proof linked) is sent; its outputs, untouched since they were written, are not. That is harmless when
 *    this device already holds them, and leaves the transaction here without them when it doesn't: rows another copy
 *    pushed late with older times (the 6 Nov incident), or a pass that would have brought them stopping part-way and
 *    being reset (fullPass abandonPass / abandonTail, the inbound guard's unfiled rewinds all reset the offsets).
 *  - The toolbox maps a transaction's proof id through the sync map; a proof row not sent in this pass maps to nothing
 *    and the link is dropped silently (EntityTransaction.mergeNew / mappedProvenTxId).
 *  - Nothing noticed: the inbound guard refuses the reverse (outputs whose transaction is unknown, unfiledTransactions),
 *    but a transaction with no outputs looks complete.
 * Per-transaction atomicity inside the toolbox's paging isn't possible (outputs can be pages, or passes, after their
 * transaction). So the pull heals itself instead:
 *  1. Every page notes the transactions it brings that are new to this device (noteAwaiting, from the inbound guard).
 *  2. After every pull that caught up (no pass under way), each noted transaction is checked (afterPull): complete when
 *     this device holds a row for every output of its raw transaction, else compared with the backup's own rows for it
 *     (findOutputsAuth by the backup's transaction id). A daily scan adds transactions from the backup that have no
 *     outputs here at all (damage from before this check existed).
 *  3. Coins the backup holds and this device lacks: a heal pass, the cursor moved back to just before the oldest missing
 *     row's time (fullPass rewindHeal), carried by the device-sync pulls in slices like any pass, through the inbound
 *     check like any row (new coins arrive not spendable and are admitted by the chain check). A pass that stops
 *     part-way resumes from its checkpoint; one reset or given up is caught by the next check. After MAX_HEAL_TRIES
 *     heals the backup is pulled from the start (due 'incomplete', at most one per 24 h); a full pass from the start
 *     that completes clears the list (it read every row the backup has).
 * syncHealth (services/syncHealth.ts) shows what is still missing.
 */
import { Transaction } from '@bsv/sdk';
import {
  markOf,
  passFromStart,
  passUnderWay,
  rewindHeal,
  syncStateFor,
  updateMark,
  type AwaitOutputs,
  type FullPassMark,
  type SyncStateRow,
  type SyncStateStore,
} from './fullPass';

const HOUR = 3_600_000;
/** Heal passes per transaction before the backup is pulled from the start. */
export const MAX_HEAL_TRIES = 2;
/** Transactions checked per pull (each may be one backup request). */
export const CHECK_LIMIT = 25;
/** After an unclear answer from the backup: asked again this much later. */
export const UNCLEAR_RETRY_MS = 15 * 60_000;
/** Once heals have run out (a full pass is due): asked again this often, not on every pull. */
export const GIVEN_UP_RETRY_MS = 6 * HOUR;
/** The scan for transactions with no outputs at all. */
export const SCAN_EVERY_MS = 24 * HOUR;
/** At most this many transactions noted (the weekly full pass covers anything beyond). */
export const MAX_AWAITING = 5_000;
const MAX_EMPTY_OK = 500;
/** A caught-up pull is recorded at most this often when nothing else changed. */
export const PULL_OK_WRITE_MS = 60_000;
/** Each backup request in the check gets at most this long. */
export const BACKUP_CALL_MS = 10_000;
/**
 * The whole check gets this long (then the rest waits for the next pull): it runs inside the device-sync run, before
 * the push a Store payment's backup-before-send waits for.
 */
export const CHECK_BUDGET_MS = 8_000;

type TxRow = { transactionId?: number; txid?: string | null; rawTx?: ArrayLike<number> | null; status?: string };
type OutRow = { vout: number; updated_at?: unknown };
export type IntegrityStore = SyncStateStore & {
  findTransactions(a: { partial: Record<string, unknown>; noRawTx?: boolean }): Promise<TxRow[]>;
  findOutputs(a: { partial: Record<string, unknown>; noScript?: boolean }): Promise<OutRow[]>;
};

const parseMap = (raw: unknown): Record<string, { idMap?: Record<string, number> }> => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as never;
  try {
    return JSON.parse(String(raw)) as never;
  } catch {
    return {};
  }
};
const idMapOf = (row: SyncStateRow | undefined, entity: string): Record<string, number> =>
  parseMap(row?.syncMap)?.[entity]?.idMap ?? {};

/** A deep, full, tail or heal pass is under way, or one is set to start: no check, no new heal now. */
export const passBusy = (row: SyncStateRow | undefined): boolean => {
  if (!row || typeof row.syncStateId !== 'number') return true;
  const m = markOf(row);
  return (
    passFromStart(row) ||
    passUnderWay(row) ||
    typeof m.startedAt === 'number' ||
    typeof m.deepStartedAt === 'number' ||
    typeof m.healStartedAt === 'number' ||
    typeof m.tailStartedAt === 'number'
  );
};

/**
 * The inbound guard, after a page merged: the backup transaction ids on it that were new to this device are noted, to be
 * checked for their coins once the pass has caught up. Never throws into the sync (logged).
 */
export async function noteAwaiting(
  store: SyncStateStore,
  row: SyncStateRow | undefined,
  backupTxIds: number[],
  now = Date.now(),
): Promise<void> {
  if (!row || typeof row.syncStateId !== 'number' || !backupTxIds.length) return;
  const mark = markOf(row);
  const awaiting: Record<string, AwaitOutputs> = { ...(mark.awaitOutputs ?? {}) };
  const empty = new Set(mark.emptyOk ?? []);
  let added = 0;
  for (const id of backupTxIds) {
    const k = String(id);
    if (awaiting[k] || empty.has(id)) continue;
    if (Object.keys(awaiting).length >= MAX_AWAITING) break;
    awaiting[k] = { at: now };
    added++;
  }
  if (added) await updateMark(store, row, { awaitOutputs: awaiting });
}

export type IntegrityPlan =
  /** A pass is under way (or set to start): checked when it has caught up. */
  | 'busy'
  /** Nothing waiting. */
  | 'none'
  /** Everything checked is complete (or waits for a later check). */
  | 'ok'
  /** A heal pass was started: the next pull brings the missing coins. */
  | 'healing'
  /** Missing coins newer than the cursor: the next incremental pull brings them. */
  | 'waiting'
  /** Heals ran out: a full pass from the start is asked for (when the 24 h limit allows). */
  | 'full-due';

export type IntegrityReport = {
  plan: IntegrityPlan;
  /** This pull caught up with the backup (no pass under way). */
  caughtUp: boolean;
  /** The last pull that caught up (ms), as recorded. */
  pullOkAt?: number;
  checked: number;
  resolved: number;
  /** Transactions found missing coins at this check. */
  missingTx: number;
  /** Coins (output rows) they lack. */
  missingOutputs: number;
  /** Transactions still noted; of those, how many lacked coins at their last check, and how many ran out of heals. */
  awaiting: number;
  knownMissing: number;
  givenUp: number;
};

export type AfterPull = {
  manager: { runAsSync<T>(fn: (sync: unknown) => Promise<T>): Promise<T> };
  store: IntegrityStore;
  identityKey: string;
  /** The backup's storage identity key. */
  readerSik: string;
  /** The backup's output rows for one of its transactions (its own id): vout and updated_at, scripts not needed. */
  backupOutputs: (backupTxId: number) => Promise<OutRow[]>;
  now?: number;
  limit?: number;
  /** The check's time budget (ms, wall clock); CHECK_BUDGET_MS by default. */
  budgetMs?: number;
  /** Stop checking now (an own payment is waiting: services/ownPayments.ts); the rest waits for the next pull. */
  stop?: () => boolean;
  log?: (m: string) => void;
};

const time = (d: unknown): number => (d instanceof Date ? d.getTime() : new Date(String(d)).getTime());

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error('network: the backup did not answer in time (findOutputsAuth)')), ms);
    }),
  ]).finally(() => clearTimeout(t));
};

/** How many outputs the raw transaction has (undefined when there are no bytes to read). */
const outputCount = (raw: ArrayLike<number> | null | undefined): number | undefined => {
  if (!raw || !raw.length) return undefined;
  try {
    return Transaction.fromBinary(Array.from(raw)).outputs.length;
  } catch {
    return undefined;
  }
};

type Verdict =
  | { kind: 'complete' }
  | { kind: 'drop' }
  | { kind: 'empty' }
  | { kind: 'unclear' }
  | { kind: 'missing'; count: number; oldest: number };

/**
 * After a device-sync pull (outside every storage lock; device reads and backup requests here, writes under the
 * manager's sync lock): record a pull that caught up, check the transactions waiting for their coins, and start a heal
 * pass for coins the backup holds and this device lacks. Never throws for a backup that doesn't answer (unclear: asked
 * again later).
 */
export async function afterPull(o: AfterPull): Promise<IntegrityReport> {
  const now = o.now ?? Date.now();
  const log = o.log ?? ((m: string) => console.warn(m));
  const report: IntegrityReport = {
    plan: 'none',
    caughtUp: false,
    checked: 0,
    resolved: 0,
    missingTx: 0,
    missingOutputs: 0,
    awaiting: 0,
    knownMissing: 0,
    givenUp: 0,
  };
  const count = (mark: FullPassMark) => {
    const a = Object.values(mark.awaitOutputs ?? {});
    report.awaiting = a.length;
    report.knownMissing = a.filter((e) => (e.missing ?? 0) > 0).length;
    report.givenUp = a.filter((e) => (e.tries ?? 0) > MAX_HEAL_TRIES).length;
  };
  const row0 = await o.manager.runAsSync(() => syncStateFor(o.store, o.identityKey, o.readerSik));
  const mark0 = markOf(row0);
  report.pullOkAt = mark0.pullOkAt;
  count(mark0);
  if (passBusy(row0)) return { ...report, plan: 'busy' };
  report.caughtUp = true;

  const user = (await o.store.findUsers({ partial: { identityKey: o.identityKey } }))[0];
  if (!user) return report;
  const userId = user.userId;
  const txMap = idMapOf(row0, 'transaction'); // backup id → device id
  const awaiting: Record<string, AwaitOutputs> = { ...(mark0.awaitOutputs ?? {}) };
  const emptyOk = new Set(mark0.emptyOk ?? []);

  // Damage from before this check: transactions from the backup with no outputs here at all (daily).
  let scanned = false;
  if (typeof mark0.scanAt !== 'number' || now - mark0.scanAt >= SCAN_EVERY_MS) {
    scanned = true;
    const withOutputs = new Set<number>();
    for (const r of (await o.store.findOutputs({ partial: { userId }, noScript: true })) as {
      transactionId?: number;
    }[])
      if (typeof r.transactionId === 'number') withOutputs.add(r.transactionId);
    for (const [backupId, deviceId] of Object.entries(txMap)) {
      if (Object.keys(awaiting).length >= MAX_AWAITING) break;
      if (withOutputs.has(deviceId) || awaiting[backupId] || emptyOk.has(Number(backupId))) continue;
      awaiting[backupId] = { at: now };
    }
  }

  const due = Object.entries(awaiting)
    .filter(([, e]) => (e.nextAt ?? 0) <= now)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, o.limit ?? CHECK_LIMIT);
  const verdicts = new Map<string, Verdict>();
  const t0 = Date.now();
  const budget = o.budgetMs ?? CHECK_BUDGET_MS;
  for (const [backupId] of due) {
    const left = budget - (Date.now() - t0);
    if (left <= 0 || o.stop?.()) break; // the rest at the next pull
    report.checked++;
    const deviceId = txMap[backupId];
    if (typeof deviceId !== 'number') {
      // Its page never merged (the guard refuses outputs whose transaction is unknown, so none are stranded).
      verdicts.set(backupId, { kind: 'drop' });
      continue;
    }
    const tx = (await o.store.findTransactions({ partial: { userId, transactionId: deviceId } }))[0];
    if (!tx) {
      verdicts.set(backupId, { kind: 'drop' }); // purged here
      continue;
    }
    const have = new Set(
      (await o.store.findOutputs({ partial: { userId, transactionId: deviceId }, noScript: true })).map((r) => r.vout),
    );
    const n = outputCount(tx.rawTx);
    if (n !== undefined && n > 0 && have.size >= n && [...Array(n).keys()].every((v) => have.has(v))) {
      verdicts.set(backupId, { kind: 'complete' }); // a row for every output: nothing can be missing
      continue;
    }
    let theirs: OutRow[];
    try {
      theirs = await withTimeout(o.backupOutputs(Number(backupId)), Math.max(1_000, Math.min(BACKUP_CALL_MS, left)));
    } catch (e) {
      log(`[sync-integrity] the backup couldn't say which coins payment ${tx.txid ?? backupId} has: ${String(e)}`);
      verdicts.set(backupId, { kind: 'unclear' });
      continue;
    }
    const lacking = theirs.filter((r) => typeof r.vout === 'number' && !have.has(r.vout));
    if (!theirs.length && !have.size) verdicts.set(backupId, { kind: 'empty' });
    else if (!lacking.length) verdicts.set(backupId, { kind: 'complete' });
    else {
      const times = lacking.map((r) => time(r.updated_at)).filter((t) => Number.isFinite(t));
      // A time that can't be read: the whole history is the only safe place to start from.
      const oldest = times.length === lacking.length ? Math.min(...times) : 0;
      verdicts.set(backupId, { kind: 'missing', count: lacking.length, oldest });
      log(
        `[sync-integrity] payment ${tx.txid ?? `backup transaction ${backupId}`} arrived without ${lacking.length} of its coins (output ${lacking
          .map((r) => r.vout)
          .join(', ')}): pulling them again`,
      );
    }
  }

  return o.manager.runAsSync(async () => {
    const row = await syncStateFor(o.store, o.identityKey, o.readerSik);
    if (passBusy(row)) {
      report.caughtUp = false;
      return { ...report, plan: 'busy' as const };
    }
    const mark = markOf(row);
    // Merges since the reads above may have noted more: start from what is stored now, add the scan's.
    const next: Record<string, AwaitOutputs> = { ...(mark.awaitOutputs ?? {}) };
    for (const [k, e] of Object.entries(awaiting)) if (!next[k] && !verdicts.has(k)) next[k] = e;
    const empty = new Set(mark.emptyOk ?? []);
    let oldest = Infinity;
    let healable = 0;
    let exhausted = false;
    for (const [k, v] of verdicts) {
      const e = next[k] ?? awaiting[k] ?? { at: now };
      if (v.kind === 'complete' || v.kind === 'drop') {
        delete next[k];
        report.resolved++;
      } else if (v.kind === 'empty') {
        delete next[k];
        empty.add(Number(k));
        report.resolved++;
      } else if (v.kind === 'unclear') {
        next[k] = { ...e, nextAt: now + UNCLEAR_RETRY_MS };
      } else {
        report.missingTx++;
        report.missingOutputs += v.count;
        const tries = (e.tries ?? 0) + 1;
        if (tries <= MAX_HEAL_TRIES) {
          healable++;
          oldest = Math.min(oldest, v.oldest);
          next[k] = { ...e, tries, missing: v.count, nextAt: undefined };
        } else {
          exhausted = true;
          next[k] = { ...e, tries, missing: v.count, nextAt: now + GIVEN_UP_RETRY_MS };
        }
      }
    }
    const patch: FullPassMark = {
      awaitOutputs: Object.keys(next).length ? next : undefined,
      emptyOk: empty.size ? [...empty].slice(-MAX_EMPTY_OK) : undefined,
      pullOkAt: now,
      ...(scanned ? { scanAt: now } : {}),
    };
    if (exhausted && mark.due === undefined) patch.due = 'incomplete';
    // Nothing changed and the last caught-up pull was recorded a moment ago: no write (one per pull adds up).
    const quiet =
      !verdicts.size &&
      !scanned &&
      typeof mark.pullOkAt === 'number' &&
      now - mark.pullOkAt < PULL_OK_WRITE_MS &&
      Object.keys(next).length === Object.keys(mark.awaitOutputs ?? {}).length;
    count({ awaitOutputs: next });
    report.pullOkAt = now;
    const when = row!.when == null ? undefined : new Date(row!.when as string | Date).getTime();
    if (healable && when !== undefined && oldest < when) {
      // The cursor back to just before the oldest missing row (the pull's own 15-minute overlap adds a margin).
      await rewindHeal(o.store, row!, oldest, now, patch);
      return { ...report, plan: 'healing' as const };
    }
    if (quiet) report.pullOkAt = mark.pullOkAt;
    else await updateMark(o.store, row!, patch);
    if (healable) return { ...report, plan: 'waiting' as const };
    if (exhausted) return { ...report, plan: 'full-due' as const };
    return { ...report, plan: verdicts.size || report.awaiting ? ('ok' as const) : ('none' as const) };
  });
}
