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
 * Sibling domains (owner, 18 Oct 2026): one name, two addresses. Claiming $john gives john@bwalletx.com AND
 * john@bmailx.com: the same alias row on the same server (pay.bwallet.space PAYMAIL_DOMAINS), so both resolve to
 * the same identity key and handovers, key changes and bindings (keyed by alias, never domain) cover both at once.
 */
export const SIBLING_PAYMAIL_DOMAINS = ['bmailx.com'];

/** Every address domain a name has, primary first (bwalletx.com, bmailx.com). Empty when paymail is off. */
export const BWALLET_PAYMAIL_DOMAINS: readonly string[] = BWALLET_PAYMAIL_DOMAIN
  ? [BWALLET_PAYMAIL_DOMAIN, ...SIBLING_PAYMAIL_DOMAINS.filter((d) => d !== BWALLET_PAYMAIL_DOMAIN)]
  : [];

/**
 * BRC-169 ecosystem domain written on OpNS names registered here (profile.domain). Readers fetch
 * https://bwalletx.com/manifest.json and resolve <name>@bwalletx.com through our paymail (site/lib/opnsResolve.js).
 */
export const OPNS_PROFILE_DOMAIN = 'bwalletx.com';
