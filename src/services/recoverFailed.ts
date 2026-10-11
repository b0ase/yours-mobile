/**
 * Recover wallet actions marked `failed` whose transaction is in fact mined (owner, 11 Oct 2026, $vexvoid).
 *
 * After the 5.2.1 rescue, the wallet's own change transaction c13ecd5b… (1 input, 8 managed-change outputs,
 * 25,432,286 sats) was mined, yet the balance read $0.00 and createAction found 0 spendable sats: storage held
 * that action as failed (a racing duplicate broadcast during the 5.2.1 per-step funding preparation is the likely
 * cause), so its outputs were not spendable.
 *
 * The toolbox has a supported repair for exactly this: listFailedActions(unfail=true) queues failed actions
 * as 'unfail', and the Monitor's UnFail task fetches a merkle proof for each, authenticates it against the
 * chain, and restores the transaction and its outputs (restoreTransactionForProof). Actions without a proof
 * go back to 'invalid' untouched. So this never invents outputs: only proven transactions are restored, with
 * the outputs storage already recorded for them.
 *
 * We only queue the repair when at least one failed action is actually mined, then run UnFail once.
 */
export type FailedAction = {
  txid: string;
  description?: string;
  satoshis?: number;
  outputs?: { satoshis?: number }[];
};

export type RecoverDeps = {
  /** Failed actions (and, with unfail=true, queue all of them for proof-based recovery). */
  listFailed: (unfail: boolean) => Promise<FailedAction[]>;
  /** True when the network has a merkle proof for txid (mined). */
  isMined: (txid: string) => Promise<boolean>;
  /** Run the Monitor's UnFail task now. */
  runUnFail: () => Promise<string>;
  log?: (msg: string) => void;
};

export type RecoverReport = { failed: number; mined: string[]; restored: string[]; error?: string };

const outSats = (a: FailedAction) => (a.outputs ?? []).reduce((s, o) => s + (o.satoshis ?? 0), 0);

export async function recoverMinedFailedActions(deps: RecoverDeps): Promise<RecoverReport> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const report: RecoverReport = { failed: 0, mined: [], restored: [] };
  try {
    const failed = (await deps.listFailed(false)).filter((a) => /^[0-9a-f]{64}$/i.test(a.txid ?? ''));
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
    await deps.listFailed(true);
    log(`[recover] UnFail: ${(await deps.runUnFail()).trim() || 'done'}`);
    const still = new Set((await deps.listFailed(false)).map((a) => a.txid));
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

/** Abort/release guard: an action whose transaction the network already knows must never be aborted. */
export async function knownOnChain(txid: string, getRawTx: (txid: string) => Promise<unknown>): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) return false;
  try {
    const r = (await getRawTx(txid)) as { rawTx?: unknown } | string | number[] | Uint8Array | undefined;
    if (!r) return false;
    if (typeof r === 'string' || Array.isArray(r) || r instanceof Uint8Array) return r.length > 0;
    return !!(r as { rawTx?: unknown }).rawTx;
  } catch {
    return false;
  }
}
