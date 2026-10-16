/**
 * Like = 1¢ to fund and join the room (owner's model, memory like-to-fund-feeds). PURE: no wallet, no network.
 *
 * A Like on a Feed item that has a real BSV-21 token id buys a little of that token: the cheapest buyable
 * listing whose whole price is at most LIKE_USD. That funds the item and puts the token in the wallet, which
 * is what opens the token's room. Items with no token id keep the plain like / tip (the bChat paid like in
 * feed/tip.ts pays the post's author directly and is unchanged).
 *
 * How it decides between paying the creator and buying the token:
 *   - item has a BSV-21 token id and a listing fits LIKE_USD → buy that listing (kind 'buy');
 *   - item has a token id but no listing fits → nothing is paid (kind 'no-listing'); the card keeps Buy;
 *   - item has no token id → not this module: the existing paid like pays the author (feed/tip.ts).
 * A token card carries no payable creator address, so there is no direct creator payment on it.
 *
 * Copy rule: no investment wording (BANNED_LIKE_WORDS is tested against every string here).
 */
import { pickListing } from '../../agents/agentTrade';
import type { Listing } from '../../market/indexer';

export const LIKE_USD = 0.01;
export const LIKE_LABEL = 'Like · 1¢';
export const LIKE_COPY = 'Like · 1¢ · supports the creator and opens the room';
export const LIKE_DONE = 'You’re in';
export const LIKE_NO_LISTING = 'No one is offering this at 1¢ right now. Your like is saved.';

/** Words a Like string must never use (no investment framing). */
export const BANNED_LIKE_WORDS = /return|profit|invest|price will|rise|gain|earn|moon|pump/i;

const TOKEN_ID = /^[0-9a-f]{64}_\d{1,6}$/i;
export const isTokenId = (id: unknown): id is string => typeof id === 'string' && TOKEN_ID.test(id);

export type LikePlan =
  | { kind: 'buy'; listing: Listing; priceSats: number; feeSats: number; totalSats: number }
  | { kind: 'no-listing' }
  | { kind: 'no-rate' }
  | { kind: 'no-token' };

/**
 * What one Like does for `tokenId`, given its listings, the BSV/USD rate and the marketplace fee function
 * (market/fee.ts marketFeeSats, which is 0 in a store build or when no fee address is set).
 */
export const planLike = (
  tokenId: string,
  listings: readonly Listing[],
  bsvUsd: number,
  feeSats: (priceSats: number) => number = () => 0,
  maxUsd = LIKE_USD,
): LikePlan => {
  if (!isTokenId(tokenId)) return { kind: 'no-token' };
  if (!(bsvUsd > 0)) return { kind: 'no-rate' };
  const pick = pickListing([...listings], maxUsd, bsvUsd);
  if (!pick) return { kind: 'no-listing' };
  const fee = feeSats(pick.priceSats);
  return { kind: 'buy', listing: pick, priceSats: pick.priceSats, feeSats: fee, totalSats: pick.priceSats + fee };
};

// ── liked tokens (per device; a convenience, the token in the wallet is the real entry) ──

const KEY = 'bw.feed.fundLikes.v1';

export const loadFundLikes = (): Set<string> => {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(a) ? a.filter(isTokenId).map((s) => s.toLowerCase()) : []);
  } catch {
    return new Set();
  }
};

export const addFundLike = (tokenId: string): Set<string> => {
  const s = loadFundLikes();
  if (isTokenId(tokenId)) s.add(tokenId.toLowerCase());
  try {
    localStorage.setItem(KEY, JSON.stringify([...s].slice(-500)));
  } catch {
    /* storage off: the like still happened on chain */
  }
  return s;
};
