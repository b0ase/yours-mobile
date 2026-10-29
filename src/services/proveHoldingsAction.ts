/**
 * The tiny, dependency-free part of `window.CWI.proveHoldings` (services/proveHoldingsSite.ts): the message type and
 * the sites allowed to ask. Page scripts (inject.js) and content scripts import this, never the proving code.
 */
export const PROVE_HOLDINGS_ACTION = 'bwxProveHoldings';
export const isProveHoldingsAction = (type: unknown): boolean => type === PROVE_HOLDINGS_ACTION;

/** First party only: bChatX and bit-sign. Exact origins; previews never get it. */
export const PROVE_HOLDINGS_ORIGINS: readonly string[] = [
  'https://www.bchatx.com',
  'https://bchatx.com',
  'https://chat.bwalletx.com',
  'https://www.bit-sign.online',
  'https://bit-sign.online',
];
export const isProveHoldingsOrigin = (origin: unknown): boolean =>
  typeof origin === 'string' && PROVE_HOLDINGS_ORIGINS.includes(origin);
