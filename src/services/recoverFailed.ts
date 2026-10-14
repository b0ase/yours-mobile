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
 * it (restoreTransactionForProof). We queue ONLY actions we have checked are mined (not every failed
 * action), so nothing is invented and nothing unproven is touched.
 *
 * dkg, 14 Oct 2026 (sweep 9f66943b): a mined action can also be stuck 'unprocessed' / 'unsigned' / 'sending' when
 * iOS kills the PWA mid-broadcast. UnFail restores any status once the request is queued with a proof, so those
 * are candidates too. A repair counts as 'restored' only when storage, read back, holds spendable outputs.
 */
export type StuckStatus = 'failed' | 'unprocessed' | 'unsigned' | 'sending';

export type FailedAction = {
  txid: string;
  /** Storage status; absent means 'failed' (listFailedActions). */
  status?: StuckStatus | string;
  description?: string;
  satoshis?: number;
  outputs?: { satoshis?: number }[];
  /** ms since epoch, for the result line ("from 05:56"). */
  createdAt?: number;
};

/** What storage holds for a txid after the repair, read back (never inferred from the status change alone). */
export type SpendableState = {
  /** Status of the wallet's transaction row. */
  status?: string;
  /** Outputs storage holds for the tx. */
  outputs: number;
  /** Of those, how many are spendable now, and their total. */
  spendable: number;
  spendableSats: number;
};

export type RecoverDeps = {
  /**
   * Candidate actions: 'failed' plus the in-flight states a killed app can leave behind ('unprocessed',
   * 'unsigned', 'sending'; dkg, 14 Oct 2026). Read only.
   */
  listFailed: () => Promise<FailedAction[]>;
  /** Queue exactly these txids for the proof-checked UnFail repair (their proven-tx requests -> 'unfail'). */
  queueUnfail: (txids: string[]) => Promise<number>;
  /** True ONLY when the network has a merkle proof for txid (mined). Mempool or unknown is false. */
  isMined: (txid: string) => Promise<boolean>;
  /** Run the Monitor's UnFail task now. */
  runUnFail: () => Promise<string>;
  /** Read back what storage holds for txid after the repair. Without it nothing can be reported as restored. */
  spendableOf?: (txid: string) => Promise<SpendableState>;
  /**
   * False when the active store can't be repaired directly (a remote WalletStorageProvider). The repair is
   * skipped, not failed, and runs again once this device's storage is active.
   */
  available?: () => boolean;
  log?: (msg: string) => void;
};

export type RecoveredAction = {
  txid: string;
  description?: string;
  createdAt?: number;
  fromStatus: string;
  sats: number;
};

export type RecoverReport = {
  /** Candidates looked at (failed + stuck). */
  failed: number;
  mined: string[];
  /** Mined, repaired, and read back with spendable outputs. */
  restored: string[];
  restoredDetail?: RecoveredAction[];
  /** Mined and queued, but storage still doesn't show spendable outputs afterwards: the true state, per txid. */
  notRestored?: { txid: string; reason: string }[];
  error?: string;
  skipped?: string;
};

const TXID = /^[0-9a-f]{64}$/i;

export async function recoverMinedFailedActions(deps: RecoverDeps): Promise<RecoverReport> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const report: RecoverReport = { failed: 0, mined: [], restored: [], restoredDetail: [], notRestored: [] };
  if (deps.available && !deps.available()) {
    report.skipped = 'active storage is remote';
    return report;
  }
  try {
    const seen = new Set<string>();
    const candidates = (await deps.listFailed()).filter((a) => {
      if (!TXID.test(a.txid ?? '') || seen.has(a.txid)) return false;
      seen.add(a.txid);
      return true;
    });
    report.failed = candidates.length;
    if (!candidates.length) return report;
    // Only a merkle proof counts. Mempool, unknown or a lookup error leaves the action exactly as it is.
    for (const a of candidates) {
      try {
        if (await deps.isMined(a.txid)) report.mined.push(a.txid);
      } catch {
        /* unknown: leave it */
      }
    }
    if (!report.mined.length) return report;
    log(`[recover] ${report.mined.length} stuck action(s) are mined; restoring: ${report.mined.join(', ')}`);
    const queued = await deps.queueUnfail(report.mined);
    if (!queued) {
      log('[recover] no proven-tx request found for the mined txid(s); nothing queued');
      for (const txid of report.mined) report.notRestored!.push({ txid, reason: 'no proven-tx request in storage' });
      return report;
    }
    log(`[recover] UnFail: ${(await deps.runUnFail()).trim() || 'done'}`);
    const still = new Set(
      (await deps.listFailed()).filter((a) => (a.status ?? 'failed') === 'failed').map((a) => a.txid),
    );
    for (const a of candidates) {
      if (!report.mined.includes(a.txid)) continue;
      if (still.has(a.txid)) {
        report.notRestored!.push({ txid: a.txid, reason: 'still failed (proof rejected)' });
        continue;
      }
      if (!deps.spendableOf) {
        report.notRestored!.push({ txid: a.txid, reason: 'repaired status, spendable outputs not verified' });
        continue;
      }
      const st = await deps.spendableOf(a.txid);
      if (st.outputs > 0 && st.spendable === 0) {
        report.notRestored!.push({
          txid: a.txid,
          reason: `status ${st.status ?? '?'} but 0 of ${st.outputs} outputs spendable (UTXO check inconclusive or spent)`,
        });
        continue;
      }
      report.restored.push(a.txid);
      report.restoredDetail!.push({
        txid: a.txid,
        description: a.description,
        createdAt: a.createdAt,
        fromStatus: a.status ?? 'failed',
        sats: st.spendableSats,
      });
      log(`[recover] restored ${a.txid} (${st.spendable}/${st.outputs} outputs spendable, ${st.spendableSats} sats)`);
    }
    for (const n of report.notRestored!) log(`[recover] NOT restored ${n.txid}: ${n.reason}`);
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    console.error('[recover] failed:', e);
  }
  return report;
}

const bsv = (sats: number) => (sats / 1e8).toFixed(sats >= 1e8 ? 2 : 8).replace(/\.?0+$/, '');
const hhmm = (ms?: number) =>
  ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const kind = (d?: string) => (d && /^sweep/i.test(d) ? 'sweep' : 'payment');

/** One line for Settings › Troubleshooting. */
export function recoverySummary(r: RecoverReport): string {
  if (r.error) return `Couldn't check: ${r.error}`;
  if (r.skipped)
    return 'Nothing checked: this wallet is using remote storage. Switch to this device’s storage and try again.';
  const parts: string[] = [];
  for (const d of r.restoredDetail ?? [])
    parts.push(
      `Found ${bsv(d.sats)} BSV from ${[hhmm(d.createdAt), kind(d.description)].filter(Boolean).join(' ')}; restored`,
    );
  for (const n of r.notRestored ?? []) parts.push(`${n.txid.slice(0, 8)}… is on chain but not restored: ${n.reason}`);
  if (!parts.length) return 'Nothing to restore';
  return parts.join('. ');
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
