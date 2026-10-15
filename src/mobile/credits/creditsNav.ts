/**
 * Open a bCredits sheet (Top up or History) from elsewhere, e.g. the bCredits card's back. Same pending-then-event
 * shape as phone/walletAction.ts: CreditsPanel takes it when it mounts, or hears it if it is already showing.
 */
export type CreditsSheet = 'topup' | 'history';
const EVENT = 'bwallet:credits-sheet';
let pending: CreditsSheet | null = null;

export const requestCreditsSheet = (s: CreditsSheet) => {
  pending = s;
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const takeCreditsSheet = (): CreditsSheet | null => {
  const s = pending;
  pending = null;
  return s;
};

export const onCreditsSheet = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};
