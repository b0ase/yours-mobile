/**
 * Provable names (bitcoin-corp docs/PROVABLE-NAMES.md, owner 28 Oct 2026, build step 1).
 *
 * A source-tagged name (`richard.gmail`) carries the provider's own signed statement: the OpenID Connect ID token
 * Google returned when the owner signed in, with nonce = proofNonce(the wallet's identity key). This wallet checks it
 * itself, against Google's published keys, before paying: our paymail server can't forge one, so it can't move the
 * name to another key without a fresh token that only the account holder can get.
 *
 * Checks: RS256 signature by the provider's key (published now, or archived in our public name log before the token
 * was issued), iss, aud = our OAuth client id, nonce = the key the name points to, the email gives this very name,
 * and the provider account (sub) is the one this wallet saw before. Any failure stops the payment, like the BRC-169
 * key-change stop (names.ts destinationFor).
 *
 * The archived keys come from our server, so they are trusted only for tokens issued no later than a day after we
 * first logged the key (a key we "found" later can't vouch for an older token). Step 3 anchors the archive on chain.
 *
 * TODO (PROVABLE-NAMES.md step 2): GitHub and X have no signed ID token; their names need public-post proofs.
 */

declare const __GOOGLE_CLIENT_ID__: string;
declare const __LINKEDIN_CLIENT_ID__: string;

export type ProofProvider = 'google' | 'linkedin';
export type Jwk = { kty: string; kid?: string; n: string; e: string; alg?: string };
export type ProviderKey = { kid: string; jwk: Jwk; firstSeen?: string };
export type NameProof = { provider?: string; idToken?: string; keys?: ProviderKey[] };
/**
 * Trust on first use (owner beta rule, 28 Oct 2026):
 * proven: checks out (badge). unproven: no proof ever seen for this name, or this build can't check and has never
 * seen one: pays, no badge. Stops: missing (this wallet saw a proof before, now none), bad (a served proof that
 * doesn't check out), sub-changed (a different provider account than before), unchecked (this build can't check but
 * this wallet saw a proof for the name before).
 */
export type ProofStatus = 'proven' | 'unproven' | 'missing' | 'bad' | 'sub-changed' | 'unchecked';
export type ProofCheck = { status: ProofStatus; provider: ProofProvider; sub?: string; reason?: string };

const env = (v: string | undefined) => (typeof v === 'string' ? v.trim() : '');

export const PROOF_PROVIDERS: Record<
  ProofProvider,
  { label: string; iss: string[]; jwks: string; suffix: string | null; clientId: () => string }
> = {
  google: {
    label: 'Google',
    iss: ['https://accounts.google.com', 'accounts.google.com'],
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    suffix: 'gmail',
    clientId: () => env(typeof __GOOGLE_CLIENT_ID__ === 'undefined' ? undefined : __GOOGLE_CLIENT_ID__),
  },
  // LinkedIn signs ID tokens too, but has no name tag yet (`.linkedin` comes with the name tag): kept here so its
  // proofs are checked the same way once it does.
  linkedin: {
    label: 'LinkedIn',
    iss: ['https://www.linkedin.com/oauth'],
    jwks: 'https://www.linkedin.com/oauth/openid/jwks',
    suffix: null,
    clientId: () => env(typeof __LINKEDIN_CLIENT_ID__ === 'undefined' ? undefined : __LINKEDIN_CLIENT_ID__),
  },
};

/** `name.gmail` → 'google'; any other name → null (not provable, nothing to check). */
export const provableProvider = (alias: string): ProofProvider | null => {
  const m = alias.toLowerCase().match(/\.([a-z]+)$/);
  if (!m) return null;
  return (Object.keys(PROOF_PROVIDERS) as ProofProvider[]).find((p) => PROOF_PROVIDERS[p].suffix === m[1]) ?? null;
};

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
/** The nonce the provider signs: sha256("bwalletx-name-proof|v1|" + identity key), hex. Same as the server. */
export const proofNonce = async (identityKey: string) =>
  hex(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`bwalletx-name-proof|v1|${identityKey.toLowerCase()}`),
    ),
  );

const b64urlBytes = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;

/** The name a Google token proves: their.name+tag@gmail.com → `theirname.gmail` (verified addresses only). */
export const aliasForClaims = (provider: ProofProvider, c: Record<string, unknown>): string | null => {
  if (provider !== 'google' || c.email_verified !== true) return null;
  const m = String(c.email ?? '')
    .trim()
    .toLowerCase()
    .match(/^([a-z0-9.+_-]+)@(gmail|googlemail)\.com$/);
  if (!m) return null;
  const local = m[1].split('+')[0].replace(/\./g, '');
  return /^[a-z0-9_-]{1,30}$/.test(local) ? `${local.replace(/_/g, '-')}.gmail` : null;
};

/** How long after we first logged an archived key it may still vouch for a token's issue time. */
const ARCHIVE_GRACE_S = 24 * 60 * 60;

/**
 * Check one ID token for `alias` → `identityKey`. live: the provider's keys now; archived: our name log's copy.
 * Pure (no network, no storage), so tests drive it with locally generated keys.
 */
export async function verifyNameProof(
  token: string,
  o: {
    provider: ProofProvider;
    alias: string;
    identityKey: string;
    aud: string;
    live: ProviderKey[];
    archived?: ProviderKey[];
  },
): Promise<{ ok: true; sub: string } | { ok: false; reason: string }> {
  const cfg = PROOF_PROVIDERS[o.provider];
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not an ID token' };
  let header: Record<string, unknown>;
  let c: Record<string, unknown>;
  try {
    header = b64urlJson(parts[0]);
    c = b64urlJson(parts[1]);
  } catch {
    return { ok: false, reason: 'not an ID token' };
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, reason: 'unsupported signature' };
  const kid = header.kid;
  let key = o.live.find((k) => k.kid === kid);
  if (!key) {
    // A rotated key: only from the archive, and only if we logged it before (or within a day of) the token's issue.
    const a = (o.archived ?? []).find((k) => k.kid === kid);
    const seen = a?.firstSeen ? Date.parse(a.firstSeen) / 1000 : NaN;
    if (a && Number.isFinite(seen) && seen <= Number(c.iat) + ARCHIVE_GRACE_S) key = a;
  }
  if (!key) return { ok: false, reason: 'unknown signing key' };
  let valid = false;
  try {
    const pub = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: key.jwk.n, e: key.jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      pub,
      b64urlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad signature' };
  if (!cfg.iss.includes(String(c.iss))) return { ok: false, reason: 'wrong issuer' };
  const auds = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud)];
  if (!o.aud || !auds.includes(o.aud)) return { ok: false, reason: 'issued to another app' };
  if (typeof c.sub !== 'string' || !c.sub) return { ok: false, reason: 'no account id' };
  if (c.nonce !== (await proofNonce(o.identityKey))) return { ok: false, reason: 'proves a different wallet' };
  if (aliasForClaims(o.provider, c) !== o.alias.toLowerCase()) return { ok: false, reason: 'proves a different name' };
  return { ok: true, sub: c.sub };
}

// The provider account (sub) each provable name had when this wallet last paid it: a new sub stops the payment.
const SEEN_SUB = 'bwallet.names.seenSubs';
const readSubs = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_SUB) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};
/** Remember this name's provider account (on a confirmed payment, or when the payer deliberately trusts a new one). */
export const trustProofSub = (alias: string, sub: string) => {
  try {
    localStorage.setItem(SEEN_SUB, JSON.stringify({ ...readSubs(), [alias.toLowerCase()]: sub }));
  } catch {
    /* private mode: nothing remembered */
  }
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const liveCache = new Map<string, { at: number; keys: ProviderKey[] }>();
/** The provider's published keys, straight from the provider (never through our server); cached 10 minutes. */
export const liveProviderKeys = async (f: Fetch, provider: ProofProvider): Promise<ProviderKey[]> => {
  const hit = liveCache.get(provider);
  if (hit && Date.now() - hit.at < 600_000) return hit.keys;
  try {
    const r = await f(PROOF_PROVIDERS[provider].jwks);
    const j = (r.ok ? await r.json() : {}) as { keys?: Jwk[] };
    const keys = (j.keys ?? [])
      .filter((k) => k && k.kty === 'RSA' && k.kid && k.n && k.e)
      .map((k) => ({ kid: String(k.kid), jwk: k }));
    liveCache.set(provider, { at: Date.now(), keys });
    return keys;
  } catch {
    return [];
  }
};

/**
 * The full check for a resolved name: null when the name isn't provable. `proof` is the pki answer's `proof`.
 */
export async function checkNameProof(
  f: Fetch,
  alias: string,
  identityKey: string,
  proof: unknown,
): Promise<ProofCheck | null> {
  const provider = provableProvider(alias);
  if (!provider) return null;
  const p = proof && typeof proof === 'object' ? (proof as NameProof) : null;
  const seen = readSubs()[alias.toLowerCase()];
  if (!p?.idToken) return { status: seen ? 'missing' : 'unproven', provider };
  if (p.provider !== provider) return { status: 'bad', provider, reason: 'wrong provider' };
  const aud = PROOF_PROVIDERS[provider].clientId();
  if (!aud) return { status: seen ? 'unchecked' : 'unproven', provider };
  const v = await verifyNameProof(p.idToken, {
    provider,
    alias,
    identityKey,
    aud,
    live: await liveProviderKeys(f, provider),
    archived: Array.isArray(p.keys) ? p.keys : [],
  });
  if (!v.ok) return { status: 'bad', provider, reason: v.reason };
  if (seen && seen !== v.sub) return { status: 'sub-changed', provider, sub: v.sub };
  // First proof this wallet sees for the name: remember its account, so a later missing or swapped proof stops.
  if (!seen) trustProofSub(alias, v.sub);
  return { status: 'proven', provider, sub: v.sub };
}

export const provenByLabel = (provider: ProofProvider) => `Proven by ${PROOF_PROVIDERS[provider].label}`;
