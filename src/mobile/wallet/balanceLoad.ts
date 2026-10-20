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
    localStorage.setItem(`${key(identity)}.at`, String(Date.now()));
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

/**
 * Whether to show "Still syncing. Tap to retry.": only when the balance failed AND nothing is known. With a cached
 * or earlier balance on screen the wallet keeps retrying quietly (every 10 s) and the fresh value replaces it.
 */
export const showSyncRetry = (s: { failed: boolean; known: boolean }): boolean => s.failed && !s.known;

/** When the cached balance was saved (ms), or null. */
export const loadLastBalanceAt = (identity: string | undefined): number | null => {
  if (!identity) return null;
  try {
    const n = Number(localStorage.getItem(`${key(identity)}.at`));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};

/**
 * A quiet hint under a cached amount while fresh loads keep failing: "Last updated 14:05 · may be out of date".
 * Null when the shown balance is fresh, unknown, or not (yet) failing.
 */
export const staleBalanceHint = (s: {
  failed: boolean;
  known: boolean;
  fresh: boolean;
  at: number | null;
  now?: number;
}): string | null => {
  if (!s.failed || !s.known || s.fresh) return null;
  if (!s.at) return 'May be out of date';
  const d = new Date(s.at);
  const sameDay = new Date(s.now ?? Date.now()).toDateString() === d.toDateString();
  const when = sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return `Last updated ${when} · may be out of date`;
};
