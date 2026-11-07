/**
 * The part of the balance not yet in a block (GET_BALANCE's `pending`, services/depositBalance.ts balanceSplit), for the
 * Wallet card's "pending" line. Published by every balance read (utils/wallet.ts getWalletBalance); the card subscribes.
 * Owner, 5 Nov 2026: a payment shows at once, as pending, while the receive watcher takes it in.
 */
let pending = 0;
const subs = new Set<() => void>();

export const publishPendingSats = (sats: number | undefined) => {
  const v = typeof sats === 'number' && Number.isFinite(sats) && sats > 0 ? Math.round(sats) : 0;
  if (v === pending) return;
  pending = v;
  subs.forEach((f) => f());
};

export const pendingSatsNow = () => pending;

export const subscribePendingSats = (f: () => void) => {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
};
