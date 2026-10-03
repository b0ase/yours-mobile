/**
 * Wallet errors carried across the background → page boundary as text. wallet-toolbox's
 * WERR_REVIEW_ACTIONS ("Undelayed createAction or signAction results require review") hides the
 * actual broadcast outcome in reviewActionResults / sendWithResults, which a bare `.message` drops,
 * so users only ever saw the headline. Append the per-transaction status and any competing txids.
 */
type Review = { txid?: string; status?: string; competingTxs?: string[]; competingBeef?: unknown };
type Send = { txid?: string; status?: string };

export function describeWalletError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const e = error as Error & { reviewActionResults?: Review[]; sendWithResults?: Send[]; code?: string };
  const parts: string[] = [];
  for (const r of e.reviewActionResults ?? []) {
    if (!r?.status || r.status === 'success') continue;
    const what =
      r.status === 'doubleSpend'
        ? 'double spend: a coin or the listing was already spent'
        : r.status === 'invalidTx'
          ? 'rejected by the network as invalid'
          : r.status === 'serviceError'
            ? 'broadcast service error, try again'
            : r.status;
    parts.push(`${what}${r.competingTxs?.length ? ` (competing ${r.competingTxs[0].slice(0, 12)}…)` : ''}`);
  }
  if (!parts.length)
    for (const s of e.sendWithResults ?? [])
      if (s?.status && s.status !== 'unproven' && s.status !== 'sending') parts.push(s.status);
  return parts.length ? `${e.message} ${parts.join('; ')}` : e.message;
}
