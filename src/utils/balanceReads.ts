/**
 * Every real BSV balance read the page makes (utils/wallet.ts getWalletBalance), with when it began. The live balance
 * (mobile/wallet/live/liveBus.ts) reconciles the spends it shows as pending against these only: never against a
 * cached or fallback number, and knowing whether the read began after a spend (review of #558, round 2).
 */
/** `account`: the identity address the wallet read it for (GET_BALANCE answers with it), when known. */
export type BalanceRead = { sats: number; startedAt: number; account?: string };

const listeners = new Set<(r: BalanceRead) => void>();

export const onBalanceRead = (f: (r: BalanceRead) => void): (() => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

/** Per account ('' when untagged): when the newest read already published began. */
const newest = new Map<string, number>();

/**
 * A read that began before one already published for the same account is stale: it answered late, after a newer read
 * that may include spends it does not (review of #558 round 5: 10,000 shown after 8,900 had landed, a false
 * "+1,100 received", and MAX filling the old number). Stale reads reach no listener. Returns whether it was published.
 */
export const publishBalanceRead = (r: BalanceRead): boolean => {
  if (!Number.isFinite(r.sats) || !Number.isFinite(r.startedAt)) return false;
  const key = r.account ?? '';
  if ((newest.get(key) ?? -Infinity) > r.startedAt) return false;
  newest.set(key, r.startedAt);
  listeners.forEach((f) => {
    try {
      f(r);
    } catch {
      /* a listener never breaks a balance read */
    }
  });
  return true;
};

/** Tests only. */
export const __resetBalanceReads = () => newest.clear();
