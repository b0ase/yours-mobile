/**
 * The tiny, dependency-free part of `window.CWI.swap` (services/swapSite.ts): message types and the sites allowed to
 * ask. Page scripts (inject.js) and content scripts import this, never the swap code.
 */
export const SWAP_OFFER_ACTION = 'bwxSwapOffer';
export const SWAP_ACCEPT_ACTION = 'bwxSwapAccept';
export const isSwapAction = (type: unknown): boolean => type === SWAP_OFFER_ACTION || type === SWAP_ACCEPT_ACTION;

/**
 * First party only (owner, 27 Oct 2026): bChatX rooms. Exact origins; previews never get swaps.
 * chat.bwalletx.com is the same bChatX app on our private domain (added 28 Oct 2026 for the owner's swap test room).
 */
export const SWAP_ORIGINS: readonly string[] = [
  'https://www.bchatx.com',
  'https://bchatx.com',
  'https://chat.bwalletx.com',
];
export const isSwapOrigin = (origin: unknown): boolean => typeof origin === 'string' && SWAP_ORIGINS.includes(origin);
