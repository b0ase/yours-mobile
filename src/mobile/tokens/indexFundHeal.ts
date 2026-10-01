import type { WalletInterface } from '@bsv/sdk';
import { withTimeout } from '../withTimeout';
import { INDEX_FUND_LABEL } from './indexFund';

/**
 * Startup self-heal for token-indexing payments (indexFund.ts).
 *
 * Only actions carrying our own label are looked at, and only ones that were never handed to
 * the network are aborted:
 *  - `nosend` / `unsigned`: built but never broadcast. Aborting returns their inputs to the
 *    wallet. (The toolbox itself re-checks a `nosend` txid on chain and refuses if it is known.)
 *  - `sending` / `unprocessed`: signed and possibly broadcast. Never aborted (the toolbox refuses
 *    `sending` anyway); the wallet's own broadcaster completes them. Reported only.
 *  - anything else (`unproven`, `completed`, `failed`): finished, nothing to do.
 */
export type HealVerdict = 'abort' | 'pending' | 'done';

export type HealAction = { txid?: string; status?: string; labels?: string[]; description?: string };

export function classifyIndexFundAction(a: HealAction): HealVerdict {
  if (!a.labels?.includes(INDEX_FUND_LABEL)) return 'done';
  if (a.status === 'nosend' || a.status === 'unsigned') return 'abort';
  if (a.status === 'sending' || a.status === 'unprocessed') return 'pending';
  return 'done';
}

export type HealReport = { aborted: string[]; pending: string[]; errors: string[] };

const HEAL_TIMEOUT_MS = 20_000;

/**
 * Find stuck indexing payments and abort the ones that are safe to abort. Never throws and never
 * waits longer than `timeoutMs` per wallet call, so it cannot hold up wallet start.
 */
export async function healIndexFundActions(
  wallet: Pick<WalletInterface, 'listActions' | 'abortAction'>,
  { timeoutMs = HEAL_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<HealReport> {
  const report: HealReport = { aborted: [], pending: [], errors: [] };
  let actions: HealAction[] = [];
  try {
    const r = await withTimeout(
      wallet.listActions({ labels: [INDEX_FUND_LABEL], includeLabels: true, limit: 100 }),
      timeoutMs,
      'listActions',
    );
    actions = r.actions;
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e));
    return report;
  }
  for (const a of actions) {
    const v = classifyIndexFundAction(a);
    if (v === 'pending' && a.txid) report.pending.push(a.txid);
    if (v !== 'abort' || !a.txid) continue;
    try {
      const r = await withTimeout(wallet.abortAction({ reference: a.txid }), timeoutMs, 'abortAction');
      if (r.aborted) report.aborted.push(a.txid);
    } catch (e) {
      report.errors.push(`${a.txid.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}
