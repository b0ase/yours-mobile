/**
 * "All cards" button (owner, 15 Oct 2026): the Wallet's button beside Swap opens the carousel's All cards browser,
 * which until now only opened by long-pressing a card. The button and the carousel live in different trees, so the
 * request goes over a window event. bWalletX only: the carousel (the only listener) is behind BALANCE_CARDS_ENABLED.
 */
export const ALL_CARDS_EVENT = 'bwallet:open-all-cards';

export const requestAllCards = (target: EventTarget = window) => {
  target.dispatchEvent(new Event(ALL_CARDS_EVENT));
};

/** Listen for All cards requests; returns the unsubscribe. */
export const subscribeAllCards = (cb: () => void, target: EventTarget = window) => {
  target.addEventListener(ALL_CARDS_EVENT, cb);
  return () => target.removeEventListener(ALL_CARDS_EVENT, cb);
};

/**
 * Widths for the Swap | All cards row: each present button is one equal share. In bWalletX both show (half each);
 * if Swap is off, All cards takes the full width. The store edition has neither (no row at all).
 */
export const swapRowButtons = (swapOn: boolean, allCardsOn: boolean): ('allCards' | 'swap')[] => [
  ...(allCardsOn ? (['allCards'] as const) : []),
  ...(swapOn ? (['swap'] as const) : []),
];
