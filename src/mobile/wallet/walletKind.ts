/**
 * Wallet tab's top switch: Tokens (fungible: BSV, MNEE, locks, BSV21) | NFTs (non-fungible,
 * shown as the media library: music, video, images) | Tickets (tokens that open rooms) | Credits (prepaid bCredits)
 * | Shares (bShares holdings, from the balance card). A tiny shared store so the bottom bar,
 * deep links (upstream 'ords'), the balance cards and the Wallet page agree on the view.
 *
 * `coin` narrows the Tokens list to one coin's row (the MNEE or PNEEs balance card, 15 Oct 2026); null = every token.
 */
export type WalletKind = 'tokens' | 'nfts' | 'friends' | 'tickets' | 'credits' | 'shares';
export type ListCoin = 'mnee' | 'pnee' | null;

let kind: WalletKind = 'tokens';
let coin: ListCoin = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** Chips, deep links and card back buttons: show `next` with no coin narrowing. */
export const setWalletKind = (next: WalletKind) => setWalletView(next, null);

/** The balance cards: a kind plus (for Tokens) an optional coin. */
export const setWalletView = (next: WalletKind, nextCoin: ListCoin) => {
  const c = next === 'tokens' ? nextCoin : null;
  if (next === kind && c === coin) return;
  kind = next;
  coin = c;
  notify();
};

export const getWalletKind = () => kind;
export const getListCoin = () => coin;

export const subscribeWalletKind = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
