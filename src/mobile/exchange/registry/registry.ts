/**
 * The Exchange's token registry: built-in JSON (loaded lazily), BlastPad's live board and any remote
 * platform manifests, merged by resolveLabels (catalog.ts). Loaded once per session.
 */
import {
  resolveLabels,
  type Category,
  type Labels,
  type Platform,
  type Sources,
  type TokenLabels,
  asCategory,
  normalizeTags,
} from './catalog';
import { loadManifest } from './manifest';

type BuiltIn = {
  platforms: Platform[];
  tokens: { id: string; platform: string; category?: string; tags?: string[] }[];
  overrides: {
    tokens: Record<string, { category?: string; tags?: string[]; platform?: string }>;
    hidden: string[];
    remotePlatforms: { domain: string; identityKey?: string }[];
  };
};

export type Registry = {
  platforms: Platform[];
  hidden: Set<string>;
  /** Labels for a token (issuer labels can be added on the token page). */
  labels: (id: string, issuer?: Labels) => TokenLabels;
  /** Every token id a platform lists (its whole catalogue, even ones the 1Sat board doesn't show). */
  platformTokens: (slug: string) => string[];
};

/** Pure builder (tested): built-in data + live feed labels + verified manifests → Registry. */
export const buildRegistry = (
  b: BuiltIn,
  feed: Map<string, Labels>,
  manifests: { platform: Platform; tokens: Map<string, Labels> }[],
): Registry => {
  const builtin = new Map<string, Labels>();
  for (const t of b.tokens)
    builtin.set(t.id, { platform: t.platform, category: asCategory(t.category), tags: normalizeTags(t.tags) });
  const signed = new Map<string, Labels>();
  const platforms = [...b.platforms];
  for (const m of manifests) {
    if (!platforms.some((p) => p.slug === m.platform.slug)) platforms.push(m.platform);
    for (const [id, l] of m.tokens) if (!signed.has(id)) signed.set(id, l);
  }
  const override = new Map<string, Labels>(
    Object.entries(b.overrides.tokens).map(([id, o]) => [
      id,
      { category: asCategory(o.category), tags: normalizeTags(o.tags), platform: o.platform },
    ]),
  );
  const hidden = new Set(b.overrides.hidden);
  const labels = (id: string, issuer?: Labels): TokenLabels => {
    const s: Sources = {
      override: override.get(id),
      platform: builtin.get(id) ?? signed.get(id),
      feed: feed.get(id),
      issuer,
    };
    return resolveLabels(s);
  };
  const all = new Set([...builtin.keys(), ...signed.keys(), ...feed.keys(), ...override.keys()]);
  const byPlatform = new Map<string, string[]>();
  for (const id of all) {
    if (hidden.has(id)) continue;
    const p = labels(id).platform;
    byPlatform.set(p, [...(byPlatform.get(p) ?? []), id]);
  }
  return { platforms, hidden, labels, platformTokens: (slug) => byPlatform.get(slug) ?? [] };
};

/** BlastPad's live board → platform "tokenblaster", tagged "launchpad". Empty when it's down. */
const blastPadFeed = async (): Promise<Map<string, Labels>> => {
  try {
    const { fetchCoins } = await import('../../market/launchpad/api');
    const coins = await fetchCoins();
    return new Map(
      coins
        .filter((c) => typeof c.token_id === 'string')
        .map((c) => [c.token_id, { platform: 'tokenblaster', tags: ['launchpad', 'bonding-curve'] }]),
    );
  } catch {
    return new Map();
  }
};

let loading: Promise<Registry> | null = null;

export const loadRegistry = (): Promise<Registry> =>
  (loading ??= (async () => {
    const [p, t, o] = await Promise.all([
      import('./platforms.json'),
      import('./tokens.json'),
      import('./overrides.json'),
    ]);
    const b: BuiltIn = {
      platforms: p.default.platforms,
      tokens: t.default.tokens,
      overrides: o.default as BuiltIn['overrides'],
    };
    const [feed, manifests] = await Promise.all([
      blastPadFeed(),
      Promise.all(b.overrides.remotePlatforms.map((r) => loadManifest(r.domain, r.identityKey))),
    ]);
    return buildRegistry(
      b,
      feed,
      manifests.filter((m) => m !== null),
    );
  })());

export type { Category };
