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
import { EntityProvenTxReq } from '@bsv/wallet-toolbox-client';

/** The toolbox's refusal of a transaction storage holds as failed (or invalid). */
export const REFUSED_STATUS = /target transaction of internalizeAction has invalid status (failed|invalid)/i;

import { HeldAsFailedError, type HeldReason } from './heldAsFailed';
export { HELD_AS_FAILED, HeldAsFailedError, isHeldAsFailed, type HeldReason } from './heldAsFailed';
export type RepairResult = 'repaired' | Exclude<HeldReason, 'unrepaired'>;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ''));

export type FailedRowDeps = {
  /** Repair the failed row of `txid` if the network has mined it. `beef`: the AtomicBEEF being internalized. */
  repair: (txid: string, beef: Beef) => Promise<RepairResult>;
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
  const held = new Map<string, { reason: HeldReason; until: number }>();
  const inFlight = new Map<string, Promise<RepairResult>>();

  const repairOnce = (txid: string, beef: Beef) => {
    let p = inFlight.get(txid);
    if (!p) {
      p = deps
        .repair(txid, beef)
        .catch((e: unknown) => {
          log(`[failedRow] ${txid}: repair failed: ${messageOf(e)}`);
          return 'unavailable' as const;
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
      if (h && now() < h.until) throw new HeldAsFailedError(txid, h.reason);
      const r = await repairOnce(txid, beef);
      if (r !== 'repaired') {
        held.set(txid, { reason: r, until: now() + holdMs });
        log(`[failedRow] ${txid}: held as failed, left out (${r})`);
        throw new HeldAsFailedError(txid, r);
      }
      held.delete(txid);
      log(`[failedRow] ${txid}: mined; failed row repaired, taking it in`);
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
  txid?: string | null;
  status: string;
  provenTxId?: number | null;
  satoshis?: number;
  description?: string;
};
type OutRow = { outputId: number; transactionId: number; spentBy?: number | null };
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
  findProvenTxReqs(args: { partial: { txid?: string }; trx?: Trx }): Promise<ReqRow[]>;
  updateProvenTxReq(id: number, update: Record<string, unknown>, trx?: Trx): Promise<unknown>;
  insertProvenTxReq(req: unknown, trx?: Trx): Promise<number>;
  updateTransactionStatus(
    status: 'failed',
    transactionId: number,
    userId?: number,
    reference?: string,
    trx?: Trx,
  ): Promise<void>;
};

/** A payment of this wallet that is now known never to confirm (another of its payments, mined, spent its coins). */
export type FailedPayment = { txid: string; satoshis?: number; description?: string };

export type UnfailWiring = {
  storage: {
    isActiveStorageProvider(): boolean;
    runAsStorageProvider<T>(fn: (sp: RepairStore) => Promise<T>): Promise<T>;
  };
  monitor?: { runTask(name: string): Promise<string>; chaintracks?: ChainTracker } | null;
  services: { getMerklePath(txid: string): Promise<{ merklePath?: unknown } | undefined> };
  /** The chain tracker proofs are checked against (default: the monitor's, the one TaskUnFail uses). */
  chainTracker?: () => Promise<ChainTracker | undefined>;
  /** Payments failed because the mined transaction spent their coins: tell the user the recipient didn't get them. */
  onPaymentsFailed?: (payments: FailedPayment[]) => void;
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

/** True only when a proof for `txid` verifies against the chain tracker. Any doubt is false. */
async function verifiedMined(txid: string, beef: Beef, w: UnfailWiring): Promise<boolean> {
  const tracker = (await w.chainTracker?.()) ?? w.monitor?.chaintracks;
  if (!tracker) return false;
  const tryPath = async (mp: MerklePath | undefined) => {
    if (!mp) return false;
    try {
      return await mp.verify(txid, tracker);
    } catch {
      return false;
    }
  };
  if (await tryPath(beef.findBump(txid))) return true;
  const r = await w.services.getMerklePath(txid).catch(() => undefined);
  return tryPath(asMerklePath(r?.merklePath));
}

type Conflicts = { conflict?: string; victims: { row: TxRow; direct: boolean }[] };

/**
 * Other payments of this wallet that spend a coin `rawTx` spends, and everything spending their outputs (deepest
 * last). A completed or proven one is a conflict: the store says it confirmed, so nothing is decided here.
 */
async function findConflicts(sp: RepairStore, ownIds: Set<number>, rawTx: number[]): Promise<Conflicts> {
  const tx = Transaction.fromBinary(rawTx);
  const out: Conflicts = { victims: [] };
  const seen = new Set<number>(ownIds);
  const queue: { id: number; direct: boolean }[] = [];
  for (const input of tx.inputs) {
    if (!input.sourceTXID) continue;
    for (const o of await sp.findOutputs({
      partial: { txid: input.sourceTXID, vout: input.sourceOutputIndex },
      noScript: true,
    }))
      if (o.spentBy != null && !seen.has(o.spentBy)) {
        seen.add(o.spentBy);
        queue.push({ id: o.spentBy, direct: true });
      }
  }
  while (queue.length) {
    const { id, direct } = queue.shift()!;
    const [row] = await sp.findTransactions({ partial: { transactionId: id }, noRawTx: true });
    if (!row || row.status === 'failed') continue;
    if (row.status === 'completed' || row.provenTxId != null) {
      out.conflict = `${row.txid ?? `transaction ${id}`} (${row.status})`;
      return out;
    }
    out.victims.push({ row, direct });
    for (const o of await sp.findOutputs({ partial: { transactionId: id }, noScript: true }))
      if (o.spentBy != null && !seen.has(o.spentBy)) {
        seen.add(o.spentBy);
        queue.push({ id: o.spentBy, direct: false });
      }
  }
  return out;
}

/**
 * The toolbox's double-spend path for each victim, children first: its proven-tx requests 'doubleSpend' (a payment
 * that spent a coin the mined transaction spent) or 'invalid' (one that spent such a payment's outputs), with a history
 * note, then updateTransactionStatus('failed'), which releases its inputs and makes its outputs unspendable.
 */
async function failVictims(sp: RepairStore, victims: Conflicts['victims'], minedTxid: string) {
  await sp.transaction(async (trx) => {
    for (const { row, direct } of [...victims].reverse()) {
      if (row.txid)
        for (const api of await sp.findProvenTxReqs({ partial: { txid: row.txid }, trx })) {
          const req = new EntityProvenTxReq(api as never);
          req.status = direct ? 'doubleSpend' : 'invalid';
          req.addHistoryNote({ what: 'bwxSpentByMined', minedTxid } as never);
          await req.updateStorageDynamicProperties(sp as never, trx as never);
        }
      await sp.updateTransactionStatus('failed', row.transactionId, undefined, undefined, trx);
    }
  });
}

/**
 * The repair: only for a txid whose proof verifies against the chain tracker, and only through the toolbox (its failed
 * path for payments the mined one makes impossible, then TaskUnFail, which checks the proof again before it changes
 * anything). A missing proven-tx request is made from the transaction's own bytes.
 */
export function makeUnfailRepair(w: UnfailWiring): FailedRowDeps['repair'] {
  const log = w.log ?? ((m: string) => console.warn(m));
  return async (txid, beef) => {
    if (!w.monitor || !w.storage.isActiveStorageProvider()) return 'unavailable';
    const rows = await w.storage.runAsStorageProvider((sp) =>
      sp.findTransactions({ partial: { txid }, noRawTx: true }),
    );
    if (!rows.some((t) => REFUSED.has(t.status))) return 'repaired'; // repaired meanwhile: internalize again
    const rawTx = beef.findTxid(txid)?.tx?.toBinary();
    if (!rawTx) return 'unavailable';
    if (!(await verifiedMined(txid, beef, w))) return 'not-mined';

    const ownIds = new Set(rows.map((t) => t.transactionId));
    const found = await w.storage.runAsStorageProvider((sp) => findConflicts(sp, ownIds, rawTx));
    if (found.conflict) {
      log(`[failedRow] ${txid}: mined, but ${found.conflict} spends the same coins; held, nothing changed`);
      return 'conflict';
    }
    if (found.victims.length) {
      await w.storage.runAsStorageProvider((sp) => failVictims(sp, found.victims, txid));
      log(
        `[failedRow] ${txid}: mined; failed what spent the same coins: ${found.victims.map((v) => v.row.txid).join(', ')}`,
      );
    }

    // Queue A for UnFail, remembering each request's status so a 'doubleSpend' marker is never lost.
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
    log(`[failedRow] ${txid}: UnFail: ${(await w.monitor.runTask('UnFail')).trim() || 'done'}`);
    const after = await w.storage.runAsStorageProvider(async (sp) => {
      const txs = await sp.findTransactions({ partial: { txid }, noRawTx: true });
      for (const r of await sp.findProvenTxReqs({ partial: { txid } }))
        if (before.get(r.provenTxReqId) === 'doubleSpend' && r.status === 'invalid')
          await sp.updateProvenTxReq(r.provenTxReqId, { status: 'doubleSpend' });
      return txs;
    });
    const repaired = after.length > 0 && after.every((t) => ACCEPTED.has(t.status));
    // B failed either way (A's proof verified): the user hears about it.
    const failed = found.victims
      .filter((v) => v.direct && v.row.txid)
      .map((v) => ({ txid: v.row.txid!, satoshis: v.row.satoshis, description: v.row.description }));
    if (failed.length) w.onPaymentsFailed?.(failed);
    return repaired ? 'repaired' : 'not-mined';
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
