/**
 * Wallet token rows › swipe › Lock (owner, 15 Oct 2026): where each row's Lock goes.
 *  - BSV: the Lock BSV screen in Locks & Pots (it locks BSV by default).
 *  - PNEEs: the Lock screen in Back PNEEs mode (lock BSV into the PNEEs pot), only where that flow is live
 *    (not the store build). Locking PNEE itself (PNEE vaults) is held, so no Lock there otherwise.
 *  - Other tokens: tokenLockNotice, one small function so token locks (feat/token-locks) can replace it.
 */
import { BACK_PNEE_ROUTE } from '../notes/backPnee';

export const BSV_LOCK_ROUTE = '/m/lock';

/** Route for a default row's Lock, or null when that row has no Lock. */
export const lockRouteFor = (rowId: 'bsv' | 'pnee', opts: { backPneeLive: boolean }): string | null => {
  if (rowId === 'bsv') return BSV_LOCK_ROUTE;
  return opts.backPneeLive ? BACK_PNEE_ROUTE : null;
};

/** Token rows' Lock until token locks ship: the notice to show. Swap this out for the real flow. */
export const tokenLockNotice = (sym?: string) => `Locking ${sym || 'this token'} isn’t available yet.`;
