/**
 * bMail postage the wallet signed with noSend that went out some other way (Bureau retest, 18 Oct 2026: the
 * recipient's copy was broadcast straight to ARC after the old delayed-broadcast bug). The tx is mined, but the
 * sender's row still says nosend/unsent, so the toolbox never picks its change and the balance looks short.
 *
 * Reconcile: for each such row, ask the chain (WhatsOnChain) whether the txid is mined; if it is, run the existing
 * repair (recoverByTxid's repairRows): proof attached, status completed, the wallet's own outputs of that tx that
 * are still unspent on chain made spendable. It builds, signs and broadcasts nothing. Rate-limited per wallet run.
 */
export const STUCK_STATUSES = ['nosend', 'unsent', 'unprocessed'];

export type StuckPostage = { transactionId: number; txid: string; status: string };

export type PostageReconcileDeps = {
  /** bMail postage rows of this wallet in a STUCK_STATUSES status that have a txid. */
  listStuck: () => Promise<StuckPostage[]>;
  /** true = mined (in a block), false = not mined / unknown to the chain, undefined = no answer. */
  isMined: (txid: string) => Promise<boolean | undefined>;
  /** Repair one mined txid in place (attach proof, completed, unspent outputs of ours spendable). */
  settle: (row: StuckPostage) => Promise<{ outputs: number }>;
  log?: (m: string) => void;
};

export type PostageReconcileReport = {
  checked: number;
  settled: string[];
  pending: string[];
  errors: { txid: string; error: string }[];
  skipped?: 'rate-limited' | 'busy';
};

const MIN_INTERVAL_MS = 5 * 60_000;
let lastRunAt = 0;
let running: Promise<PostageReconcileReport> | undefined;

/** Test hook: forget the rate limit. */
export function resetPostageReconcileLimit() {
  lastRunAt = 0;
  running = undefined;
}

export async function reconcilePostage(
  deps: PostageReconcileDeps,
  opts: { now?: number; force?: boolean } = {},
): Promise<PostageReconcileReport> {
  const now = opts.now ?? Date.now();
  if (running) return { checked: 0, settled: [], pending: [], errors: [], skipped: 'busy' };
  if (!opts.force && lastRunAt && now - lastRunAt < MIN_INTERVAL_MS)
    return { checked: 0, settled: [], pending: [], errors: [], skipped: 'rate-limited' };
  lastRunAt = now;
  running = run(deps);
  try {
    return await running;
  } finally {
    running = undefined;
  }
}

async function run(deps: PostageReconcileDeps): Promise<PostageReconcileReport> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const report: PostageReconcileReport = { checked: 0, settled: [], pending: [], errors: [] };
  let rows: StuckPostage[];
  try {
    rows = (await deps.listStuck()).filter((r) => /^[0-9a-f]{64}$/i.test(r.txid));
  } catch (e) {
    report.errors.push({ txid: '', error: e instanceof Error ? e.message : String(e) });
    return report;
  }
  for (const row of rows.slice(0, 50)) {
    report.checked++;
    try {
      const mined = await deps.isMined(row.txid);
      if (mined !== true) {
        report.pending.push(row.txid);
        continue;
      }
      const r = await deps.settle(row);
      report.settled.push(row.txid);
      log(`[postageReconcile] ${row.txid}: was ${row.status}, mined → completed (${r.outputs} output(s) spendable)`);
    } catch (e) {
      report.errors.push({ txid: row.txid, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return report;
}

/** WhatsOnChain: mined when the tx has a block height / confirmations. 404 → false; network trouble → undefined. */
export async function wocIsMined(
  txid: string,
  fetchFn: typeof fetch = (u, i) => fetch(u, i),
  network: 'main' | 'test' = 'main',
): Promise<boolean | undefined> {
  try {
    const res = await fetchFn(`https://api.whatsonchain.com/v1/bsv/${network}/tx/hash/${txid}`);
    if (res.status === 404) return false;
    if (!res.ok) return undefined;
    const j = (await res.json()) as { blockheight?: number; confirmations?: number; blockhash?: string };
    return !!(j.blockhash || (j.blockheight && j.blockheight > 0) || (j.confirmations && j.confirmations > 0));
  } catch {
    return undefined;
  }
}
