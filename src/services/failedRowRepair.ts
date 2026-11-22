/**
 * One transaction held as 'failed' must not stop the sync (report #385, owner's iPhone, 21 and 22 Nov 2026):
 *   "Wallet sync failing: The tx parameter must be target transaction of internalizeAction has invalid status failed."
 *
 * The toolbox's internalizeAction refuses a transaction this device holds as 'failed' or 'invalid'
 * (InternalizeActionContext.loadExistingTransaction). A payment of ours that the broadcaster refused is stored failed,
 * its inputs released back to spendable, yet the network can still have it. Its output at one of our receive
 * addresses then shows up on chain, and every sync intake (the address sync's coins and names, the receive watcher,
 * the receive guard) tried to take it in and got that refusal on every run; the guard put it on Settings.
 *
 * The sync's wallet is wrapped (initWallet: the admin wallet) so that refusal is handled once, here:
 *  - The proof first: A's merkle proof (from the BEEF or the proof service) must verify against the chain tracker.
 *    No verified proof: nothing is written ('not-mined').
 *  - Then the coins A spent (review of fix/385, R1): a released coin may since have been spent again by another
 *    payment B of this wallet. With A's proof verified, B can never confirm. B (and anything spending B's outputs)
 *    goes through the toolbox's own double-spend path: its proven-tx request 'doubleSpend' (descendants 'invalid'),
 *    then storage.updateTransactionStatus('failed'), which releases B's inputs and makes B's outputs unspendable. The
 *    user is told B did not go through. A B the store holds as completed or proven can't be failed that way: nothing
 *    is written and A is held ('conflict').
 *  - Then the toolbox's own repair (a proven-tx request in 'unfail', TaskUnFail), which authenticates the proof again,
 *    sets A 'unproven', marks the coins it spent as spent and sets its outputs from the chain's UTXO answer. A
 *    'doubleSpend' marker on A's request that UnFail turns into 'invalid' (its second proof fetch failed) is put back.
 *    The internalize then runs once more.
 *  - This device's store not active, or no monitor: nothing is written ('unavailable').
 * Never sets a coin spendable on its own: only the toolbox does, from its UTXO check or its failed path.
 */
import {
  Beef,
  MerklePath,
  Transaction,
  type ChainTracker,
  type InternalizeActionArgs,
  type InternalizeActionResult,
} from '@bsv/sdk';
import { EntityProvenTxReq, StorageProvider } from '@bsv/wallet-toolbox-client';
import { HeldAsFailedError, type HeldReason } from './heldAsFailed';
export { HELD_AS_FAILED, HeldAsFailedError, isHeldAsFailed, type HeldReason } from './heldAsFailed';

/** The toolbox's refusal of a transaction storage holds as failed (or invalid). */
export const REFUSED_STATUS = /target transaction of internalizeAction has invalid status (failed|invalid)/i;

/** 'not-failed': storage no longer holds it failed (repaired elsewhere); never a licence to write it as settled. */
export type RepairResult = 'repaired' | 'not-failed' | Exclude<HeldReason, 'unrepaired'>;
export type RepairOutcome = { result: RepairResult; detail?: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ''));
const short = (txid?: string | null) => `${(txid ?? '').slice(0, 8)}…`;

export type FailedRowDeps = {
  /** Repair the failed row of `txid` if the network has mined it. `beef`: the AtomicBEEF being internalized. */
  repair: (txid: string, beef: Beef) => Promise<RepairOutcome>;
  log?: (msg: string) => void;
  /** A held answer is reused this long before the chain is asked again (default 10 minutes). */
  holdMs?: number;
  now?: () => number;
};

type Internalize = (args: InternalizeActionArgs, originator?: string) => Promise<InternalizeActionResult>;

/** `wallet` with internalizeAction repairing a failed row once (see the module doc); every other call unchanged. */
export function withFailedRowRepair<W extends { internalizeAction: Internalize }>(wallet: W, deps: FailedRowDeps): W {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const holdMs = deps.holdMs ?? 10 * 60 * 1000;
  const now = deps.now ?? Date.now;
  const held = new Map<string, { reason: HeldReason; detail?: string; until: number }>();
  const inFlight = new Map<string, Promise<RepairOutcome>>();

  const repairOnce = (txid: string, beef: Beef) => {
    let p = inFlight.get(txid);
    if (!p) {
      p = deps
        .repair(txid, beef)
        .catch((e: unknown): RepairOutcome => {
          log(`[failedRow] ${txid}: repair failed: ${messageOf(e)}`);
          return { result: 'unavailable' };
        })
        .finally(() => inFlight.delete(txid));
      inFlight.set(txid, p);
    }
    return p;
  };

  const internalize: Internalize = async (args, originator) => {
    const call = () => wallet.internalizeAction(args, originator);
    try {
      return await call();
    } catch (e) {
      if (!REFUSED_STATUS.test(messageOf(e))) throw e;
      let beef: Beef;
      let txid: string | undefined;
      try {
        beef = Beef.fromBinary(Array.from(args.tx));
        txid = beef.atomicTxid;
      } catch {
        throw e;
      }
      if (!txid) throw e;
      const h = held.get(txid);
      if (h && now() < h.until) throw new HeldAsFailedError(txid, h.reason, h.detail);
      const r = await repairOnce(txid, beef);
      if (r.result !== 'repaired' && r.result !== 'not-failed') {
        held.set(txid, { reason: r.result, detail: r.detail, until: now() + holdMs });
        log(`[failedRow] ${txid}: held as failed, left out (${r.result}${r.detail ? `: ${r.detail}` : ''})`);
        throw new HeldAsFailedError(txid, r.result, r.detail);
      }
      held.delete(txid);
      log(
        `[failedRow] ${txid}: ${r.result === 'repaired' ? 'mined; failed row repaired' : 'no longer failed'}, taking it in`,
      );
      try {
        return await call();
      } catch (e2) {
        if (!REFUSED_STATUS.test(messageOf(e2))) throw e2;
        held.set(txid, { reason: 'unrepaired', until: now() + holdMs });
        throw new HeldAsFailedError(txid, 'unrepaired');
      }
    }
  };

  return new Proxy(wallet, {
    get(target, prop, receiver) {
      if (prop === 'internalizeAction') return internalize;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Statuses internalizeAction merges into. */
const ACCEPTED = new Set(['completed', 'unproven', 'sending', 'nosend']);
const REFUSED = new Set(['failed', 'invalid']);

type TxRow = {
  transactionId: number;
  userId?: number;
  txid?: string | null;
  status: string;
  provenTxId?: number | null;
  satoshis?: number;
  isOutgoing?: boolean;
};
type OutRow = {
  outputId: number;
  transactionId: number;
  spentBy?: number | null;
  spendable?: boolean;
  satoshis?: number;
  change?: boolean;
  basketId?: number | null;
};
type ReqRow = { provenTxReqId: number; status: string; rawTx?: number[] | null };
type Trx = unknown;

/** The StorageProvider calls the repair makes (StorageIdb), all with an optional transaction token. */
export type RepairStore = {
  transaction<T>(fn: (trx: Trx) => Promise<T>, trx?: Trx): Promise<T>;
  findTransactions(args: {
    partial: { txid?: string; transactionId?: number; userId?: number };
    noRawTx?: boolean;
    trx?: Trx;
  }): Promise<TxRow[]>;
  findOutputs(args: {
    partial: { txid?: string; vout?: number; transactionId?: number; userId?: number };
    noScript?: boolean;
    trx?: Trx;
  }): Promise<OutRow[]>;
  findProvenTxReqs(args: { partial: { txid?: string; status?: string }; trx?: Trx }): Promise<ReqRow[]>;
  updateProvenTxReq(id: number, update: Record<string, unknown>, trx?: Trx): Promise<unknown>;
  insertProvenTxReq(req: unknown, trx?: Trx): Promise<number>;
  updateOutput(id: number, update: Record<string, unknown>, trx?: Trx): Promise<unknown>;
  updateTransactionStatus(
    status: 'failed',
    transactionId: number,
    userId?: number,
    reference?: string,
    trx?: Trx,
  ): Promise<void>;
  findOrInsertTxLabel(userId: number, label: string, trx?: Trx): Promise<{ txLabelId: number }>;
  findOrInsertTxLabelMap(transactionId: number, txLabelId: number, trx?: Trx): Promise<unknown>;
  findTxLabels(args: { partial: { label?: string }; trx?: Trx }): Promise<{ txLabelId: number }[]>;
  findTxLabelMaps(args: {
    partial: { txLabelId?: number; isDeleted?: boolean };
    trx?: Trx;
  }): Promise<{ transactionId: number; txLabelId: number; isDeleted?: boolean }[]>;
  updateTxLabelMap(
    transactionId: number,
    txLabelId: number,
    update: Record<string, unknown>,
    trx?: Trx,
  ): Promise<unknown>;
};

type UnfailTask = { name: string; unfail?: (reqs: unknown[], indent?: number) => Promise<{ log: string }> };

export type UnfailWiring = {
  storage: {
    isActiveStorageProvider(): boolean;
    runAsStorageProvider<T>(fn: (sp: RepairStore) => Promise<T>): Promise<T>;
  };
  monitor?: { chaintracks?: ChainTracker; _tasks?: UnfailTask[] } | null;
  services: { getMerklePath(txid: string): Promise<{ merklePath?: unknown } | undefined> };
  /** The chain tracker proofs are checked against (default: the monitor's, the one TaskUnFail uses). */
  chainTracker?: () => Promise<ChainTracker | undefined>;
  log?: (msg: string) => void;
};

const asMerklePath = (v: unknown): MerklePath | undefined => {
  if (v instanceof MerklePath) return v;
  try {
    if (typeof v === 'string') return MerklePath.fromHex(v);
    if (Array.isArray(v)) return MerklePath.fromBinary(v as number[]);
  } catch {
    /* not a proof */
  }
  return undefined;
};

/**
 * What the chain says of `txid`: 'mined' (a proof verified against the tracker, with its confirmations), 'none' (the
 * proof service answered with no proof: not mined as far as anyone knows) or 'unchecked' (no tracker, the service
 * failed, or a proof was rejected: nothing can be said yet).
 */
export type ProofCheck = { state: 'mined' | 'none' | 'unchecked'; confirmations: number };

export async function checkProof(
  txid: string,
  o: {
    bump?: MerklePath;
    getMerklePath: (txid: string) => Promise<{ merklePath?: unknown } | undefined>;
    tracker?: ChainTracker;
  },
): Promise<ProofCheck> {
  const tracker = o.tracker;
  if (!tracker) return { state: 'unchecked', confirmations: 0 };
  let rejected = false;
  const tryPath = async (mp: MerklePath | undefined) => {
    if (!mp) return 0;
    try {
      if (!(await mp.verify(txid, tracker))) {
        rejected = true;
        return 0;
      }
      return Math.max(1, (await tracker.currentHeight()) - mp.blockHeight + 1);
    } catch {
      rejected = true;
      return 0;
    }
  };
  const fromBeef = await tryPath(o.bump);
  if (fromBeef) return { state: 'mined', confirmations: fromBeef };
  let r: { merklePath?: unknown } | undefined;
  try {
    r = await o.getMerklePath(txid);
  } catch {
    return { state: 'unchecked', confirmations: 0 };
  }
  const mp = asMerklePath(r?.merklePath);
  if (!mp) return { state: rejected ? 'unchecked' : 'none', confirmations: 0 };
  const n = await tryPath(mp);
  return n ? { state: 'mined', confirmations: n } : { state: 'unchecked', confirmations: 0 };
}

/**
 * Confirmations A needs before a payment that spent the same coins is failed (CTO, 22 Nov 2026: one block can be
 * reorganised away; three settle it). Until then A is held and the next check finishes it.
 */
export const SETTLE_CONFIRMATIONS = 3;

type Victim = { row: TxRow; direct: boolean };
type Conflicts = { conflict?: string; victims: Victim[] };

/**
 * Other payments of this wallet that spend a coin `rawTx` spends, and everything spending their outputs (deepest
 * last). A completed or proven one is a conflict: the store says it confirmed, so nothing is decided here.
 */
export async function findConflicts(
  sp: RepairStore,
  ownIds: Set<number>,
  rawTx: number[],
  trx?: Trx,
): Promise<Conflicts> {
  const tx = Transaction.fromBinary(rawTx);
  const out: Conflicts = { victims: [] };
  const seen = new Set<number>(ownIds);
  const queue: { id: number; direct: boolean }[] = [];
  for (const input of tx.inputs) {
    if (!input.sourceTXID) continue;
    for (const o of await sp.findOutputs({
      partial: { txid: input.sourceTXID, vout: input.sourceOutputIndex },
      noScript: true,
      trx,
    }))
      if (o.spentBy != null && !seen.has(o.spentBy)) {
        seen.add(o.spentBy);
        queue.push({ id: o.spentBy, direct: true });
      }
  }
  while (queue.length) {
    const { id, direct } = queue.shift()!;
    const [row] = await sp.findTransactions({ partial: { transactionId: id }, noRawTx: true, trx });
    if (!row || row.status === 'failed') continue;
    if (row.status === 'completed' || row.provenTxId != null) {
      out.conflict = `${row.txid ?? `transaction ${id}`} (${row.status})`;
      return out;
    }
    out.victims.push({ row, direct });
    for (const o of await sp.findOutputs({ partial: { transactionId: id }, noScript: true, trx }))
      if (o.spentBy != null && !seen.has(o.spentBy)) {
        seen.add(o.spentBy);
        queue.push({ id: o.spentBy, direct: false });
      }
  }
  return out;
}

/** Labels that keep a "payment didn't go through" notice in the wallet's own store until it is shown. */
export const NOTICE_RESPENT = 'bwx notice: payment respent';
export const NOTICE_PARENT_FAILED = 'bwx notice: payment parent failed';
const isOutgoing = (row: TxRow) => !!row.isOutgoing || (row.satoshis ?? 0) < 0;

type Settled = { held?: 'conflict' | 'unconfirmed'; detail?: string; victims: Victim[] };

/** Why A is held while a payment that spent its coins waits for A's confirmations: names both. */
const unconfirmedDetail = (minedTxid: string, victims: Victim[], confirmations: number) => {
  const direct = victims.filter((v) => v.direct).map((v) => short(v.row.txid));
  return `your payment ${direct.join(', ')} spent the same coins; it is settled once ${short(minedTxid)} has ${SETTLE_CONFIRMATIONS} confirmations (it has ${confirmations})`;
};

/**
 * One storage transaction, so no payment can start in between (second review, 2): find what else spends A's coins;
 * a completed or proven one holds A ('conflict'); any at all with A under SETTLE_CONFIRMATIONS holds it too
 * ('unconfirmed'). Otherwise each, children first, goes through the toolbox's double-spend path: its proven-tx requests
 * 'doubleSpend' (it spent a coin A spent) or 'invalid' (it spent such a payment's outputs), with a history note, then
 * updateTransactionStatus('failed'), which releases its inputs and makes its outputs unspendable. Each failed payment
 * out gets its notice label in the same transaction (third review, 3: a crash can't lose it). Last, the coins A spent
 * that this wallet holds are marked spent (second review, 1): failing a payment releases its inputs, and they must not
 * read as spendable if UnFail can't finish. Their spentBy is left empty, as the toolbox does for a spend it did not
 * witness: pointing it at A, still failed, would let the Monitor's status review release them again.
 */
export async function settleInputs(
  sp: RepairStore,
  a: { ownIds: Set<number>; rawTx: number[]; minedTxid: string; confirmations: number },
): Promise<Settled> {
  return sp.transaction(async (trx) => {
    const found = await findConflicts(sp, a.ownIds, a.rawTx, trx);
    if (found.conflict) return { held: 'conflict', detail: found.conflict, victims: [] };
    if (found.victims.length && a.confirmations < SETTLE_CONFIRMATIONS)
      return {
        held: 'unconfirmed',
        detail: unconfirmedDetail(a.minedTxid, found.victims, a.confirmations),
        victims: found.victims,
      };
    for (const { row, direct } of [...found.victims].reverse()) {
      if (row.txid)
        for (const api of await sp.findProvenTxReqs({ partial: { txid: row.txid }, trx })) {
          const req = new EntityProvenTxReq(api as never);
          req.status = direct ? 'doubleSpend' : 'invalid';
          req.addHistoryNote({ what: 'bwxSpentByMined', minedTxid: a.minedTxid } as never);
          await req.updateStorageDynamicProperties(sp as never, trx as never);
        }
      await sp.updateTransactionStatus('failed', row.transactionId, undefined, undefined, trx);
      if (isOutgoing(row) && typeof row.userId === 'number') {
        const label = await sp.findOrInsertTxLabel(row.userId, direct ? NOTICE_RESPENT : NOTICE_PARENT_FAILED, trx);
        await sp.findOrInsertTxLabelMap(row.transactionId, label.txLabelId, trx);
      }
    }
    for (const input of Transaction.fromBinary(a.rawTx).inputs) {
      if (!input.sourceTXID) continue;
      for (const o of await sp.findOutputs({
        partial: { txid: input.sourceTXID, vout: input.sourceOutputIndex },
        noScript: true,
        trx,
      }))
        if (o.spendable || o.spentBy != null)
          await sp.updateOutput(o.outputId, { spendable: false, spentBy: undefined }, trx);
    }
    return { victims: found.victims };
  });
}

/** A payment out that will never confirm, waiting to be shown to the user. */
export type FailedNotice = { txid: string; kind: 'respent' | 'parent-failed'; sentSats: number };

/** The notices waiting in the store, each taken once (its label map marked deleted). */
export async function takeFailedNotices(storage: {
  runAsStorageProvider<T>(fn: (sp: RepairStore) => Promise<T>): Promise<T>;
}): Promise<FailedNotice[]> {
  return storage.runAsStorageProvider(async (sp) => {
    const out: FailedNotice[] = [];
    for (const [label, kind] of [
      [NOTICE_RESPENT, 'respent'],
      [NOTICE_PARENT_FAILED, 'parent-failed'],
    ] as const)
      for (const l of await sp.findTxLabels({ partial: { label } }))
        for (const m of await sp.findTxLabelMaps({ partial: { txLabelId: l.txLabelId, isDeleted: false } })) {
          const [t] = await sp.findTransactions({ partial: { transactionId: m.transactionId }, noRawTx: true });
          // What the recipient was to get: the outputs that are not this wallet's (no basket, not change).
          const sent = (await sp.findOutputs({ partial: { transactionId: m.transactionId }, noScript: true }))
            .filter((o) => o.basketId == null && !o.change)
            .reduce((n, o) => n + (o.satoshis ?? 0), 0);
          if (t?.txid) out.push({ txid: t.txid, kind, sentSats: sent });
          await sp.updateTxLabelMap(m.transactionId, m.txLabelId, { isDeleted: true });
        }
    return out;
  });
}

/** The words the user sees for a notice. */
export function noticeText(n: FailedNotice): { title: string; message: string } {
  const amount = n.sentSats ? ` of ${n.sentSats.toLocaleString('en-GB')} sats` : '';
  const reason =
    n.kind === 'respent'
      ? 'another payment from this wallet, now confirmed, used the same coins'
      : 'it was paid from an earlier payment of yours that never confirmed';
  return {
    title: 'A payment didn’t go through',
    message: `Your payment${amount} (${short(n.txid)}) didn’t go through: ${reason}. The recipient didn’t get it.`,
  };
}

/** The toolbox's UnFail for `txid`'s own queued requests only (never every 'unfail' request in the store). */
async function unfailOnly(w: UnfailWiring, txid: string): Promise<string | undefined> {
  const task = w.monitor?._tasks?.find((t) => t.name === 'UnFail');
  if (!task?.unfail) return undefined;
  const reqs = await w.storage.runAsStorageProvider((sp) =>
    sp.findProvenTxReqs({ partial: { txid, status: 'unfail' } }),
  );
  if (!reqs.length) return '';
  return (await task.unfail.call(task, reqs)).log;
}

/**
 * The repair: only for a txid whose proof verifies against the chain tracker, and only through the toolbox (its failed
 * path for payments the mined one makes impossible, then TaskUnFail for this txid's own request, which checks the
 * proof again before it changes anything). A missing proven-tx request is made from the transaction's own bytes.
 */
export function makeUnfailRepair(w: UnfailWiring): FailedRowDeps['repair'] {
  const log = w.log ?? ((m: string) => console.warn(m));
  return async (txid, beef) => {
    if (!w.monitor || !w.storage.isActiveStorageProvider()) return { result: 'unavailable' };
    const rows = await w.storage.runAsStorageProvider((sp) =>
      sp.findTransactions({ partial: { txid }, noRawTx: true }),
    );
    if (!rows.some((t) => REFUSED.has(t.status))) return { result: 'not-failed' };
    const rawTx = beef.findTxid(txid)?.tx?.toBinary();
    if (!rawTx) return { result: 'unavailable' };
    const proof = await checkProof(txid, {
      bump: beef.findBump(txid),
      getMerklePath: (t) => w.services.getMerklePath(t),
      tracker: (await w.chainTracker?.()) ?? w.monitor.chaintracks,
    });
    if (proof.state === 'none') return { result: 'not-mined' };
    if (proof.state === 'unchecked') return { result: 'unchecked' };

    const ownIds = new Set(rows.map((t) => t.transactionId));
    const settled = await w.storage.runAsStorageProvider((sp) =>
      settleInputs(sp, { ownIds, rawTx, minedTxid: txid, confirmations: proof.confirmations }),
    );
    if (settled.held) {
      log(`[failedRow] ${txid}: mined, held (${settled.held}): ${settled.detail ?? ''}; nothing changed`);
      return { result: settled.held, detail: settled.held === 'unconfirmed' ? settled.detail : undefined };
    }
    if (settled.victims.length)
      log(
        `[failedRow] ${txid}: mined; failed what spent the same coins: ${settled.victims.map((v) => v.row.txid).join(', ')}`,
      );

    // Queue A's own request for UnFail, remembering each status so a 'doubleSpend' marker is never lost.
    const before = new Map<number, string>();
    await w.storage.runAsStorageProvider(async (sp) => {
      const reqs = await sp.findProvenTxReqs({ partial: { txid } });
      for (const r of reqs) {
        before.set(r.provenTxReqId, r.status);
        await sp.updateProvenTxReq(r.provenTxReqId, { status: 'unfail', ...(r.rawTx?.length ? {} : { rawTx }) });
      }
      if (!reqs.length) {
        const req = EntityProvenTxReq.fromTxid(txid, rawTx);
        req.status = 'unfail';
        req.addHistoryNote({ what: 'bwxSyncFailedRowRepair' } as never);
        for (const t of rows) req.addNotifyTransactionId(t.transactionId);
        await sp.insertProvenTxReq(req.toApi());
      }
    });
    const ran = await unfailOnly(w, txid);
    log(`[failedRow] ${txid}: UnFail: ${ran === undefined ? 'no UnFail task' : ran.trim() || 'done'}`);
    const after = await w.storage.runAsStorageProvider(async (sp) => {
      const txs = await sp.findTransactions({ partial: { txid }, noRawTx: true });
      for (const r of await sp.findProvenTxReqs({ partial: { txid } })) {
        const was = before.get(r.provenTxReqId);
        // Never left queued for another UnFail run, and a 'doubleSpend' marker UnFail turned 'invalid' is put back.
        if (r.status === 'unfail' || (was === 'doubleSpend' && r.status === 'invalid'))
          await sp.updateProvenTxReq(r.provenTxReqId, { status: was ?? 'invalid' });
      }
      return txs;
    });
    const repaired = after.length > 0 && after.every((t) => ACCEPTED.has(t.status));
    // Our check of the proof passed but UnFail's own fetch or check didn't: never "not mined".
    return { result: repaired ? 'repaired' : 'proof-pending' };
  };
}

/**
 * Before the toolbox's UnFail runs for `txid` from anywhere else (services/recoverFailedWiring.ts): is a coin it spent
 * now spent by another payment of this wallet that is not failed? Then UnFail would hand that coin to `txid` and leave
 * the other payment's outputs spendable (review of fix/385, R1), so the caller holds it instead.
 */
export async function spendsContested(sp: RepairStore, txid: string, rawTx: number[] | undefined): Promise<boolean> {
  if (!rawTx?.length) return false;
  const rows = await sp.findTransactions({ partial: { txid }, noRawTx: true });
  const found = await findConflicts(sp, new Set(rows.map((t) => t.transactionId)), rawTx);
  return !!found.conflict || found.victims.length > 0;
}

/** AtomicBEEF bytes of a mined transaction with its proof, for the repair (Find missing coins, recoverByTxid). */
export function beefWithProof(rawTx: number[], merklePath: MerklePath): Beef {
  const tx = Transaction.fromBinary(rawTx);
  tx.merklePath = merklePath;
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return beef;
}

type GuardedReq = {
  txid: string;
  rawTx?: number[] | null;
  status: string;
  addHistoryNote(note: unknown): void;
  updateStorageDynamicProperties(sp: unknown): Promise<void>;
};
type ProofServices = {
  getMerklePath(txid: string): Promise<{ merklePath?: unknown } | undefined>;
  getChainTracker(): Promise<ChainTracker>;
};
const GUARDED = Symbol.for('bwx.unfailGuard');

/**
 * Every un-fail in the toolbox goes through StorageProvider.unfailTransactionsForProof: TaskUnFail (whatever queued the
 * request: our repair, Find mined payments, or TaskReviewDoubleSpends turning a 'doubleSpend' request it now sees mined
 * into 'unfail'), and the proof completion path (reconcileProvenTxReqTransactions). Third review of fix/385, 1: those
 * handed a coin another live payment of this wallet had spent since to the mined one, with nothing failed and no
 * notice. Guarded here, once, before any wallet opens (its first Monitor run comes with createWebWallet):
 *  - nothing else spends its coins: the toolbox's own un-fail, unchanged;
 *  - otherwise, with its proof checked and at SETTLE_CONFIRMATIONS: settleInputs (the other payments failed through the
 *    toolbox, notices stored, the coins marked spent), then the toolbox's un-fail;
 *  - else held: nothing changes; a request TaskUnFail brought goes back to 'doubleSpend', so TaskReviewDoubleSpends
 *    brings it again and a later run finishes it.
 */
export function installUnfailGuard(proto: object = StorageProvider.prototype): void {
  const p = proto as Record<string | symbol, unknown>;
  if (p[GUARDED]) return;
  p[GUARDED] = true;
  const orig = p.unfailTransactionsForProof as (
    this: unknown,
    req: GuardedReq,
    indent?: number,
    requestUpdate?: unknown,
  ) => Promise<string>;
  p.unfailTransactionsForProof = async function (
    this: RepairStore & { getServices(): ProofServices },
    req: GuardedReq,
    indent = 0,
    requestUpdate?: unknown,
  ): Promise<string> {
    const txs = await this.findTransactions({ partial: { txid: req.txid }, noRawTx: true });
    const toRepair = txs.filter((t) => requestUpdate != null || t.status === 'failed');
    if (!toRepair.length || !req.rawTx?.length) return orig.call(this, req, indent, requestUpdate);
    const rawTx = Array.from(req.rawTx);
    const ownIds = new Set(txs.map((t) => t.transactionId));
    const found = await findConflicts(this, ownIds, rawTx);
    if (!found.conflict && !found.victims.length) return orig.call(this, req, indent, requestUpdate);
    let settled: Settled = { held: 'conflict', detail: found.conflict, victims: [] };
    if (!found.conflict) {
      let proof: ProofCheck = { state: 'unchecked', confirmations: 0 };
      try {
        const services = this.getServices();
        proof = await checkProof(req.txid, {
          getMerklePath: (t) => services.getMerklePath(t),
          tracker: await services.getChainTracker(),
        });
      } catch {
        /* no services: unchecked */
      }
      settled =
        proof.state === 'mined'
          ? await settleInputs(this, { ownIds, rawTx, minedTxid: req.txid, confirmations: proof.confirmations })
          : { held: 'unconfirmed', detail: `its proof couldn’t be checked (${proof.state})`, victims: found.victims };
    }
    if (settled.held) {
      console.warn(`[unfailGuard] ${req.txid}: not un-failed (${settled.held}): ${settled.detail ?? ''}`);
      if (requestUpdate != null) {
        req.status = 'doubleSpend';
        req.addHistoryNote({ what: 'bwxUnfailHeld', reason: settled.held } as never);
        await req.updateStorageDynamicProperties(this);
      }
      return `${' '.repeat(indent)}held (${settled.held}): ${settled.detail ?? ''}\n`;
    }
    return orig.call(this, req, indent, requestUpdate);
  };
}
