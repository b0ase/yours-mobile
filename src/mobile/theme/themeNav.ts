/**
 * Opens the Theme sheet (App colours + Design your card) from anywhere, e.g. Settings › Appearance. The sheet
 * lives on the wallet card (WalletCard.tsx); a request made before the card is mounted waits for it.
 */
const EVENT = 'bwx-open-theme';
let pending = false;

export function requestThemeSheet(): void {
  pending = true;
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
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
