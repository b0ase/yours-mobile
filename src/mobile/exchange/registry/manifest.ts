/**
 * Platform manifests: a launcher with thousands of tokens publishes
 *   https://<platform-domain>/.well-known/bsv-tokens.json
 * listing its token ids with a category and tags, signed with its BRC-100 identity key. A manifest
 * that doesn't verify is ignored. Format and signing: docs/EXCHANGE-CATEGORIES.md.
 */
import { ProtoWallet, type WalletProtocol } from '@bsv/sdk';
import { TOKEN_ID } from '../exchangeData';
import { asCategory, isSlug, normalizeTags, type Labels, type Platform } from './catalog';

export const MANIFEST_PATH = '/.well-known/bsv-tokens.json';
/** BRC-43 protocol for the signature: security level 1, keyID "1", counterparty "anyone" (anyone can verify). */
export const MANIFEST_PROTOCOL: WalletProtocol = [1, 'bsv tokens manifest'];
export const MANIFEST_KEY_ID = '1';
export const MAX_MANIFEST_TOKENS = 50_000;

export type ManifestToken = { id: string; category?: string; tags?: string[] };
export type Manifest = {
  version: 1;
  platform: Platform;
  identityKey: string;
  issuedAt: string;
  tokens: ManifestToken[];
  signature: string;
};

export type VerifiedManifest = {
  platform: Platform;
  identityKey: string;
  tokens: Map<string, Labels>;
};

/** Stable JSON: object keys sorted at every level. The signed bytes are this, without `signature`. */
export const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
};

export const signedBytes = (m: Omit<Manifest, 'signature'> & { signature?: string }): number[] => {
  const { signature: _s, ...rest } = m;
  void _s;
  return Array.from(new TextEncoder().encode(canonical(rest)));
};

const PUBKEY = /^0[23][0-9a-f]{64}$/i;
const HEX = /^[0-9a-f]+$/i;

const hostOf = (u: string): string | null => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' ? x.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};

/**
 * Checks shape, that the manifest's platform URL is on the domain it was served from, the pinned key (if we
 * pinned one) and the signature. Returns null for anything invalid.
 */
export const verifyManifest = async (
  raw: unknown,
  opts: { servedFrom: string; pinnedKey?: string },
): Promise<VerifiedManifest | null> => {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Manifest;
  if (m.version !== 1 || !m.platform || !isSlug(m.platform.slug) || typeof m.platform.name !== 'string') return null;
  if (typeof m.identityKey !== 'string' || !PUBKEY.test(m.identityKey)) return null;
  if (typeof m.signature !== 'string' || !HEX.test(m.signature) || m.signature.length % 2) return null;
  if (!Array.isArray(m.tokens) || m.tokens.length > MAX_MANIFEST_TOKENS) return null;
  const host = hostOf(m.platform.url);
  if (!host || host !== hostOf(opts.servedFrom)) return null;
  if (opts.pinnedKey && opts.pinnedKey.toLowerCase() !== m.identityKey.toLowerCase()) return null;
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: signedBytes(m),
      signature: Array.from(m.signature.match(/../g) ?? [], (h) => parseInt(h, 16)),
      protocolID: MANIFEST_PROTOCOL,
      keyID: MANIFEST_KEY_ID,
      counterparty: m.identityKey,
    });
    if (!valid) return null;
  } catch {
    return null;
  }
  const tokens = new Map<string, Labels>();
  for (const t of m.tokens) {
    const id = typeof t?.id === 'string' ? t.id.toLowerCase() : '';
    if (!TOKEN_ID.test(id)) continue;
    tokens.set(id, { platform: m.platform.slug, category: asCategory(t.category), tags: normalizeTags(t.tags) });
  }
  return {
    platform: { slug: m.platform.slug, name: m.platform.name.slice(0, 40), url: m.platform.url },
    identityKey: m.identityKey,
    tokens,
  };
};

const memo = new Map<string, Promise<VerifiedManifest | null>>();

/** Fetch + verify a platform's manifest once per session. Invalid or unreachable → null. */
export const loadManifest = (domain: string, pinnedKey?: string): Promise<VerifiedManifest | null> => {
  const url = `https://${domain}${MANIFEST_PATH}`;
  let p = memo.get(url);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await verifyManifest(await r.json(), { servedFrom: url, pinnedKey });
      } catch {
        return null;
      }
    })();
    memo.set(url, p);
  }
  return p;
};
