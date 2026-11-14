/**
 * Exchange › Tokens cards (owner, 13 Nov 2026: "Users just want to see what they can buy, and a button to buy
 * it"): what one card shows is the price to buy now, worked out here from the token's live listings
 * (indexer.roomMarket, the same cached data the list view and the trade screen read).
 *
 * The price is the listing the trade screen's "Buy at best price" picks: the cheapest per token among the
 * listings that can be bought in-app (`Listing.buyable`). The card shows what that listing costs in total, so
 * the number on the card is the number on the Buy panel.
 */
import type { Listing } from '../market/indexer';
import { bsvLabel, fiatLabel } from './exchangeData';

/** The listing "Buy at best price" opens: cheapest per token, in-app buyable only; null when none can be bought. */
export const bestBuyable = (listings: readonly Listing[]): Listing | null => {
  let best: Listing | null = null;
  for (const l of listings) {
    if (!l.buyable || !(l.priceSats > 0)) continue;
    if (!best || perToken(l) < perToken(best)) best = l;
  }
  return best;
};

const perToken = (l: Listing) => (l.perTokenSats && l.perTokenSats > 0 ? l.perTokenSats : l.priceSats);

/** Whole tokens in a listing (BSV-21: price ÷ price per token); null when unknown. */
export const listingTokens = (l: Listing): number | null =>
  l.perTokenSats && l.perTokenSats > 0 ? l.priceSats / l.perTokenSats : null;

/** "1.2K", "3.4M", "950": short token counts for the card. */
export const compactCount = (n: number): string => {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, s] of units) if (n >= v) return `${(n / v).toFixed(n / v >= 100 ? 0 : 1).replace(/\.0$/, '')}${s}`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
};

/** A price in dollars at `rate` USD per BSV; BSV when the rate is unknown. */
export const buyPriceLabel = (sats: number, rate: number): string => fiatLabel(sats, rate) || bsvLabel(sats);

export type SaleState = 'for-sale' | 'checking' | 'not-for-sale';

/** A card's state: its market not loaded yet → checking; else whether any listing can be bought in-app. */
export const saleState = (listings: readonly Listing[] | null | undefined): SaleState =>
  listings === null || listings === undefined ? 'checking' : bestBuyable(listings) ? 'for-sale' : 'not-for-sale';

const RANK: Record<SaleState, number> = { 'for-sale': 0, checking: 1, 'not-for-sale': 2 };

/** For sale first, then still checking, then not for sale. Stable: each group keeps the order it came in. */
export const forSaleFirst = <T>(rows: readonly T[], state: (r: T) => SaleState): T[] =>
  rows
    .map((r, i) => ({ r, i, k: RANK[state(r)] }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);

/**
 * The board's card order, kept stable (owner, 13 Nov 2026: "flickery/flashy... not stable"). `seen` is every id
 * the board has placed so far, in place order. A card never moves once placed: ids that arrive later (the
 * ranking filling in, more tokens) go after the ones already placed, and an id that drops out keeps its place
 * for when it comes back. `reset` (first paint, or the user changed a filter / search) places `next` afresh,
 * for sale first by what is already known at that moment, and nothing moves after that as prices load.
 */
export const stableOrder = (
  seen: readonly string[] | null,
  next: readonly string[],
  reset: boolean,
  state: (id: string) => SaleState,
): string[] => {
  if (!seen || reset) return forSaleFirst(next, state);
  const placed = new Set(seen);
  const added = next.filter((id) => !placed.has(id));
  return added.length ? [...seen, ...added] : (seen as string[]);
};

/** The ids to show, in `seen` order, limited to the ones in the current list. */
export const shownOrder = (seen: readonly string[], next: readonly string[]): string[] => {
  const present = new Set(next);
  return seen.filter((id) => present.has(id));
};

/** Same listings (by outpoint, price and buyability)? Used to skip re-rendering a card on a background refresh. */
export const sameListings = (a: readonly Listing[] | undefined, b: readonly Listing[]): boolean =>
  !!a &&
  a.length === b.length &&
  a.every((l, i) => l.outpoint === b[i].outpoint && l.priceSats === b[i].priceSats && l.buyable === b[i].buyable);
