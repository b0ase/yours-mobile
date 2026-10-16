/**
 * Page-side "refresh the balance now" signal. useSyncTracker turns it into a balance tick, so a
 * payment internalized outside the address sync (paymail inbox) shows without waiting for a resync.
 */
export const BALANCE_REFRESH_EVENT = 'bwallet-balance-refresh';

export const requestBalanceRefresh = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(BALANCE_REFRESH_EVENT));
};
