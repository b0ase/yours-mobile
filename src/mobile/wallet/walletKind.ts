/**
 * Wallet tab's top switch: Tokens (fungible: BSV, MNEE, locks, BSV21) | NFTs (non-fungible,
 * shown as the media library: music, video, images) | Credits (prepaid bCredits). A tiny shared store so the bottom bar,
 * deep links (upstream 'ords') and the Wallet page agree on the view.
 */
export type WalletKind = 'tokens' | 'nfts' | 'credits';

let kind: WalletKind = 'tokens';
const listeners = new Set<() => void>();

export const setWalletKind = (next: WalletKind) => {
  if (next === kind) return;
  kind = next;
  listeners.forEach((fn) => fn());
};

export const getWalletKind = () => kind;

export const subscribeWalletKind = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
