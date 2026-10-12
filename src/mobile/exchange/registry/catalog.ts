/**
 * Exchange categories, platforms and tags (docs/EXCHANGE-CATEGORIES.md). Pure: no fetching here.
 *
 * Where a token's labels come from, strongest first:
 *   1. our curated overrides (overrides.json), which also hide spam/scam tokens;
 *   2. a platform's signed manifest (manifest.ts), or our built-in platform list (tokens.json);
 *   3. what the issuer wrote in the BSV-21 deploy inscription.
 * A token nobody labels is "Other", platform "1sat".
 */

export const CATEGORIES = [
  { slug: 'games', label: 'Games' },
  { slug: 'social', label: 'Social' },
  { slug: 'music', label: 'Music' },
  { slug: 'video', label: 'Video & Film' },
  { slug: 'art', label: 'Art & Collectibles' },
  { slug: 'creators', label: 'Creators & Fans' },
  { slug: 'communities', label: 'Communities' },
  { slug: 'apps', label: 'Apps & Utility' },
  { slug: 'ai', label: 'AI & Agents' },
  { slug: 'tickets', label: 'Tickets & Access' },
  { slug: 'stablecoins', label: 'Stablecoins' },
  { slug: 'memes', label: 'Memes' },
  { slug: 'charity', label: 'Charity' },
  { slug: 'other', label: 'Other' },
] as const;

export type Category = (typeof CATEGORIES)[number]['slug'];
const CATEGORY_SET = new Set<string>(CATEGORIES.map((c) => c.slug));
export const categoryLabel = (c: Category): string => CATEGORIES.find((x) => x.slug === c)?.label ?? 'Other';

/** A category slug, or null when it isn't one of ours (a platform can't invent new ones). */
export const asCategory = (v: unknown): Category | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return CATEGORY_SET.has(s) ? (s as Category) : null;
};

export const MAX_TAGS = 8;
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Lowercase, dash-joined, max 32 chars each, deduped, at most MAX_TAGS. Junk is dropped. */
export const normalizeTags = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const t = raw
      .trim()
      .toLowerCase()
      .replace(/^#/, '')
      .replace(/[\s_]+/g, '-')
      .slice(0, 32);
    if (TAG.test(t) && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const isSlug = (s: unknown): s is string => typeof s === 'string' && SLUG.test(s);

export type Platform = { slug: string; name: string; url: string; about?: string };

/** Labels from one source. */
export type Labels = { category?: Category | null; tags?: string[]; platform?: string };

/** What the Exchange shows for a token. `verified`: the platform label came from a signed manifest or our own list. */
export type TokenLabels = { category: Category; tags: string[]; platform: string; verified: boolean };

export type Sources = {
  override?: Labels;
  /** From a platform's signed manifest (verified) or our built-in list (verified, we ship it). */
  platform?: Labels;
  /** From an unsigned/live platform feed (e.g. BlastPad's board) — trusted for platform, not "verified". */
  feed?: Labels;
  issuer?: Labels;
};

export const DEFAULT_PLATFORM = '1sat';

/** Merge sources: override > platform (signed / built-in) > feed > issuer. Tags merge in the same order. */
export const resolveLabels = (s: Sources): TokenLabels => {
  const order = [s.override, s.platform, s.feed, s.issuer];
  const category = order.map((l) => l?.category).find((c): c is Category => !!c) ?? 'other';
  const platform = order.map((l) => l?.platform).find((p): p is string => isSlug(p)) ?? DEFAULT_PLATFORM;
  const tags = normalizeTags(order.flatMap((l) => l?.tags ?? []));
  const verified = !!(s.override?.platform || s.platform?.platform) && platform !== DEFAULT_PLATFORM;
  return { category, tags, platform, verified };
};

/** Issuer-declared labels in a BSV-21 deploy inscription: { category, tags } (also `cat`). Anything else is ignored. */
export const issuerLabels = (deploy: unknown): Labels => {
  if (!deploy || typeof deploy !== 'object') return {};
  const d = deploy as Record<string, unknown>;
  return { category: asCategory(d.category ?? d.cat), tags: normalizeTags(d.tags) };
};

// ── filtering ───────────────────────────────────────────────────────────────

export type Filter = { cat: Category | null; platforms: string[]; tag: string };

/** A tag search: "#games", "tag:games" or a plain word matching a tag. */
export const matches = (l: TokenLabels, f: Filter): boolean =>
  (!f.cat || l.category === f.cat) &&
  (!f.platforms.length || f.platforms.includes(l.platform)) &&
  (!f.tag || l.tags.some((t) => t.startsWith(f.tag)));

/** Counts per category (respecting the platform + tag filter) and per platform (respecting category + tag). */
export const facetCounts = (labels: readonly TokenLabels[], f: Filter) => {
  const cats = new Map<Category, number>();
  const plats = new Map<string, number>();
  for (const l of labels) {
    if (matches(l, { ...f, cat: null })) cats.set(l.category, (cats.get(l.category) ?? 0) + 1);
    if (matches(l, { ...f, platforms: [] })) plats.set(l.platform, (plats.get(l.platform) ?? 0) + 1);
  }
  return { cats, plats };
};

// ── URL state: /exchange?cat=games&platform=tokenblaster,bwalletx&tag=launchpad ──

export const parseFilter = (search: string): Filter => {
  const p = new URLSearchParams(search);
  const platforms = (p.get('platform') ?? '').split(',').filter(isSlug);
  return {
    cat: asCategory(p.get('cat')),
    platforms: [...new Set(platforms)],
    tag: normalizeTags([p.get('tag') ?? ''])[0] ?? '',
  };
};

/** The query string for a filter ('' when empty); keeps unrelated params. */
export const filterSearch = (f: Filter, base = ''): string => {
  const p = new URLSearchParams(base);
  for (const k of ['cat', 'platform', 'tag']) p.delete(k);
  if (f.cat) p.set('cat', f.cat);
  if (f.platforms.length) p.set('platform', f.platforms.join(','));
  if (f.tag) p.set('tag', f.tag);
  const s = p.toString().replace(/%2C/g, ',');
  return s ? `?${s}` : '';
};
