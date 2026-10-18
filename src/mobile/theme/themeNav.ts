/**
 * Opens the Theme sheet (App colours + Design your card) from anywhere, e.g. Settings › Appearance. The sheet
 * lives on the wallet card (WalletCard.tsx); a request made before the card is mounted waits for it.
 */
import type { AccentId } from './accents';

const EVENT = 'bwx-open-theme';
let pending = false;
let offer: AccentId | null = null;

/** `offered`: a pack to offer at the top of App colours (an install link, theme/themeLink.ts); applied only on Use it. */
export function requestThemeSheet(offered: AccentId | null = null): void {
  pending = true;
  offer = offered;
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
}

/** The pack the last request offered, once. */
export function takeThemeOffer(): AccentId | null {
  const o = offer;
  offer = null;
  return o;
}

/** The wallet card calls this: `open` runs now if a request is waiting, and on every later request. */
export function onThemeSheetRequest(open: () => void): () => void {
  const take = () => {
    if (!pending) return;
    pending = false;
    open();
  };
  take();
  window.addEventListener(EVENT, take);
  return () => window.removeEventListener(EVENT, take);
}
