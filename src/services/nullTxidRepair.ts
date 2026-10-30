/**
 * "A truthy value is required." on every send from This device (owner's extension, 30 Oct 2026 03:45Z).
 *
 * wallet-toolbox createAction gathers the BEEF of the change it picked with `verifyTruthy(output.txid)`. Its picker
 * (StorageIdb.allocateChangeInput) takes any managed-change output that is spendable, has no spentBy, and whose
 * transaction is completed/unproven/sending, but never checks the output row's own `txid`. One such row with a null
 * txid makes every payment that picks it throw WERR_INTERNAL before anything is signed.
 *
 * Repair, on the ACTIVE local store only (never the remote, never broadcasts):
 *   1. every spendable output with no txid: copy its transaction's txid when that transaction has one; otherwise
 *      mark it spendable=false so the picker skips it (the coin is not deleted; Find missing coins can add it back);
 *   2. every action left 'unsigned' or 'unprocessed' for more than STALE_MS: abortAction, which releases the coins it
 *      locked. Never one whose txid the network knows (it may have gone out).
 *
 * Pure apart from the injected deps. Tested in nullTxidRepair.test.ts.
 */

export const STALE_MS = 10 * 60 * 1000;

export const isTruthyRequiredError = (e: unknown): boolean =>
  /A truthy value is required/i.test(
    e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e),
  );

export interface RepairOutput {
  outputId: number;
  transactionId: number;
  txid?: string | null;
  spendable: boolean;
}
export interface RepairTx {
  transactionId: number;
  txid?: string | null;
  status: string;
  reference: string;
  updated_at?: Date | string;
}

export interface NullTxidRepairDeps {
  /** Spendable outputs of the account (active local store). */
  spendableOutputs: () => Promise<RepairOutput[]>;
  transaction: (transactionId: number) => Promise<RepairTx | undefined>;
  /** Actions with status 'unsigned' or 'unprocessed'. */
  pendingActions: () => Promise<RepairTx[]>;
  updateOutput: (outputId: number, patch: { txid?: string; spendable?: boolean }) => Promise<void>;
  abortAction: (reference: string) => Promise<void>;
  knownOnChain: (txid: string) => Promise<boolean>;
  now?: () => number;
  log?: (m: string, d?: unknown) => void;
}

export interface NullTxidRepairReport {
  txidFilled: number;
  setAside: number;
  aborted: number;
  skipped: number;
}

const TXID = /^[0-9a-f]{64}$/i;

export async function repairNullTxids(d: NullTxidRepairDeps): Promise<NullTxidRepairReport> {
  const log = d.log ?? (() => undefined);
  const now = (d.now ?? Date.now)();
  const r: NullTxidRepairReport = { txidFilled: 0, setAside: 0, aborted: 0, skipped: 0 };

  for (const o of await d.spendableOutputs()) {
    if (o.txid && TXID.test(o.txid)) continue;
    const tx = await d.transaction(o.transactionId);
    if (tx?.txid && TXID.test(tx.txid) && ['completed', 'unproven', 'sending'].includes(tx.status)) {
      await d.updateOutput(o.outputId, { txid: tx.txid });
      r.txidFilled++;
    } else {
      await d.updateOutput(o.outputId, { spendable: false });
      r.setAside++;
    }
  }

  for (const a of await d.pendingActions()) {
    if (a.status !== 'unsigned' && a.status !== 'unprocessed') continue;
    const at = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    if (at && now - at < STALE_MS) {
      r.skipped++;
      continue;
    }
    if (a.txid && TXID.test(a.txid)) {
      const known = await d.knownOnChain(a.txid).catch(() => true); // fail closed: unknown = may have gone out
      if (known) {
        r.skipped++;
        continue;
      }
    }
    try {
      await d.abortAction(a.reference);
      r.aborted++;
    } catch (e) {
      log('[nullTxidRepair] abort failed', e instanceof Error ? e.message : String(e));
      r.skipped++;
    }
  }
  if (r.txidFilled || r.setAside || r.aborted) log('[nullTxidRepair] repaired', r);
  return r;
}
