import type { WalletInterface } from '@bsv/sdk';
import { withTimeout } from '../mobile/withTimeout';

/**
 * Startup release of a site's broken inscription chain (services/dappChain.ts).
 *
 * vexvoid.com, 11 Oct 2026 (5.2.1): a streamed inscription (@1sat/actions inscribe, descriptions "Stream origin
 * inscription" / "Stream chunk i/n") failed part-way. Its earlier steps were built with noSend and never broadcast,
 * so they keep holding the change they allocated until aborted: the balance looks lower than it is.
 *
 * Only actions with those descriptions are looked at, and only `nosend` / `unsigned` ones (never handed to the
 * network) are aborted. The toolbox re-checks a `nosend` txid on chain and refuses if it is known.
 */
export type StreamAction = { txid?: string; status?: string; description?: string };

const STREAM_DESC = /^Stream (origin inscription|chunk \d+\/\d+)$/;

export const isStrandedStream = (a: StreamAction) =>
  !!a.txid && STREAM_DESC.test(a.description ?? '') && (a.status === 'nosend' || a.status === 'unsigned');

export type StreamHealReport = { aborted: string[]; errors: string[] };

export async function healStrandedStreamActions(
  wallet: Pick<WalletInterface, 'listActions' | 'abortAction'>,
  { timeoutMs = 20_000, isKnown }: { timeoutMs?: number; isKnown?: (txid: string) => Promise<boolean> } = {},
): Promise<StreamHealReport> {
  const report: StreamHealReport = { aborted: [], errors: [] };
  let actions: StreamAction[] = [];
  try {
    const r = await withTimeout(wallet.listActions({ labels: [], limit: 200 }), timeoutMs, 'listActions');
    actions = r.actions;
  } catch (e) {
    report.errors.push(e instanceof Error ? e.message : String(e));
    return report;
  }
  for (const a of actions) {
    if (!isStrandedStream(a) || !a.txid) continue;
    try {
      if (isKnown && (await isKnown(a.txid))) continue; // already on chain: not stranded, never abort
      const r = await withTimeout(wallet.abortAction({ reference: a.txid }), timeoutMs, 'abortAction');
      if (r.aborted) report.aborted.push(a.txid);
    } catch (e) {
      report.errors.push(`${a.txid.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}
