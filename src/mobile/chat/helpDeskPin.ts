/**
 * The bWallet Help Desk (ticker LOUNGE) sits pinned at the top of Chat as the yellow card. It can be
 * unpinned on this device only (local, never synced, like bit-sign's own unpin), and then shows as an
 * ordinary row. Pinning that row again brings the card back. A wallet reset or fresh restore clears
 * the flag, so it comes back pinned.
 */
import { useEffect, useState } from 'react';

export const HELP_DESK_UNPIN_KEY = 'bwallet.helpdesk.unpinned.v1';
const EVENT = 'bwallet:helpdesk-pin';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export const helpDeskUnpinned = (s: Store | null = local()): boolean => {
  try {
    return s?.getItem(HELP_DESK_UNPIN_KEY) === '1';
  } catch {
    return false;
  }
};

const fire = () => {
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const setHelpDeskUnpinned = (on: boolean, s: Store | null = local()): void => {
  try {
    if (on) s?.setItem(HELP_DESK_UNPIN_KEY, '1');
    else s?.removeItem(HELP_DESK_UNPIN_KEY);
  } catch {
    /* storage unavailable: stays pinned */
  }
  fire();
};

/** Wallet reset / restore: the Help Desk is pinned again. */
export const clearHelpDeskUnpin = (s: Store | null = local()): void => setHelpDeskUnpinned(false, s);

export const useHelpDeskPinned = (): boolean => {
  const [pinned, setPinnedState] = useState(() => !helpDeskUnpinned());
  useEffect(() => {
    const read = () => setPinnedState(!helpDeskUnpinned());
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, []);
  return pinned;
};
