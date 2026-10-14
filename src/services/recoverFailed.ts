/**
 * Recover wallet actions marked `failed` whose transaction is in fact mined (owner, 11 Oct 2026, $vexvoid).
 *
 * After the 5.2.1 rescue, the wallet's own change transaction c13ecd5b… (1 input, 8 managed-change outputs,
 * 25,432,286 sats) was mined, yet the balance read $0.00 and createAction found 0 spendable sats: storage held
 * that action as failed (a racing duplicate broadcast during the 5.2.1 per-step funding preparation is the likely
 * cause), so its outputs were not spendable.
 *
 * The toolbox's repair: the Monitor's UnFail task takes proven-tx requests in status 'unfail', fetches a merkle
 * proof, authenticates it against the chain, and restores the transaction and the outputs storage recorded for
 * it (restoreTransactionForProof). We queue ONLY failed actions we have checked are mined (not every failed
 * action), so nothing is invented and nothing unproven is touched.
 */
export type FailedAction = {
  txid: string;
  description?: string;
  satoshis?: number;
  outputs?: { satoshis?: number }[];
};

export type RecoverDeps = {
  /** Failed actions (read only). */
  listFailed: () => Promise<FailedAction[]>;
  /** Queue exactly these txids for the proof-checked UnFail repair (their proven-tx requests -> 'unfail'). */
  queueUnfail: (txids: string[]) => Promise<number>;
  /** True when the network has a merkle proof for txid (mined). */
  isMined: (txid: string) => Promise<boolean>;
  /** Run the Monitor's UnFail task now. */
  runUnFail: () => Promise<string>;
  /**
   * False when the active store can't be repaired directly (a remote WalletStorageProvider). The repair is
   * skipped, not failed, and runs again once this device's storage is active.
   */
  available?: () => boolean;
  log?: (msg: string) => void;
};

export type RecoverReport = {
  failed: number;
  mined: string[];
  restored: string[];
  error?: string;
  skipped?: string;
};

const outSats = (a: FailedAction) => (a.outputs ?? []).reduce((s, o) => s + (o.satoshis ?? 0), 0);

export async function recoverMinedFailedActions(deps: RecoverDeps): Promise<RecoverReport> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const report: RecoverReport = { failed: 0, mined: [], restored: [] };
  if (deps.available && !deps.available()) {
    report.skipped = 'active storage is remote';
    return report;
  }
  try {
    const failed = (await deps.listFailed()).filter((a) => /^[0-9a-f]{64}$/i.test(a.txid ?? ''));
    report.failed = failed.length;
    if (!failed.length) return report;
    for (const a of failed) {
      try {
        if (await deps.isMined(a.txid)) report.mined.push(a.txid);
      } catch {
        /* unknown: leave it */
      }
    }
    if (!report.mined.length) return report;
    log(`[recover] ${report.mined.length} failed action(s) are mined; restoring: ${report.mined.join(', ')}`);
    const queued = await deps.queueUnfail(report.mined);
    if (!queued) {
      log('[recover] no proven-tx request found for the mined txid(s); nothing queued');
      return report;
    }
    log(`[recover] UnFail: ${(await deps.runUnFail()).trim() || 'done'}`);
    const still = new Set((await deps.listFailed()).map((a) => a.txid));
    for (const a of failed) {
      if (!report.mined.includes(a.txid) || still.has(a.txid)) continue;
      report.restored.push(a.txid);
      log(`[recover] restored ${a.txid} (${a.outputs?.length ?? 0} outputs, ${outSats(a)} sats)`);
    }
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    console.error('[recover] failed:', e);
  }
  return report;
}

/**
 * Abort/release guard: an action whose transaction the network may already have must never be aborted.
 * Fails CLOSED: any error or unclear answer counts as known (do not abort). Only a clean "not found" is unknown.
 * A reference that isn't a txid can't be checked on chain and is left to the toolbox (false).
 */
export async function knownOnChain(txid: string, getRawTx: (txid: string) => Promise<unknown>): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) return false;
  try {
    const r = (await getRawTx(txid)) as
      | { rawTx?: unknown; error?: unknown }
      | string
      | number[]
      | Uint8Array
      | undefined
      | null;
    if (r === undefined || r === null) return false;
    if (typeof r === 'string' || Array.isArray(r) || r instanceof Uint8Array) return r.length > 0;
    if ((r as { error?: unknown }).error) return true; // a service error is not a clean "not found"
    return !!(r as { rawTx?: unknown }).rawTx;
  } catch {
    return true;
  }
}
