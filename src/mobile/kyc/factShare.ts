/**
 * Identity › Share one fact (selective disclosure).
 *
 * The owner signs a grant naming ONE fact from their bit-sign KYC certificate, the app's public
 * key, and an end date; bit-sign (POST /api/bitsign/identity/cert/grants) then vouches for that
 * fact, and only that fact, to that key until the date. Message and protocol mirror bit-sign
 * src/lib/kyc-cert-disclosure.ts exactly: change one and the signature stops verifying.
 *
 * The server has no list or revoke route yet, so the wallet keeps its own record of what it
 * shared, and "Stop sharing" asks the server and says plainly when it cannot.
 */
import { Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { BCHAT_ORIGIN, type Http } from '../chat/api';
import type { KycSummary } from './kyc';

export const SHARE_GRANT_PROTOCOL: [2, string] = [2, 'bitsign kyc share grant'];
export const SHARE_GRANT_KEY_ID = '1';
export const SHARE_GRANT_MAX_DAYS = 365;
export const GRANTS_PATH = '/api/bitsign/identity/cert/grants';

/** bit-sign GRANTABLE_FIELDS. */
export type GrantField =
  | 'identity_strength'
  | 'document_type'
  | 'document_country'
  | 'verified_at'
  | 'expires_at'
  | 'sanctions';

export type FactId = 'verified' | 'country' | 'strength' | 'sanctions' | 'over18' | 'handle';

export interface Fact {
  id: FactId;
  label: string;
  /** What the app learns, in plain words. */
  shares: string;
  /** Cert fields the grant names. Empty = the server cannot share this yet. */
  fields: GrantField[];
}

export const FACTS: Fact[] = [
  { id: 'verified', label: 'ID verified', shares: 'That your ID was checked, and when', fields: ['verified_at'] },
  { id: 'country', label: 'Country', shares: 'The country on your ID', fields: ['document_country'] },
  {
    id: 'strength',
    label: 'Identity strength',
    shares: 'How strongly your identity is proven (1–4)',
    fields: ['identity_strength'],
  },
  {
    id: 'sanctions',
    label: 'Sanctions check',
    shares: 'Whether you passed the sanctions check',
    fields: ['sanctions'],
  },
  { id: 'over18', label: 'Over 18', shares: 'Only yes or no, never your birth date', fields: [] },
  { id: 'handle', label: 'Handle owner', shares: 'That you own your $handle', fields: [] },
];

export const factAvailable = (f: Fact) => f.fields.length > 0;

/** The value the app will see, from the wallet's own copy of the certificate. */
export const factPreview = (f: Fact, kyc: KycSummary | null): string => {
  if (!kyc) return 'Not verified yet';
  switch (f.id) {
    case 'verified':
      return `Yes, ${new Date(kyc.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    case 'country':
      return kyc.country ? kyc.country.toUpperCase() : 'Not on your certificate';
    case 'strength':
      return `Level ${kyc.level}`;
    case 'sanctions':
      return 'Pass or fail, as bit-sign recorded it';
    case 'over18':
      return kyc.over18 === 'true' ? 'Yes' : kyc.over18 === 'false' ? 'No' : 'Unknown';
    default:
      return '';
  }
};

const HEX_KEY = /^0[23][0-9a-fA-F]{64}$/;
export const isAppKey = (k: string) => HEX_KEY.test(k.trim());

export const shortKey = (k: string) => (k.length > 14 ? `${k.slice(0, 8)}…${k.slice(-6)}` : k);

/** Byte-for-byte bit-sign shareGrantMessage. */
export const shareGrantMessage = (g: {
  ownerPubkey: string;
  granteePubkey: string;
  fields: string[];
  expiresAt: string;
  signedAt: string;
}) =>
  `bit-sign kyc share grant\nidentity_key:${g.ownerPubkey}\ngrantee:${g.granteePubkey}` +
  `\nfields:${[...g.fields].sort().join(',')}\nexpires_at:${g.expiresAt}\nsigned_at:${g.signedAt}`;

export interface GrantRequest {
  identity_key: string;
  grantee: string;
  fields: string[];
  expires_at: string;
  signed_at: string;
  signature: string;
}

export const DURATIONS = [
  { days: 1, label: '1 day' },
  { days: 30, label: '30 days' },
  { days: 365, label: '1 year' },
] as const;

export const buildGrant = async (args: {
  ctx: OneSatContext;
  grantee: string;
  fact: Fact;
  days: number;
  now?: number;
}): Promise<GrantRequest> => {
  const now = args.now ?? Date.now();
  const days = Math.min(Math.max(1, args.days), SHARE_GRANT_MAX_DAYS);
  const ownerPubkey = (await args.ctx.wallet.getPublicKey({ identityKey: true })).publicKey;
  const signedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + days * 86_400_000).toISOString();
  const grantee = args.grantee.trim().toLowerCase();
  const message = shareGrantMessage({
    ownerPubkey,
    granteePubkey: grantee,
    fields: args.fact.fields,
    expiresAt,
    signedAt,
  });
  const { signature } = await args.ctx.wallet.createSignature({
    data: Utils.toArray(message, 'utf8'),
    protocolID: SHARE_GRANT_PROTOCOL,
    keyID: SHARE_GRANT_KEY_ID,
    counterparty: 'anyone',
  });
  return {
    identity_key: ownerPubkey,
    grantee,
    fields: [...args.fact.fields],
    expires_at: expiresAt,
    signed_at: signedAt,
    signature: Utils.toHex(signature),
  };
};

export type SendResult = { ok: true } | { ok: false; reason: 'unavailable' | 'signin' | 'error'; message: string };

const errorText = (data: unknown, fallback: string) =>
  data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
    ? (data as { error: string }).error
    : fallback;

/** POST the signed grant. 503 = the server is not switched on yet; nothing was shared. */
export const sendGrant = async (
  http: Http,
  token: string,
  grant: GrantRequest,
  origin = BCHAT_ORIGIN,
): Promise<SendResult> => {
  let res;
  try {
    res = await http({
      method: 'POST',
      url: `${origin}${GRANTS_PATH}`,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: grant,
    });
  } catch {
    return { ok: false, reason: 'error', message: 'No connection. Nothing was shared.' };
  }
  if (res.status === 201 || res.status === 200) return { ok: true };
  if (res.status === 503 || res.status === 404)
    return { ok: false, reason: 'unavailable', message: 'Not available yet. Nothing was shared.' };
  if (res.status === 401) return { ok: false, reason: 'signin', message: 'Open Chat once to sign in, then try again.' };
  return { ok: false, reason: 'error', message: errorText(res.data, `Could not share (${res.status}).`) };
};

/** Ask the server to end a grant early. Any non-2xx means it is still live until its end date. */
export const revokeGrant = async (
  http: Http,
  token: string,
  g: StoredGrant,
  origin = BCHAT_ORIGIN,
): Promise<boolean> => {
  try {
    const res = await http({
      method: 'DELETE',
      url: `${origin}${GRANTS_PATH}`,
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: { identity_key: g.owner, grantee: g.grantee, signed_at: g.signedAt },
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
};

export interface StoredGrant {
  owner: string;
  grantee: string;
  appName: string;
  factId: FactId;
  signedAt: string;
  expiresAt: string;
}

const STORE = (owner: string) => `bwallet.factGrants:${owner}`;

export const loadGrants = (owner: string, now = Date.now()): StoredGrant[] => {
  try {
    const all = JSON.parse(localStorage.getItem(STORE(owner)) || '[]') as StoredGrant[];
    return Array.isArray(all) ? all.filter((g) => Date.parse(g.expiresAt) > now) : [];
  } catch {
    return [];
  }
};

export const saveGrants = (owner: string, grants: StoredGrant[]) => {
  try {
    localStorage.setItem(STORE(owner), JSON.stringify(grants));
  } catch {
    /* storage unavailable */
  }
};
