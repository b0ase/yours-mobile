/**
 * Pinned company registry for register-of-members claims (docs/SHARE-CLAIM.md).
 *
 * Every key here is pinned in the app. Nothing that arrives inside an invite payload is ever trusted as a key:
 * the payload's `lock.companyPubKey` must EQUAL the pinned lock key, and the invite signature is checked against
 * the pinned identity key. An empty key means "not configured" and every claim for that company is refused.
 *
 * $NPG (owner, 18 Oct 2026): the BSV-21 tokens are the share record of Ninja Punk Girls Ltd, one token = one share,
 * one token per allotment tranche. Supply comes from here, never from an indexer (the GorillaPool index reports null).
 */
export type TranchePin = { tranche: string; shares: number; note: string };

export type CompanyPin = {
  code: string;
  name: string;
  number: string;
  ticker: string;
  /** Origin the invite / claim / holding APIs are fetched from (https only). */
  host: string;
  /** The company's root identity key: verifies invite + holding signatures. Empty = not configured. */
  identityKey: string;
  /** The company's half of every 2-of-2 lock. Distinct from identityKey. Empty = not configured. */
  lockKey: string;
  totalShares: number;
  /** Allowed BSV-21 token ids → tranche. Unknown ids are rejected. All are 0 decimals. */
  tokens: Record<string, TranchePin>;
  /** Tranches allotted but not yet deployed as tokens, by tranche name. Only these may come back with id null. */
  planned: Record<string, TranchePin>;
};

export const NPG_TOKEN_2022A = 'b8747a4b356875cc90842c733ad2770b12bf50c17cf204afd0605f9dcba67d31_1';

export const COMPANIES: Record<string, CompanyPin> = {
  npg: {
    code: 'npg',
    name: 'Ninja Punk Girls Ltd',
    number: '13706347',
    ticker: 'NINJAPUNKGIRLS',
    host: 'https://www.ninjapunkgirls.com',
    // TODO(owner): pin the company identity key and the lock key once decided. Until then every claim is refused.
    identityKey: '',
    lockKey: '',
    totalShares: 2_115_915,
    tokens: {
      [NPG_TOKEN_2022A]: { tranche: '2022A', shares: 2_045_457, note: 'Allotments up to Apr 2022' },
      // TODO(owner): move 2022B here (with its token id) once deployed, and drop it from `planned`.
    },
    planned: { '2022B': { tranche: '2022B', shares: 70_458, note: 'Planned $NPG-2022B, not deployed yet' } },
  },
};

export const NOT_CONFIGURED = 'Company key not configured';

export const companyFor = (code: string | null | undefined): CompanyPin | null =>
  (code && Object.prototype.hasOwnProperty.call(COMPANIES, code) ? COMPANIES[code] : null) ?? null;

const KEY = /^0[23][0-9a-f]{64}$/;
/** Both pinned keys present and well formed. */
export const companyConfigured = (c: CompanyPin) => KEY.test(c.identityKey) && KEY.test(c.lockKey);
