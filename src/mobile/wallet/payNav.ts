/**
 * "Pay" from elsewhere (Chat › Contacts): hand a recipient (paymail or address) to the BSV
 * wallet's Send screen. Same pending-then-event shape as chat/nav.ts — the wallet takes it when
 * it mounts, or hears it if already showing. The user still enters the amount and confirms.
 */
const EVENT = 'bwallet:pay-to';
let pending: string | null = null;

export const requestPay = (to: string) => {
  pending = to.trim();
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const takePay = (): string | null => {
  const p = pending;
  pending = null;
  return p;
};

export const onPay = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};
