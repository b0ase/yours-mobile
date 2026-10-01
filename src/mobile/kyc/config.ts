import { Hash, Utils } from '@bsv/sdk';
import { BCHAT_ORIGIN } from '../chat/api';

/**
 * Verified identity (KYC) — configuration.
 *
 * bit-sign (same server as bChat) runs Veriff and certifies the wallet's identity key with a
 * BRC-52 certificate. Kept in lockstep with bit-sign's src/lib/wallet-kyc-cert.ts.
 */
export const BITSIGN_ORIGIN = BCHAT_ORIGIN;

/** bit-sign's account page, where "Verify your identity" starts the Veriff flow. */
export const KYC_PAGE_URL = `${BITSIGN_ORIGIN}/user/account`;

/** Publishes bit-sign's certifier key(s); an imported cert must be signed by one of them. */
export const ROOT_KEYS_URL = `${BITSIGN_ORIGIN}/.well-known/bit-sign-root-keys.json`;

export const KYC_CERT_TYPE_NAME = 'bit-sign.online/kyc/wallet-v1';
export const KYC_CERT_TYPE = Utils.toBase64(Hash.sha256(KYC_CERT_TYPE_NAME, 'utf8'));

export const KYC_REQUEST_PROTOCOL: [2, string] = [2, 'bitsign kyc certificate'];
export const SELF_CERT_PROTOCOL: [2, string] = [2, 'bitsign investor self cert'];
export const SHARE_EVENT_PROTOCOL: [2, string] = [2, 'bitsign share offer event'];
export const SIGN_KEY_ID = '1';

/**
 * Extra certifier public keys to trust besides the one bit-sign publishes (e.g. a key pinned
 * after rotation). Public keys only — never a private key.
 */
export const EXTRA_TRUSTED_CERTIFIERS: string[] = [];

/**
 * ISO-3166 alpha-2 countries where "Register interest" in a share offer is switched off.
 * Viewing is never blocked by country. Empty by default — the owner sets it.
 */
export const PURCHASE_BLOCKED_COUNTRIES: string[] = [];

/** Investor self-certification lasts twelve months. */
export const INVESTOR_CERT_VALID_MONTHS = 12;

/** Feature flag: show the "Other companies" (third-party issuer) share section. Off by default. */
export const SHOW_OTHER_COMPANIES = false;
