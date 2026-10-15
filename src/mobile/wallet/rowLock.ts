/**
 * Wallet token rows › swipe › Lock (owner, 15 Oct 2026): where each row's Lock goes.
 *  - BSV: the Lock BSV screen in Locks & Pots (it locks BSV by default).
 *  - PNEEs: the Lock screen in Back PNEEs mode (lock BSV into the PNEEs pot), only where that flow is live
 *    (not the store build). Locking PNEE itself (PNEE vaults) is held, so no Lock there otherwise.
 *  - Other tokens: the token-lock sheet (locks/TokenLockSheet.tsx), opened by BsvWallet's lockToken.
 */
import { BACK_PNEE_ROUTE } from '../notes/backPnee';

export const BSV_LOCK_ROUTE = '/m/lock';

/** Route for a default row's Lock, or null when that row has no Lock. */
export const lockRouteFor = (rowId: 'bsv' | 'pnee', opts: { backPneeLive: boolean }): string | null => {
  if (rowId === 'bsv') return BSV_LOCK_ROUTE;
  return opts.backPneeLive ? BACK_PNEE_ROUTE : null;
};
