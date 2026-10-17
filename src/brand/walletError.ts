/**
 * Wallet errors carried across the background → page boundary as text. wallet-toolbox's
 * WERR_REVIEW_ACTIONS ("Undelayed createAction or signAction results require review") hides the
 * actual broadcast outcome in reviewActionResults / sendWithResults, which a bare `.message` drops,
 * so users only ever saw the headline. Append the per-transaction status and any competing txids.
 */
type Review = { txid?: string; status?: string; competingTxs?: string[]; competingBeef?: unknown };
type Send = { txid?: string; status?: string };

const BEEF_HINT =
  ' Your wallet is using 1Sat online storage, which can only handle short histories. Fix: Settings › Wallet Backup › make "This Browser" active, then try again.';

/** Add the how-to-fix line to a BEEF depth error (once). */
export const withBeefHint = (text: string) =>
  /BEEF depth exceeded/i.test(text) && !text.includes('Wallet Backup') ? text + BEEF_HINT : text;

export function describeWalletError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/BEEF depth exceeded/i.test(text)) return withBeefHint(text);
  if (!(error instanceof Error)) return text;
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
