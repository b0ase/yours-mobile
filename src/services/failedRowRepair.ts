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
 *  - mined: the toolbox's own proof-checked repair (a proven-tx request in 'unfail', TaskUnFail). It authenticates
 *    the merkle proof against the chain tracker, sets the transaction 'unproven', marks the coins it spent as spent
 *    (they are, on chain) and sets its outputs from the chain's UTXO answer. The internalize then runs once more.
 *  - not mined (no proof): nothing is written. A HeldAsFailedError names the txid and why; the intakes leave the
 *    transaction out and try again later, and the receive guard keeps its value showing as arriving.
 *  - this device's store not active, or no monitor: nothing is written either (HeldAsFailedError 'unavailable').
 * Never sets a coin spendable on its own: only the toolbox's UTXO check does, inside UnFail.
 */
import { Beef, type InternalizeActionArgs, type InternalizeActionResult } from '@bsv/sdk';
import { EntityProvenTxReq } from '@bsv/wallet-toolbox-client';

/** The toolbox's refusal of a transaction storage holds as failed (or invalid). */
export const REFUSED_STATUS = /target transaction of internalizeAction has invalid status (failed|invalid)/i;

export type HeldReason = 'not-mined' | 'unavailable' | 'unrepaired';
export type RepairResult = 'repaired' | Exclude<HeldReason, 'unrepaired'>;

const WHY: Record<HeldReason, string> = {
  'not-mined': 'not mined yet, so it stays out until it is',
  unavailable: 'this device’s store can’t be repaired directly right now',
  unrepaired: 'the repair left it held',
};

/**
 * This device holds `txid` as failed and it could not be taken in. Not a sync failure: the intakes skip it with this
 * reason and look again later. The message avoids the toolbox's wording so it is not taken for that refusal.
 */
export class HeldAsFailedError extends Error {
  readonly txid: string;
  readonly reason: HeldReason;
  constructor(txid: string, reason: HeldReason) {
    super(`Transaction ${txid.slice(0, 8)}… is held as failed on this device: ${WHY[reason]}`);
    this.name = 'HeldAsFailedError';
    this.txid = txid;
    this.reason = reason;
  }
}

export const isHeldAsFailed = (e: unknown): e is HeldAsFailedError =>
  e instanceof HeldAsFailedError || (e as { name?: unknown } | null)?.name === 'HeldAsFailedError';

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

type StorageProviderLike = {
  findTransactions(args: {
    partial: { txid?: string };
    noRawTx?: boolean;
  }): Promise<{ transactionId: number; status: string }[]>;
  findProvenTxReqs(args: { partial: { txid?: string } }): Promise<{ provenTxReqId: number; rawTx?: number[] | null }[]>;
  updateProvenTxReq(id: number, update: Record<string, unknown>): Promise<unknown>;
  insertProvenTxReq(req: unknown): Promise<number>;
};

export type UnfailWiring = {
  storage: {
    isActiveStorageProvider(): boolean;
    runAsStorageProvider<T>(fn: (sp: StorageProviderLike) => Promise<T>): Promise<T>;
  };
  monitor?: { runTask(name: string): Promise<string> } | null;
  services: { getMerklePath(txid: string): Promise<{ merklePath?: unknown } | undefined> };
  log?: (msg: string) => void;
};

/**
 * The repair: only for a txid the chain has mined (a proof in the BEEF the toolbox just verified, or one from the
 * proof service), and only through TaskUnFail, which checks that proof again against the chain tracker before it
 * changes anything. A missing proven-tx request is made from the transaction's own bytes.
 */
export function makeUnfailRepair(w: UnfailWiring): FailedRowDeps['repair'] {
  const log = w.log ?? ((m: string) => console.warn(m));
  return async (txid, beef) => {
    if (!w.monitor || !w.storage.isActiveStorageProvider()) return 'unavailable';
    const rows = await w.storage.runAsStorageProvider((sp) =>
      sp.findTransactions({ partial: { txid }, noRawTx: true }),
    );
    if (!rows.some((t) => REFUSED.has(t.status))) return 'repaired'; // repaired meanwhile: internalize again
    const mined = !!beef.findBump(txid) || !!(await w.services.getMerklePath(txid))?.merklePath;
    if (!mined) return 'not-mined';
    const rawTx = beef.findTxid(txid)?.tx?.toBinary();
    if (!rawTx) return 'unavailable';
    await w.storage.runAsStorageProvider(async (sp) => {
      const reqs = await sp.findProvenTxReqs({ partial: { txid } });
      for (const r of reqs)
        await sp.updateProvenTxReq(r.provenTxReqId, { status: 'unfail', ...(r.rawTx?.length ? {} : { rawTx }) });
      if (!reqs.length) {
        const req = EntityProvenTxReq.fromTxid(txid, rawTx);
        req.status = 'unfail';
        req.addHistoryNote({ what: 'bwxSyncFailedRowRepair' } as never);
        for (const t of rows) req.addNotifyTransactionId(t.transactionId);
        await sp.insertProvenTxReq(req.toApi());
      }
    });
    log(`[failedRow] ${txid}: UnFail: ${(await w.monitor.runTask('UnFail')).trim() || 'done'}`);
    const after = await w.storage.runAsStorageProvider((sp) =>
      sp.findTransactions({ partial: { txid }, noRawTx: true }),
    );
    return after.length && after.every((t) => ACCEPTED.has(t.status)) ? 'repaired' : 'not-mined';
  };
}
