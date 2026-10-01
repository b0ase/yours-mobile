/**
 * bWallet-hosted paymail (name@<domain>). Build defaults (vite.config.mobile.ts):
 *   BWALLET_PAYMAIL_DOMAIN=bwallet.space, BWALLET_PAYMAIL_API=https://pay.bwallet.space
 * Empty domain = the feature is off everywhere (no claim flow, no paymail on Receive).
 * Outside a build (unit tests) the constants are undefined, so paymail is off. See docs/NAMES.md.
 */
declare const __PAYMAIL_DOMAIN__: string;
declare const __PAYMAIL_API__: string;

const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\/$/, '') : '');

export const BWALLET_PAYMAIL_DOMAIN = clean(typeof __PAYMAIL_DOMAIN__ === 'undefined' ? '' : __PAYMAIL_DOMAIN__);
export const BWALLET_PAYMAIL_API =
  clean(typeof __PAYMAIL_API__ === 'undefined' ? '' : __PAYMAIL_API__) ||
  (BWALLET_PAYMAIL_DOMAIN ? `https://${BWALLET_PAYMAIL_DOMAIN}` : '');

/**
 * Earlier primary domains of OUR paymail server. Names claimed there stay valid (the server keeps
 * serving them via PAYMAIL_DOMAINS), so they still count as "our own paymail" (e.g. bareName()).
 */
export const BWALLET_LEGACY_PAYMAIL_DOMAINS: readonly string[] = ['b0ase.com'];
