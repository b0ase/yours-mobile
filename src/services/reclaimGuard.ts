/**
 * A BRC-177 reclaim posts only what this device armed itself (review round 3, F2).
 *
 * The toolbox's NoSendExpiry task posts a transaction's reclaim (insertReclaim → attemptToPostReqsToNetwork) once the
 * row says 'revocation-requested' and the anchor is unspent; its validateReclaim checks only the reclaim's shape. A page
 * that pointed the reclaim at a withheld payment itself made the task post that payment. Pages can no longer set these
 * fields (services/inboundSync.ts keepExpiryFields); this is the local check before any reclaim post: before each run
 * of the task, every transaction in a state the task acts on whose reclaim is not plainly this device's own is set
 * 'cancelled' (a state the task ignores), so nothing of it is posted. Its own means all of:
 *  - this device armed it (createAction with a BRC-177 expiry label: services/releaseMarks.ts `armed`);
 *  - the reclaim is another transaction than the payment, and its bytes are the reclaim txid's;
 *  - it spends exactly one input, the anchor, and that anchor is an output of this device's own store.
 */
import { Transaction } from '@bsv/sdk';

/** The states the toolbox's NoSendExpiry task acts on (noSendExpiryLifecycle ACTIVE_STATES). */
export const ACTIVE_EXPIRY_STATES = [
  'reclaiming',
  'broadcast',
  'conflicted',
  'revocation-requested',
  'signed',
  'unsigned',
  'preparing',
] as const;

type Bytes = ArrayLike<number>;
export type ExpiryRow = {
  transactionId: number;
  userId?: number;
  txid?: string | null;
  noSendExpiryState?: string | null;
  noSendExpiryAnchorTxid?: string | null;
  noSendExpiryAnchorVout?: number | null;
  noSendExpiryReclaimTxid?: string | null;
  noSendExpiryReclaimRawTx?: Bytes | null;
  updated_at?: Date | string;
};
/** States a createAction of this device's own passes through before it returns (and is armed). */
const IN_CREATION = new Set(['preparing', 'unsigned', 'signed']);
/** How long a row in one of those states is left alone: a createAction in progress is not marked armed yet. */
export const CREATION_GRACE_MS = 10 * 60_000;

/** Why a row's reclaim isn't this device's own, or undefined when it is (or it has none yet). */
export function foreignReclaim(
  t: ExpiryRow,
  o: { armed: (txid: string) => boolean; anchorIsOurs: boolean },
): string | undefined {
  const target = String(t.txid ?? '').toLowerCase();
  const hasReclaim = t.noSendExpiryReclaimTxid != null || t.noSendExpiryReclaimRawTx != null;
  if (!target || !o.armed(target)) return 'not armed on this device';
  if (!hasReclaim) return undefined;
  const reclaimTxid = String(t.noSendExpiryReclaimTxid ?? '').toLowerCase();
  if (!reclaimTxid || reclaimTxid === target) return 'the reclaim is the payment itself';
  let reclaim: Transaction;
  try {
    reclaim = Transaction.fromBinary(Array.from(t.noSendExpiryReclaimRawTx ?? []));
  } catch {
    return 'the reclaim bytes do not parse';
  }
  if (reclaim.id('hex') !== reclaimTxid) return 'the reclaim bytes are not the reclaim txid';
  const anchor = `${String(t.noSendExpiryAnchorTxid ?? '').toLowerCase()}.${t.noSendExpiryAnchorVout}`;
  const ins = reclaim.inputs.map(
    (i) => `${(i.sourceTXID ?? i.sourceTransaction?.id('hex') ?? '').toLowerCase()}.${i.sourceOutputIndex}`,
  );
  if (ins.length !== 1 || ins[0] !== anchor) return 'the reclaim spends something other than the anchor';
  if (anchor.split('.')[0] === target) return 'the anchor is an output of the payment itself';
  if (!o.anchorIsOurs) return 'the anchor is not an output of this device';
  return undefined;
}

export type ReclaimStore = {
  findTransactions(a: { partial: Record<string, unknown>; noRawTx?: boolean }): Promise<ExpiryRow[]>;
  findOutputs(a: { partial: Record<string, unknown>; noScript?: boolean }): Promise<unknown[]>;
  updateTransaction(id: number, update: Record<string, unknown>): Promise<unknown>;
};

/** Set every active row whose reclaim is not this device's own 'cancelled'. Returns the txids it stopped. */
export async function stopForeignReclaims(
  sp: ReclaimStore,
  armed: (txid: string) => boolean,
  log: (m: string) => void = (m) => console.warn(m),
  now: number = Date.now(),
): Promise<string[]> {
  const stopped: string[] = [];
  for (const state of ACTIVE_EXPIRY_STATES) {
    for (const t of await sp.findTransactions({ partial: { noSendExpiryState: state } })) {
      const at = t.updated_at ? new Date(t.updated_at).getTime() : NaN;
      if (IN_CREATION.has(state) && Number.isFinite(at) && now - at < CREATION_GRACE_MS) continue;
      const anchorIsOurs =
        !!t.noSendExpiryAnchorTxid &&
        typeof t.noSendExpiryAnchorVout === 'number' &&
        (
          await sp.findOutputs({
            partial: { txid: t.noSendExpiryAnchorTxid, vout: t.noSendExpiryAnchorVout },
            noScript: true,
          })
        ).length > 0;
      const why = foreignReclaim(t, { armed, anchorIsOurs });
      if (!why) continue;
      await sp.updateTransaction(t.transactionId, { noSendExpiryState: 'cancelled' });
      stopped.push(String(t.txid));
      log(`[reclaimGuard] stopped the expiry/reclaim of ${t.txid}: ${why}`);
    }
  }
  return stopped;
}

type MonitorLike = { _tasks?: { name: string; runTask: () => Promise<string> }[] };
type StorageLike = {
  isActiveStorageProvider?: () => boolean;
  runAsStorageProvider: <T>(f: (sp: ReclaimStore) => Promise<T>) => Promise<T>;
};
const GUARDED = Symbol.for('bwx.reclaimGuard');

/**
 * Run stopForeignReclaims before every run of the Monitor's NoSendExpiry task. A run whose check fails does not run
 * the task (nothing is posted). Idempotent; false when the monitor has no such task.
 */
export function guardReclaims(monitor: unknown, storage: StorageLike, armed: (txid: string) => boolean): boolean {
  const task = (monitor as MonitorLike | null)?._tasks?.find((t) => t.name === 'NoSendExpiry') as
    | ({ runTask: () => Promise<string> } & { [GUARDED]?: true })
    | undefined;
  if (!task) return false;
  if (task[GUARDED]) return true;
  const original = task.runTask.bind(task);
  task.runTask = async () => {
    if (storage.isActiveStorageProvider && !storage.isActiveStorageProvider()) return original();
    try {
      await storage.runAsStorageProvider((sp) => stopForeignReclaims(sp, armed));
    } catch (e) {
      console.warn('[reclaimGuard] check failed; the expiry task waits for the next run', e);
      return '';
    }
    return original();
  };
  task[GUARDED] = true;
  return true;
}
