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

export const publishBalanceRead = (r: BalanceRead): void => {
  if (!Number.isFinite(r.sats) || !Number.isFinite(r.startedAt)) return;
  listeners.forEach((f) => {
    try {
      f(r);
    } catch {
      /* a listener never breaks a balance read */
    }
  });
};
