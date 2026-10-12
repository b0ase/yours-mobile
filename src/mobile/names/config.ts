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

/** Earlier bWallet paymail domains: every name still answers there (pay.bwallet.space PAYMAIL_DOMAINS). */
export const LEGACY_PAYMAIL_DOMAINS = ['bwallet.space'];

/**
 * BRC-169 ecosystem domain written on OpNS names registered here (profile.domain). Readers fetch
 * https://bwalletx.com/manifest.json and resolve <name>@bwalletx.com through our paymail (site/lib/opnsResolve.js).
 */
export const OPNS_PROFILE_DOMAIN = 'bwalletx.com';
