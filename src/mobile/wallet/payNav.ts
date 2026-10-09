/**
 * "Pay" from elsewhere (Chat › Contacts): hand a recipient (paymail or address) to the BSV
 * wallet's Send screen. Same pending-then-event shape as chat/nav.ts — the wallet takes it when
 * it mounts, or hears it if already showing. The user still enters the amount and confirms.
 */
const EVENT = 'bwallet:pay-to';
let pending: string | null = null;
let pendingSats: number | null = null;

/** `amountSats`: from a scanned payment request (scan/parseScan.ts); the user still confirms. */
export const requestPay = (to: string, amountSats?: number) => {
  pending = to.trim();
  pendingSats = amountSats && amountSats > 0 ? Math.round(amountSats) : null;
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

const PERSIST = 'bwallet.pendingPay';

/** Like requestPay, but survives the reload an account switch does (Agents › Fund from another account). */
export const requestPayAfterSwitch = (to: string) => {
  try {
    localStorage.setItem(PERSIST, to.trim());
  } catch {
    /* storage unavailable */
  }
};

export const takePay = (): string | null => {
  let p = pending;
  pending = null;
  if (!p) {
    try {
      p = localStorage.getItem(PERSIST);
      localStorage.removeItem(PERSIST);
    } catch {
      p = null;
    }
  }
  return p;
};

/** The amount that came with the last requestPay, if any (read once, right after takePay). */
export const takePayAmount = (): number | null => {
  const a = pendingSats;
  pendingSats = null;
  return a;
};

export const onPay = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};
