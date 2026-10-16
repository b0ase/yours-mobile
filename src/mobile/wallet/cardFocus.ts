/**
 * Tap a token row to put it on the balance card (owner, 15 Oct 2026). The Tokens list sets the focused token; the
 * balance carousel (the host) shows it as the front card until × or a swipe clears it. With no carousel mounted
 * (extension, store builds without balance cards) rows keep their old tap.
 */
export type FocusedToken = {
  id: string;
  name: string;
  icon: string;
  /** The real balance, formatted, e.g. "12.5 FOO". */
  amount: string;
  /** The same balance in whole units, for the card's fiat/BSV value. */
  qty?: number;
  /** The token's symbol and decimals, for the units line under the value ("1,000 SCAM"). */
  symbol?: string;
  decimals?: number;
  onSend: () => void;
  onReceive?: () => void;
  onLock?: () => void;
  /** The token's room (chat), when the list can open one. */
  onRoom?: () => void;
};

let focused: FocusedToken | null = null;
let hosts = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

export const hasFocusHost = () => hosts > 0;
export const registerFocusHost = () => {
  hosts++;
  return () => {
    hosts = Math.max(0, hosts - 1);
    if (hosts === 0 && focused) {
      focused = null;
      notify();
    }
  };
};
export const getFocusedToken = () => focused;
export const setFocusedToken = (t: FocusedToken) => {
  focused = t;
  notify();
};
export const clearFocusedToken = () => {
  if (!focused) return;
  focused = null;
  notify();
};
export const subscribeFocusedToken = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
