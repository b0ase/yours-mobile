import categories from './nameCategories.json';
import type { Availability } from '../names';
import type { OpnsListing } from '../opnsSell';
import { isPremiumName, nameTierUsd } from './tiers';

/**
 * Name Store logic (src/mobile/names/store/NameStorePage.tsx): what a search result says, which listed names
 * go on which browse rail, and the suggestions under a taken name. Pure functions, so the page stays thin
 * and every state is tested (store.test.ts).
 */

/** Wallets the house lists from (public addresses, never keys). A listing from one of these is "from us". */
export const HOUSE_SELLERS: ReadonlySet<string> = new Set([
  '1A3SPh9TwVAwmBv9d8VTczwKq761s1byt7',
  // opns agent account (headless minter lists from here): ordinals + pay address.
  '12EZT8mTDNsnCzW7XqvMwfLV44fcA2AWg4',
  '14rHQU9DHjQhbtXMmnNc6M943XjZBF9oWs',
  // bwalletx.x@bwalletx.com storefront: sale proceeds pay here.
  '1F4J9KkMoqtznXPJuCgb98LRymssc8MFfd',
]);

/** Browse rails, in page order. `short` is by length; the rest come from the generated category map. */
export const RAILS = [
  { id: 'short', title: 'Short names', sub: '3 and 4 letters' },
  { id: 'words', title: 'Words', sub: 'Plain English, easy to say' },
  { id: 'firstnames', title: 'First names', sub: 'Yours, or a gift for someone' },
  { id: 'places', title: 'Places', sub: 'Cities, countries, home towns' },
  { id: 'tech', title: 'Tech & AI', sub: 'Builders, coins and code' },
  { id: 'food', title: 'Food', sub: 'For cafés, cooks and kitchens' },
] as const;
export type RailId = (typeof RAILS)[number]['id'];

const CATEGORY_SETS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries(categories as Record<string, string>).map(([k, v]) => [k, new Set(v.split(' '))]),
);

/** Category of one name from the generated map (null when we didn't classify it). */
export const categoryOf = (name: string): Exclude<RailId, 'short'> | null => {
  for (const [k, set] of Object.entries(CATEGORY_SETS)) if (set.has(name)) return k as Exclude<RailId, 'short'>;
  return null;
};

/** A listing the house is selling: one of our seller wallets, or a name from our own classified inventory. */
export const isHouseListing = (l: Pick<OpnsListing, 'name' | 'seller'>) =>
  HOUSE_SELLERS.has(l.seller) || categoryOf(l.name) !== null;

/** Names for one rail: house listings only, premium names left out, shortest then alphabetical. */
export const railNames = (rail: RailId, listings: OpnsListing[], limit = 24): OpnsListing[] =>
  listings
    .filter((l) => isHouseListing(l) && !isPremiumName(l.name))
    .filter((l) =>
      rail === 'short'
        ? l.name.length >= 3 && l.name.length <= 4 && /^[a-z]+$/.test(l.name)
        : categoryOf(l.name) === rail,
    )
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit);

/** Search box text → a candidate name ("@Coffee " → "coffee"). */
export const normaliseQuery = (q: string) =>
  q
    .trim()
    .toLowerCase()
    .replace(/^[@$]+/, '')
    .replace(/@.*$/, '')
    .replace(/\s+/g, '-');

export type StoreResult =
  | { kind: 'invalid'; name: string; reason: string }
  | { kind: 'mine'; name: string }
  | { kind: 'premium'; name: string }
  | { kind: 'house'; name: string; listing: OpnsListing }
  | { kind: 'listed'; name: string; listing: OpnsListing }
  | { kind: 'free'; name: string }
  | { kind: 'taken'; name: string; suggestions: string[] };

/**
 * What the result card says, from the live lookup (checkOpnsAvailability), the order book and the user's names.
 * Order matters: invalid → already yours → premium (offers only, even if listed or free) → listed (house or
 * someone else) → free to claim → taken.
 */
export const resultFor = (
  a: Availability,
  listings: OpnsListing[],
  mine: ReadonlySet<string> = new Set(),
): StoreResult => {
  const name = a.name;
  if (a.status === 'invalid') return { kind: 'invalid', name, reason: a.reason };
  if (mine.has(name)) return { kind: 'mine', name };
  if (isPremiumName(name)) return { kind: 'premium', name };
  const book = listings.find((l) => l.name === name);
  const listing =
    book ??
    (a.status === 'taken' && a.listing
      ? { name, outpoint: a.listing.outpoint, origin: a.origin, priceSats: a.listing.price, seller: '' }
      : undefined);
  if (a.status === 'taken' && listing)
    return isHouseListing(listing) ? { kind: 'house', name, listing } : { kind: 'listed', name, listing };
  if (a.status === 'available') return { kind: 'free', name };
  return { kind: 'taken', name, suggestions: suggestionsFor(name, listings) };
};

/** Under a taken name: listed house names like it first (same start, then same category), then variants. */
export const suggestionsFor = (name: string, listings: OpnsListing[], max = 6): string[] => {
  const house = listings.filter((l) => isHouseListing(l) && !isPremiumName(l.name) && l.name !== name);
  const cat = categoryOf(name);
  const like = [
    ...house.filter((l) => l.name.includes(name) || name.includes(l.name)),
    ...house.filter((l) => l.name.slice(0, 2) === name.slice(0, 2)),
    ...(cat ? house.filter((l) => categoryOf(l.name) === cat) : []),
  ].map((l) => l.name);
  const variants = [`${name}-bsv`, `${name}1`, `the-${name}`, `${name}x`, `${name}-hq`].filter((v) => v.length <= 32);
  return [...new Set([...like, ...variants])].slice(0, max);
};

/** The price a Buy button shows for a house listing: the tier, if the listing is at it, else the listing. */
export const displayUsd = (l: OpnsListing, rate: number): number | null => {
  if (!(rate > 0)) return null;
  const usd = (l.priceSats / 1e8) * rate;
  const tier = nameTierUsd(l.name);
  return tier !== null && Math.abs(usd - tier) / tier < 0.25 ? tier : Math.round(usd * 100) / 100;
};

/**
 * Buy-then-gift ("Give a name"): buy the listed name into this wallet, find its new id, then send it to the
 * recipient's ordinals address. Two wallet actions in order; the gift never runs if the buy failed, and a failed
 * gift leaves the name safely in the buyer's wallet (they can gift it again from bMint › OpNS names).
 */
export type GiveDeps = {
  buy: () => Promise<string>;
  idOf: (name: string) => Promise<string | undefined>;
  send: (id: string, address: string) => Promise<string>;
  onStep?: (step: 'buying' | 'finding' | 'sending') => void;
  /** Wait between looks for the bought name in the wallet (tests pass 0). */
  waitMs?: number;
  tries?: number;
};
export type GiveResult =
  | { ok: true; buyTxid: string; giftTxid: string }
  | { ok: false; stage: 'buy' | 'gift'; error: string; buyTxid?: string };

export const buyThenGive = async (deps: GiveDeps, name: string, to: string): Promise<GiveResult> => {
  let buyTxid: string;
  try {
    deps.onStep?.('buying');
    buyTxid = await deps.buy();
  } catch (e) {
    return { ok: false, stage: 'buy', error: e instanceof Error ? e.message : String(e) };
  }
  try {
    deps.onStep?.('finding');
    let id: string | undefined;
    for (let i = 0; i < (deps.tries ?? 10) && !id; i++) {
      id = await deps.idOf(name);
      if (!id && deps.waitMs !== 0) await new Promise((r) => setTimeout(r, deps.waitMs ?? 1500));
    }
    if (!id) throw new Error(`${name} is in your wallet but not ready to send yet`);
    deps.onStep?.('sending');
    const giftTxid = await deps.send(id, to);
    return { ok: true, buyTxid, giftTxid };
  } catch (e) {
    return { ok: false, stage: 'gift', buyTxid, error: e instanceof Error ? e.message : String(e) };
  }
};
