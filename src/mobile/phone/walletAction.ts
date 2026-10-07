/**
 * Open the wallet's Send or Receive screen from elsewhere (HOME, the dock's Send/Receive). Same pending-then-event
 * shape as wallet/payNav.ts: BsvWallet takes it when it mounts, or hears it if it is already showing.
 */
export type WalletAction = 'send' | 'receive';
const EVENT = 'bwallet:wallet-action';
let pending: WalletAction | null = null;

export const requestWalletAction = (a: WalletAction) => {
  pending = a;
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const takeWalletAction = (): WalletAction | null => {
  const a = pending;
  pending = null;
  return a;
};

export const onWalletAction = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};
