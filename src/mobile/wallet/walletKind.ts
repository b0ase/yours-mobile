/**
 * Wallet tab's top switch: Tokens (fungible: BSV, MNEE, locks, BSV21) | NFTs (non-fungible,
 * shown as the media library: music, video, images) | Credits (prepaid bCredits). A tiny shared store so the bottom bar,
 * deep links (old Media tab, upstream 'ords') and the Wallet page agree on the view.
 */
export type WalletKind = 'tokens' | 'nfts' | 'credits';

let kind: WalletKind = 'tokens';
/** The top bar's Media button: NFTs narrowed to what you play (music, video). */
let media = false;
const listeners = new Set<() => void>();

const set = (nextKind: WalletKind, nextMedia: boolean) => {
  if (nextKind === kind && nextMedia === media) return;
  kind = nextKind;
  media = nextMedia;
  listeners.forEach((fn) => fn());
};

export const getWalletKind = () => kind;
export const getMediaView = () => media;

export const setWalletKind = (next: WalletKind) => set(next, false);
export const openMediaView = () => set('nfts', true);

export const subscribeWalletKind = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
