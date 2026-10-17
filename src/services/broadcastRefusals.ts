/**
 * Why the broadcaster refused a transaction, kept so the person (and a "Report to b") can see it.
 *
 * Owner's $1 send, 17 Oct 2026: OneSatServices.postBeef turns a REJECTED verdict into a WalletError carrying ARC's
 * extraInfo, but the toolbox then throws WERR_REVIEW_ACTIONS with only { txid, status: 'invalidTx' }, so the reason
 * never reached the screen ("rejected by the network as invalid", and nothing about why). Wrap postBeef and remember
 * the reason per txid; describeWalletError reads it back.
 */

const MAX = 20;
const refusals = new Map<string, string>();

/** The broadcaster's reason for refusing this txid, if this session saw one. */
export const refusalFor = (txid: string | undefined): string | undefined => (txid ? refusals.get(txid) : undefined);

type TxidResult = { txid?: string; status?: string; serviceError?: boolean };
type Result = { status?: string; error?: unknown; txidResults?: TxidResult[] };

/** Pure: record each definite refusal (not a service hiccup) in a postBeef result list. */
export function noteRefusals(results: unknown): void {
  if (!Array.isArray(results)) return;
  for (const r of results as Result[]) {
    if (r?.status !== 'error' || !(r.error instanceof Error)) continue;
    for (const t of r.txidResults ?? []) {
      if (!t?.txid || t.status !== 'error' || t.serviceError) continue;
      refusals.delete(t.txid);
      refusals.set(t.txid, `${r.error.message}`.slice(0, 240));
      if (refusals.size > MAX) refusals.delete(refusals.keys().next().value as string);
    }
  }
}

type PostBeef = (beef: unknown, txids: string[], logger?: unknown) => Promise<unknown>;

/** Wrap services.postBeef to note refusals. Returns false when there is no postBeef to wrap. */
export function rememberRefusals(services: unknown): boolean {
  const s = services as { postBeef?: PostBeef } | null;
  if (!s || typeof s.postBeef !== 'function') return false;
  const original = s.postBeef.bind(s);
  s.postBeef = async (beef, txids, logger) => {
    const results = await original(beef, txids, logger);
    try {
      noteRefusals(results);
    } catch {
      /* never let bookkeeping break a broadcast */
    }
    return results;
  };
  return true;
}
