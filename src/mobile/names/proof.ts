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
 * Rotated keys (b-Aware 357, 21 Nov 2026): the server's archived keys (`proof.keys`, with its own firstSeen) are never
 * trusted, since the server is the party this check guards against. The wallet keeps its own copy of every key it
 * fetched from the provider itself, and only those vouch for a token signed by a key the provider no longer
 * publishes. A token signed by a key this wallet never saw at the provider can't be checked: no badge for a name
 * never seen proven, and a stop for one this wallet saw proven before (unless it pays the key the payer already
 * trusts). Step 3 anchors the archive on chain.
 *
 * Token validity: the proof is the ID token from the claim, kept as a lasting statement (the server only takes fresh
 * ones), so a passed `exp` alone doesn't void it. Its window must be sane: exp after iat, at most a day apart, and not
 * issued in the future.
 *
 * LinkedIn (owner, 28 Oct 2026): its token carries no public name, so `slug.linkedin` is bound to the LinkedIn
 * account (sub) when claimed; the check is the signed token for this key plus the same account as before.
 * GitHub has no signed ID token: `login.github` is proven by a public gist (checkGistProof), fetched from
 * api.github.com directly. TODO (PROVABLE-NAMES.md step 2): X has none either; `.x` names stay server-checked.
 */
import { ProtoWallet, Utils } from '@bsv/sdk';
import { trustedKeyFor } from './binding';

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
export type ProofCheck = {
  status: ProofStatus;
  provider: ProofProvider | 'github';
  sub?: string;
  reason?: string;
  /** The name the proof was checked for (lowercase): a forward's target, not the typed name. */
  alias?: string;
  /**
   * Set only on an 'unchecked' stop for a proof key this wallet never saw, for a name it saw proven before it kept
   * the proven wallet key (before this update): the payer may deliberately get through (names.ts proofKeyOverride).
   */
  overridable?: true;
  /** The served binding's version (seq) the check used, when it was a signed one; kept with the proven key. */
  seq?: number;
};
/**
 * The served binding of the name being checked, passed only when its signature (and any handover release) checked
 * out: its version, and for a handover the key that released the name.
 */
export type ProofBinding = { seq?: number; handoverFrom?: string };

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
    suffix: 'linkedin',
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

/** Longest validity window a provider token may carry (Google and LinkedIn issue one hour). */
const MAX_TOKEN_LIFE_S = 24 * 60 * 60;
/** Clock skew allowed on a token's issue time. */
const SKEW_S = 5 * 60;
/** The reason verifyNameProof gives when the token's key is neither published now nor in this wallet's own copy. */
export const UNKNOWN_KEY = 'unknown signing key';

/**
 * Check one ID token for `alias` → `identityKey`. live: the provider's keys now; archived: keys this wallet itself
 * fetched from the provider earlier (never the paymail server's). Pure (no network, no storage), so tests drive it
 * with locally generated keys.
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
    /** ms; defaults to now. */
    now?: number;
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
  // A rotated key: only from this wallet's own copy of what the provider published (see the header).
  const key = o.live.find((k) => k.kid === kid) ?? (o.archived ?? []).find((k) => k.kid === kid);
  if (!key) return { ok: false, reason: UNKNOWN_KEY };
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
  const iatS = c.iat;
  const expS = c.exp;
  const nowS = (o.now ?? Date.now()) / 1000;
  if (
    typeof iatS !== 'number' ||
    typeof expS !== 'number' ||
    !Number.isFinite(iatS) ||
    !Number.isFinite(expS) ||
    expS <= iatS ||
    expS - iatS > MAX_TOKEN_LIFE_S ||
    iatS > nowS + SKEW_S
  )
    return { ok: false, reason: 'bad token dates' };
  if (typeof c.sub !== 'string' || !c.sub) return { ok: false, reason: 'no account id' };
  if (c.nonce !== (await proofNonce(o.identityKey))) return { ok: false, reason: 'proves a different wallet' };
  // LinkedIn names carry no name in the token: the account (sub) continuity check below is what binds them.
  if (o.provider !== 'linkedin' && aliasForClaims(o.provider, c) !== o.alias.toLowerCase())
    return { ok: false, reason: 'proves a different name' };
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

// The wallet key each provable name was last proven for (or that the payer deliberately accepted for it), lowercase,
// with the version (seq) of the signed binding it was served with. A proof this wallet can't check (unknown provider
// key) is payable only for this key (second review, finding 1), and the key never moves back to an older binding
// version (third review, finding 2: a server replaying a superseded key with its old token).
const PROOF_KEY = 'bwallet.names.proofKeys';
type KeptKey = { key: string; seq?: number };
const isSeq = (n: unknown): n is number => Number.isInteger(n);
const readProofKeys = (): Record<string, KeptKey | string> => {
  try {
    const v = JSON.parse(localStorage.getItem(PROOF_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, KeptKey | string>) : {};
  } catch {
    return {};
  }
};
/** The wallet key (and its binding seq) this name's proof is accepted for; undefined if none kept. */
export const provenKeyFor = (alias: string): KeptKey | undefined => {
  const v = readProofKeys()[alias.toLowerCase()];
  if (typeof v === 'string') return { key: v };
  if (!v || typeof v.key !== 'string') return undefined;
  return isSeq(v.seq) ? { key: v.key, seq: v.seq } : { key: v.key };
};
/**
 * A key other than the kept one, at a binding version not newer than the kept one's (or with no signed binding at
 * all, once the kept key has a version): a replayed or rolled-back key, never accepted as proven.
 */
export const olderThanKept = (alias: string, identityKey: string, seq?: number): boolean => {
  const kept = provenKeyFor(alias);
  if (!kept || kept.key === identityKey.toLowerCase() || !isSeq(kept.seq)) return false;
  return !(isSeq(seq) && seq > kept.seq);
};
/**
 * Remember the wallet key this name's proof is accepted for: on every proven check, a verified handover from the kept
 * key, or the payer's override. Never replaces the kept key with one at an older (or equal) binding version.
 */
export const trustProofKey = (alias: string, identityKey: string, seq?: number) => {
  const a = alias.toLowerCase();
  const k = identityKey.toLowerCase();
  if (olderThanKept(a, k, seq)) return;
  const kept = provenKeyFor(a);
  // The same key served at an older version keeps the newer version this wallet saw.
  const keepSeq = kept?.key === k && isSeq(kept.seq) && !(isSeq(seq) && seq > kept.seq) ? kept.seq : seq;
  if (kept?.key === k && kept.seq === keepSeq) return;
  try {
    const next: KeptKey = isSeq(keepSeq) ? { key: k, seq: keepSeq } : { key: k };
    localStorage.setItem(PROOF_KEY, JSON.stringify({ ...readProofKeys(), [a]: next }));
  } catch {
    /* private mode: nothing remembered */
  }
};
/** The reason a proof for a key older than the kept one is refused. */
export const OLDER_KEY = 'older than the wallet this name was proven for';

// Every key this wallet has fetched from a provider itself: provider → kid → key (b-Aware 357).
const SEEN_PROVIDER_KEYS = 'bwallet.names.providerKeys';
const MAX_SEEN_KEYS = 200;
type SeenKeys = Record<string, Record<string, { n: string; e: string; firstSeen: string }>>;
const readSeenKeys = (): SeenKeys => {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_PROVIDER_KEYS) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as SeenKeys) : {};
  } catch {
    return {};
  }
};
/** The provider keys this wallet saw published itself, for tokens signed by a key since rotated out. */
export const walletSeenProviderKeys = (provider: ProofProvider): ProviderKey[] =>
  Object.entries(readSeenKeys()[provider] ?? {})
    .filter(([, k]) => k && typeof k.n === 'string' && typeof k.e === 'string')
    .map(([kid, k]) => ({ kid, jwk: { kty: 'RSA', kid, n: k.n, e: k.e, alg: 'RS256' }, firstSeen: k.firstSeen }));
const rememberProviderKeys = (provider: ProofProvider, keys: ProviderKey[]) => {
  if (!keys.length) return;
  try {
    const all = readSeenKeys();
    const mine = { ...(all[provider] ?? {}) };
    let changed = false;
    for (const k of keys) {
      const was = mine[k.kid];
      // A kid the provider now publishes with other key material is a new key: keep the newer one.
      if (was && was.n === k.jwk.n && was.e === k.jwk.e) continue;
      mine[k.kid] = { n: k.jwk.n, e: k.jwk.e, firstSeen: new Date().toISOString() };
      changed = true;
    }
    if (!changed) return;
    const kept = Object.entries(mine)
      .sort((a, b) => Date.parse(b[1].firstSeen) - Date.parse(a[1].firstSeen))
      .slice(0, MAX_SEEN_KEYS);
    localStorage.setItem(SEEN_PROVIDER_KEYS, JSON.stringify({ ...all, [provider]: Object.fromEntries(kept) }));
  } catch {
    /* private mode: nothing remembered */
  }
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const liveCache = new Map<string, { at: number; keys: ProviderKey[] }>();
/** Tests: forget the cached published keys. */
export const resetProviderKeyCache = () => liveCache.clear();
/**
 * The provider's published keys, straight from the provider (never through our server); cached 10 minutes. Each one
 * is also kept in the wallet's own copy (walletSeenProviderKeys).
 */
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
    rememberProviderKeys(provider, keys);
    return keys;
  } catch {
    return [];
  }
};

/**
 * The full check for a resolved name: null when the name isn't provable. `proof` is the pki answer's `proof`. The
 * result carries the name it was checked for (`alias`), so an override is kept for that name, even for a forward.
 */
export async function checkNameProof(
  f: Fetch,
  alias: string,
  identityKey: string,
  proof: unknown,
  binding: ProofBinding = {},
): Promise<ProofCheck | null> {
  const b: ProofBinding = {
    seq: isSeq(binding.seq) ? binding.seq : undefined,
    handoverFrom: typeof binding.handoverFrom === 'string' ? binding.handoverFrom.toLowerCase() : undefined,
  };
  const res = /\.github$/i.test(alias)
    ? await checkGistProof(f, alias, identityKey, proof, b)
    : await checkProviderProof(f, alias, identityKey, proof, b);
  return res && { ...res, alias: alias.toLowerCase(), ...(isSeq(b.seq) ? { seq: b.seq } : {}) };
}

async function checkProviderProof(
  f: Fetch,
  alias: string,
  identityKey: string,
  proof: unknown,
  b: ProofBinding,
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
    // Never `p.keys`: those come from the server this check guards against (b-Aware 357).
    archived: walletSeenProviderKeys(provider),
  });
  if (!v.ok && v.reason === UNKNOWN_KEY) {
    // Can't check it. A name never seen proven pays with no badge. One seen proven pays only for the wallet key it was
    // proven for (then the proof adds nothing an attacker could use); any other key is a hard stop, with no override,
    // so a hostile server can't turn a missing or bad proof into a tap-through (second review, finding 1).
    const key = identityKey.toLowerCase();
    if (!seen) return { status: 'unproven', provider, reason: v.reason };
    const kept = provenKeyFor(alias);
    if (kept) {
      if (kept.key === key) return { status: 'unproven', provider, reason: v.reason };
      // The kept key itself signed the name over to this one at a newer binding version (checkBinding verified the
      // release): the owner moved, so it pays (no badge) and the kept key follows the handover (third review, 1).
      if (b.handoverFrom === kept.key && (!isSeq(kept.seq) || (isSeq(b.seq) && b.seq > kept.seq))) {
        trustProofKey(alias, key, b.seq);
        return { status: 'unproven', provider, reason: v.reason };
      }
      return { status: 'unchecked', provider, reason: v.reason };
    }
    // Seen proven before this update kept the key: the key the payer paid, or a deliberate override.
    if (trustedKeyFor(alias) === key) return { status: 'unproven', provider, reason: v.reason };
    return { status: 'unchecked', provider, reason: v.reason, overridable: true };
  }
  if (!v.ok) return { status: 'bad', provider, reason: v.reason };
  // A genuine but superseded proof (an old key with its old token) never counts: the kept key only moves forward.
  if (olderThanKept(alias, identityKey, b.seq)) return { status: 'bad', provider, reason: OLDER_KEY };
  if (seen && seen !== v.sub) return { status: 'sub-changed', provider, sub: v.sub };
  // First proof this wallet sees for the name: remember its account, so a later missing or swapped proof stops.
  if (!seen) trustProofSub(alias, v.sub);
  // ...and the wallet key it proves, the only one a later proof this wallet can't check may pay.
  trustProofKey(alias, identityKey, b.seq);
  return { status: 'proven', provider, sub: v.sub };
}

export const provenByLabel = (provider: ProofProvider | 'github') =>
  `Proven by ${provider === 'github' ? 'GitHub' : PROOF_PROVIDERS[provider].label}`;

/** The statement a `login.github` owner signs and posts in a public gist (same as the server's). */
export const gistStatement = (alias: string, identityKey: string) =>
  `bwalletx-name-proof|v1|${alias.toLowerCase()}|${identityKey.toLowerCase()}`;

/** A gist's text proves alias → identityKey: the statement line, then this key's signature of it. */
export async function verifyGistText(text: string, alias: string, identityKey: string): Promise<boolean> {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const st = gistStatement(alias, identityKey);
  const i = lines.indexOf(st);
  const sig = i >= 0 ? (lines[i + 1] ?? '') : '';
  if (!/^[0-9a-f]{16,200}$/i.test(sig)) return false;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(st, 'utf8'),
      signature: Utils.toArray(sig, 'hex'),
      protocolID: [2, 'bwallet paymail'],
      keyID: '1',
      counterparty: identityKey.toLowerCase(),
    });
    return valid;
  } catch {
    return false;
  }
}

/**
 * GitHub names: fetch the gist the proof names straight from api.github.com, check its owner is this login and it
 * holds this key's signed statement, and that the GitHub account (owner id) is the one this wallet saw before.
 */
export async function checkGistProof(
  f: Fetch,
  alias: string,
  identityKey: string,
  proof: unknown,
  b: ProofBinding = {},
): Promise<ProofCheck> {
  const provider = 'github' as const;
  const p = proof && typeof proof === 'object' ? (proof as { provider?: string; gist?: string }) : null;
  const seen = readSubs()[alias.toLowerCase()];
  if (!p?.gist) return { status: seen ? 'missing' : 'unproven', provider };
  if (p.provider !== 'github' || !/^[0-9a-f]{20,40}$/.test(p.gist))
    return { status: 'bad', provider, reason: 'not a gist proof' };
  let g: { owner?: { login?: string; id?: number }; files?: Record<string, { content?: string; truncated?: boolean }> };
  try {
    const r = await f(`https://api.github.com/gists/${p.gist}`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return { status: seen ? 'unchecked' : 'unproven', provider };
    g = (await r.json()) as typeof g;
  } catch {
    return { status: seen ? 'unchecked' : 'unproven', provider };
  }
  const login = String(g.owner?.login ?? '').toLowerCase();
  if (`${login}.github` !== alias.toLowerCase()) return { status: 'bad', provider, reason: 'gist by another account' };
  let ok = false;
  for (const file of Object.values(g.files ?? {}))
    if (file && !file.truncated && (await verifyGistText(String(file.content ?? ''), alias, identityKey))) ok = true;
  if (!ok) return { status: 'bad', provider, reason: 'gist does not prove this wallet' };
  // An old gist for a superseded key stays on GitHub: the same never-backwards rule as provider tokens.
  if (olderThanKept(alias, identityKey, b.seq)) return { status: 'bad', provider, reason: OLDER_KEY };
  const sub = String(g.owner?.id ?? '');
  if (seen && seen !== sub) return { status: 'sub-changed', provider, sub };
  if (!seen && sub) trustProofSub(alias, sub);
  trustProofKey(alias, identityKey, b.seq);
  return { status: 'proven', provider, sub };
}
