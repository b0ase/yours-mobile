/**
 * bMovies REGISTER: the original poster of a syndicated X clip registers it on chain (owner, 14 Oct 2026).
 *
 * Every syndicated clip starts as a yellow REGISTER. Tapping it asks bit-sign what to do
 * (GET /api/bitsign/bmovies/claim?tweet=<id>, the wallet's bChatX session):
 *   - connect_x: open X sign-in bound to this wallet's account (the server seals the handle into the
 *     OAuth state; it lands on bchatx's fixed /bmovies/x-linked page), then tap REGISTER again;
 *   - not_author: the server compared X USER IDS (never handles) and it is someone else's post:
 *     "Only @handle can register this";
 *   - eligible: one approval sheet → a BSV-21 deploy from this wallet (fixed 1B supply to self,
 *     issuer-signed) → POST the token id; the server checks the author id and the issuer signature
 *     again and records it (one claim per tweet, first wins);
 *   - claimed: it is registered; the reel shows BUY / SELL for everyone.
 * Lives in the lazy bMovies chunk only (BMOVIES_FEED_ENABLED), so store builds have none of it.
 */
import type { OneSatContext } from '@1sat/actions';
import { isNative } from '../../native';
import { BchatClient, defaultHttp, loadSession } from '../../chat/api';
import { chatClient, deployBsv21 } from '../../tickets/mintTicket';
import type { Clip } from './bmovies';

export const CLAIM_SUPPLY = '1000000000';
const TICKER_MAX = 12;

export type ClaimInfo = { tweetId: string; tokenId: string; ticker: string; claimant: string };

export type Eligibility =
  | { status: 'claimed'; claim: ClaimInfo }
  | { status: 'unknown_tweet' }
  | { status: 'sign_in' | 'connect_x' | 'eligible'; author: string }
  | { status: 'not_author'; author: string; you: string };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const xName = (v: unknown): string =>
  str(v)
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 15);

/** One public claim row → ClaimInfo, or null. */
export const parseClaim = (r: unknown): ClaimInfo | null => {
  const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
  const tweetId = str(o.tweet_id);
  const tokenId = str(o.token_id);
  if (!/^\d{5,25}$/.test(tweetId) || !/^[0-9a-f]{64}_\d{1,6}$/.test(tokenId)) return null;
  return { tweetId, tokenId, ticker: str(o.ticker).slice(0, 32), claimant: str(o.claimant_handle).slice(0, 40) };
};

/** The server's answer → Eligibility (anything unexpected is unknown_tweet: nothing to do). */
export const parseEligibility = (r: unknown): Eligibility => {
  const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
  const author = xName(o.author);
  switch (o.status) {
    case 'claimed': {
      const claim = parseClaim(o.claim);
      return claim ? { status: 'claimed', claim } : { status: 'unknown_tweet' };
    }
    case 'sign_in':
    case 'connect_x':
    case 'eligible':
      return author ? { status: o.status, author } : { status: 'unknown_tweet' };
    case 'not_author':
      return author ? { status: 'not_author', author, you: xName(o.you) } : { status: 'unknown_tweet' };
    default:
      return { status: 'unknown_tweet' };
  }
};

/** A BSV-21 ticker for the clip: its display ticker, else from the title (A–Z, 0–9, max 12), else BMOVIE. */
export const claimTicker = (c: Pick<Clip, 'ticker' | 'title'>): string => {
  const clean = (s: string) =>
    s
      .toUpperCase()
      .replace(/^\$/, '')
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, TICKER_MAX);
  return clean(c.ticker) || clean(c.title) || 'BMOVIE';
};

/** Mark clips whose tweet has a claim as registered (BUY / SELL), with the claimed ticker. */
export const applyClaims = (clips: Clip[], claims: ClaimInfo[], tweetOf: (c: Clip) => string | null): Clip[] => {
  if (!claims.length) return clips;
  const by = new Map(claims.map((k) => [k.tweetId, k]));
  return clips.map((c) => {
    const tid = tweetOf(c);
    const k = tid ? by.get(tid) : undefined;
    return k && !c.registered ? { ...c, registered: true, ticker: k.ticker || c.ticker } : c;
  });
};

/** bit-sign claim calls, kept here so the paths live only in the bMovies chunk. */
class ClaimClient extends BchatClient {
  claims(tweets: string[]): Promise<unknown> {
    return this.call('GET', `/api/bitsign/bmovies/claims?tweets=${tweets.join(',')}`, undefined, false);
  }
  eligibility(tweetId: string): Promise<unknown> {
    return this.call('GET', `/api/bitsign/bmovies/claim?tweet=${tweetId}`);
  }
  claim(body: { tweet_id: string; token_id: string; clip_id: string }): Promise<unknown> {
    return this.call('POST', '/api/bitsign/bmovies/claim', body);
  }
  xConnect(): Promise<unknown> {
    return this.call('POST', '/api/bitsign/identity/connect/twitter/start', { redirect: 'bmovies' });
  }
}

const signedIn = async (ctx: OneSatContext): Promise<ClaimClient> => {
  await chatClient(ctx); // signs in (and saves the session) if needed
  return new ClaimClient(defaultHttp(isNative), loadSession());
};

/** Public claim status for these tweets ([] when unreachable or not deployed yet). */
export async function fetchClaims(tweetIds: string[]): Promise<ClaimInfo[]> {
  const ids = [...new Set(tweetIds)].slice(0, 50);
  if (!ids.length) return [];
  return new ClaimClient(defaultHttp(isNative), loadSession())
    .claims(ids)
    .then((r) => {
      const list = r && typeof r === 'object' ? (r as { claims?: unknown }).claims : null;
      return Array.isArray(list) ? list.map(parseClaim).filter((k): k is ClaimInfo => !!k) : [];
    })
    .catch(() => []);
}

export async function checkClaim(ctx: OneSatContext, tweetId: string): Promise<Eligibility> {
  return parseEligibility(await (await signedIn(ctx)).eligibility(tweetId));
}

/** The X sign-in URL bound to this wallet's account (opened in the in-app browser). */
export async function xConnectUrl(ctx: OneSatContext): Promise<string> {
  const r = (await (await signedIn(ctx)).xConnect()) as { authorizeUrl?: unknown };
  const url = str(r?.authorizeUrl);
  if (!/^https:\/\/(?:x|twitter)\.com\//.test(url)) throw new Error('X sign-in is not available right now');
  return url;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run only after Allow on the one approval sheet: deploy the clip's token from this wallet, then
 * register it. The deploy may not be visible to the server for a few seconds, so a 404 is retried.
 */
export async function registerClip(
  ctx: OneSatContext,
  c: Clip,
  tweetId: string,
  opts: { retries?: number; waitMs?: number } = {},
): Promise<ClaimInfo> {
  const ticker = claimTicker(c);
  const tokenId = await deployBsv21(ctx, { symbol: ticker, amount: CLAIM_SUPPLY, decimals: 0, icon: null, feeSats: 0 });
  const client = await signedIn(ctx);
  const body = { tweet_id: tweetId, token_id: tokenId, clip_id: c.id };
  const retries = opts.retries ?? 5;
  for (let i = 0; ; i++) {
    try {
      const r = (await client.claim(body)) as { claim?: unknown };
      return parseClaim(r?.claim) ?? { tweetId, tokenId, ticker, claimant: '' };
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 404 || i >= retries) throw e;
      await sleep(opts.waitMs ?? 4_000);
    }
  }
}
