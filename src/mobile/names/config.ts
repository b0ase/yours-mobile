/**
 * bWallet-hosted paymail (name@<domain>). Set at build time:
 *   BWALLET_PAYMAIL_DOMAIN=bwallet-nine.vercel.app pnpm build:mobile
 * Empty (the default) = the feature is off everywhere (no claim flow, no paymail on Receive).
 * BWALLET_PAYMAIL_API overrides the server base URL (default https://<domain>). See docs/NAMES.md.
 */
declare const __PAYMAIL_DOMAIN__: string;
declare const __PAYMAIL_API__: string;

const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\/$/, '') : '');

export const BWALLET_PAYMAIL_DOMAIN = clean(typeof __PAYMAIL_DOMAIN__ === 'undefined' ? '' : __PAYMAIL_DOMAIN__);
export const BWALLET_PAYMAIL_API =
  clean(typeof __PAYMAIL_API__ === 'undefined' ? '' : __PAYMAIL_API__) ||
  (BWALLET_PAYMAIL_DOMAIN ? `https://${BWALLET_PAYMAIL_DOMAIN}` : '');
