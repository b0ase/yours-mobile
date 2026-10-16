import { BRANDS, COOL_WORDS, FIRST_NAMES } from './nameLists';

/**
 * Exchange › Names categories and price tiers (owner, 15 Oct 2026). Pure: no network, no wallet.
 *
 * The tier price is a label only. Buying always pays the on-chain listing price; relisting names to match
 * the tiers is an on-chain step the owner approves separately (see relistCount).
 */

export type NameCategory = 'first' | 'cool' | 'brand' | 'short' | 'other';

/** Chip order. The default view is First names then Cool words. */
export const NAME_CATEGORIES: { id: NameCategory; label: string }[] = [
  { id: 'first', label: 'First names' },
  { id: 'cool', label: 'Cool words & handles' },
  { id: 'brand', label: 'Brands' },
  { id: 'short', label: 'Short' },
  { id: 'other', label: 'Tickers & other' },
];

export const DEFAULT_CATEGORIES: NameCategory[] = ['first', 'cool'];

/**
 * All tier prices in US dollars, in one place. Length tiers override the category price for names of
 * 4 letters or fewer; a null length slot (1 letter, not priced yet) falls back to the category price.
 */
export const NAME_TIERS = {
  category: { first: 5, cool: 10, brand: 40, short: 50, other: 5 } as Record<NameCategory, number>,
  byLength: { 1: null, 2: 60, 3: 50, 4: 40 } as Record<number, number | null>,
};

const set = (s: string) => new Set(s.split(' ').filter(Boolean));
const FIRST = set(FIRST_NAMES);
const COOL = set(COOL_WORDS);
const BRAND = set(BRANDS);

/** Precedence: Brands > First names > Cool words > Short (2–3 letters) > Tickers & other. */
export const classifyName = (raw: string): NameCategory => {
  const n = raw.trim().toLowerCase();
  if (BRAND.has(n)) return 'brand';
  if (FIRST.has(n)) return 'first';
  if (COOL.has(n)) return 'cool';
  if (n.length >= 2 && n.length <= 3) return 'short';
  return 'other';
};

export const tierUsd = (name: string, cat: NameCategory = classifyName(name)): number => {
  const len = [...name.trim()].length;
  const byLen = len <= 4 ? NAME_TIERS.byLength[len] : null;
  return byLen ?? NAME_TIERS.category[cat];
};

const RANK = Object.fromEntries(NAME_CATEGORIES.map((c, i) => [c.id, i])) as Record<NameCategory, number>;

/** Sort by category (chip order) then name. */
export const sortByCategory = <T extends { name: string }>(xs: T[]): T[] =>
  xs
    .map((x) => ({ x, c: classifyName(x.name) }))
    .sort((a, b) => RANK[a.c] - RANK[b.c] || a.x.name.localeCompare(b.x.name))
    .map((r) => r.x);

export const countByCategory = (names: string[]): Record<NameCategory, number> => {
  const out: Record<NameCategory, number> = { first: 0, cool: 0, brand: 0, short: 0, other: 0 };
  for (const n of names) out[classifyName(n)] += 1;
  return out;
};

/**
 * How many listings are priced away from their tier (more than `tolerance`, default 10%) at `rate` USD/BSV.
 * Report only: relisting is on-chain and needs the owner's approval.
 */
export const relistCount = (list: { name: string; priceSats: number }[], rate: number, tolerance = 0.1): number => {
  if (!(rate > 0)) return 0;
  return list.filter((l) => {
    const usd = (l.priceSats / 1e8) * rate;
    const tier = tierUsd(l.name);
    return Math.abs(usd - tier) / tier > tolerance;
  }).length;
};
