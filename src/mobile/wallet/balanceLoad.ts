/**
 * Wallet-tab balance loading that can never spin forever.
 *
 * GET_BALANCE goes to the background wallet, whose storage lock can be held for a long time
 * (e.g. the wallet broadcasting a queued transaction at start). The Wallet tab used to show its
 * spinner until that answer came and kept it forever if the call failed. Now the call is
 * bounded; on timeout or error the tab shows the last balance it knew (cached per identity)
 * with "Couldn't refresh", and a late answer still lands when it arrives.
 */

export const BALANCE_TIMEOUT_MS = 15_000;
export const RATE_TIMEOUT_MS = 8_000;

const key = (identity: string) => `bwallet.lastBalance.${identity}`;

export const loadLastBalance = (identity: string | undefined): number | null => {
  if (!identity) return null;
  try {
    const v = localStorage.getItem(key(identity));
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
};

export const saveLastBalance = (identity: string | undefined, sats: number) => {
  if (!identity || !Number.isFinite(sats) || sats < 0) return;
  try {
    localStorage.setItem(key(identity), String(Math.round(sats)));
  } catch {
    /* storage unavailable */
  }
};

export type BalanceView = 'spinner' | 'amount' | 'unknown';

/**
 * What the balance slot shows: the spinner only while the first load is in flight and has not
 * failed; an amount once one is known (fresh or cached); a dash when it failed with nothing known.
 */
export const balanceView = (s: { loading: boolean; failed: boolean; known: boolean }): BalanceView =>
  s.known ? 'amount' : s.failed ? 'unknown' : s.loading ? 'spinner' : 'amount';
