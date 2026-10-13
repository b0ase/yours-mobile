/**
 * On-chain token profile reader (docs/LAUNCH-SOCIAL-PLAN.md §1, option C).
 *
 * A profile is a 1-sat inscription, content-type application/json, body
 * `{"p":"bsv-21-profile","id":"<tokenId>","v":n, ...fields}`, sent to the issuer's address and signed with
 * MAP `type=bsv-21-profile`, `aip_address=<issuer>`, `aip_sig=<base64 Bitcoin Signed Message over the exact
 * content bytes>`.
 *
 * Discovery (bounded, cached per token for PROFILE_TTL_MS):
 *  1. issuer = `owner` of the deploy output: GorillaPool `GET /api/txos/<tokenId>`.
 *  2. candidates = GorillaPool `GET /api/txos/address/<issuer>/unspent?q=<b64 {"map":{"type":"bsv-21-profile"}}>`
 *     plus `/history?q=…` (the history index skips unconfirmed outputs; unspent includes them), MAX_CANDIDATES each.
 *     Keep those whose indexed JSON has p=bsv-21-profile and id=<tokenId>.
 *  3. exact content bytes from ORDFS (`https://ordfs.network/<outpoint>`): the indexer's JSON is re-serialised,
 *     so it can't be used for the signature check.
 * Verification: the signature must recover to aip_address, and aip_address must equal the issuer address.
 * The highest valid `v` wins. Company / equity / shares / dividend / yield fields are dropped.
 */
import { BigNumber, BSM, Hash, PublicKey, Signature, Utils } from '@bsv/sdk';
import { hasReturnsWording } from './returnsWording';

export const PROFILE_P = 'bsv-21-profile';
export const PROFILE_TTL_MS = 10 * 60 * 1000;
export const MAX_CANDIDATES = 20;
const GP = 'https://ordinals.gorillapool.io/api';
const ORDFS = 'https://ordfs.network';
const EXCLUDED = /^(company|equity|shares?|investors?|dividends?|yield|returns?|profit)/i;

export type TokenProfile = Record<string, unknown> & { p: string; id: string; v: number };
export type ProfileCandidate = { outpoint: string; content: string; aipAddress?: string; aipSig?: string };

const normId = (id: string) => id.replace('.', '_');

/** The address that signed `message` with a base64 compact BSM signature, or null if malformed. */
export const bsmSigner = (message: string, sigB64: string): string | null => {
  try {
    const raw = Utils.toArray(sigB64, 'base64');
    if (raw.length !== 65 || raw[0] < 27 || raw[0] > 34) return null;
    const msg = Utils.toArray(message, 'utf8');
    const sig = Signature.fromCompact(raw);
    const pk: PublicKey = sig.RecoverPublicKey((raw[0] - 27) & 3, new BigNumber(BSM.magicHash(msg)));
    if (!BSM.verify(msg, sig, pk)) return null;
    if (raw[0] - 27 >= 4) return pk.toAddress();
    // Uncompressed-key signature: address over the uncompressed encoding.
    const h = Hash.hash160(pk.encode(false) as number[]);
    return Utils.toBase58Check(h, [0x00]);
  } catch {
    return null;
  }
};

/** Parsed, signature-checked profile for `tokenId` from one candidate, or null. */
export const verifyProfile = (c: ProfileCandidate, tokenId: string, issuer: string): TokenProfile | null => {
  if (!c.aipSig || !c.aipAddress || c.aipAddress !== issuer) return null;
  if (bsmSigner(c.content, c.aipSig) !== issuer) return null;
  let j: unknown;
  try {
    j = JSON.parse(c.content);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (o.p !== PROFILE_P || typeof o.id !== 'string' || normId(o.id) !== normId(tokenId)) return null;
  const v = typeof o.v === 'number' ? o.v : Number(o.v);
  if (!Number.isInteger(v) || v < 0) return null;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) if (!EXCLUDED.test(k)) out[k] = val;
  if (typeof out.utility === 'string' && hasReturnsWording(out.utility)) delete out.utility;
  if (typeof out.description === 'string' && hasReturnsWording(out.description)) delete out.description;
  return { ...out, p: PROFILE_P, id: o.id, v } as TokenProfile;
};

/** The valid profile with the highest `v` (first seen wins a tie), or null. */
export const pickProfile = (cands: ProfileCandidate[], tokenId: string, issuer: string): TokenProfile | null => {
  let best: TokenProfile | null = null;
  for (const c of cands) {
    const p = verifyProfile(c, tokenId, issuer);
    if (p && (!best || p.v > best.v)) best = p;
  }
  return best;
};

type Txo = {
  outpoint?: string;
  owner?: string;
  data?: { map?: Record<string, unknown>; insc?: { file?: { type?: string }; json?: Record<string, unknown> } };
};
const getJson = async (url: string): Promise<unknown> => {
  const r = await fetch(url);
  return r.ok ? r.json() : null;
};

/** Issuer address: owner of the deploy output. */
export const fetchIssuer = async (tokenId: string): Promise<string | null> => {
  const t = (await getJson(`${GP}/txos/${normId(tokenId)}`).catch(() => null)) as Txo | null;
  return typeof t?.owner === 'string' && /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(t.owner) ? t.owner : null;
};

/** Profile candidates at the issuer address (indexed JSON pre-filter, then exact bytes from ORDFS). */
export const fetchCandidates = async (tokenId: string, issuer: string): Promise<ProfileCandidate[]> => {
  const q = btoa(JSON.stringify({ map: { type: PROFILE_P } }));
  const lists = await Promise.all(
    ['unspent', 'history'].map((k) =>
      getJson(`${GP}/txos/address/${issuer}/${k}?q=${encodeURIComponent(q)}&limit=${MAX_CANDIDATES}`).catch(() => null),
    ),
  );
  const seen = new Set<string>();
  const hits: Txo[] = [];
  for (const l of lists)
    for (const t of Array.isArray(l) ? (l as Txo[]) : []) {
      const j = t.data?.insc?.json;
      if (!t.outpoint || seen.has(t.outpoint) || !/^[0-9a-f]{64}_\d+$/.test(t.outpoint)) continue;
      if (t.data?.insc?.file?.type?.split(';')[0] !== 'application/json') continue;
      if (j?.p !== PROFILE_P || typeof j.id !== 'string' || normId(j.id) !== normId(tokenId)) continue;
      seen.add(t.outpoint);
      hits.push(t);
    }
  const out = await Promise.all(
    hits.slice(0, MAX_CANDIDATES).map(async (t): Promise<ProfileCandidate | null> => {
      const r = await fetch(`${ORDFS}/${t.outpoint}`).catch(() => null);
      if (!r?.ok) return null;
      const content = await r.text();
      if (content.length > 4096) return null;
      const m = t.data?.map ?? {};
      return {
        outpoint: t.outpoint!,
        content,
        aipAddress: typeof m.aip_address === 'string' ? m.aip_address : undefined,
        aipSig: typeof m.aip_sig === 'string' ? m.aip_sig : undefined,
      };
    }),
  );
  return out.filter((c): c is ProfileCandidate => !!c);
};

const cache = new Map<string, { at: number; p: Promise<TokenProfile | null> }>();
/** The token's verified on-chain profile, or null. Cached per token for PROFILE_TTL_MS. */
export const fetchTokenProfile = (tokenId: string): Promise<TokenProfile | null> => {
  const id = normId(tokenId);
  if (!/^[0-9a-f]{64}_\d+$/.test(id)) return Promise.resolve(null);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.p;
  const p = (async () => {
    const issuer = await fetchIssuer(id);
    if (!issuer) return null;
    return pickProfile(await fetchCandidates(id, issuer), id, issuer);
  })().catch(() => null);
  cache.set(id, { at: Date.now(), p });
  return p;
};

export const clearTokenProfileCache = () => cache.clear();
