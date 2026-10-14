/**
 * Feed › bMovies: client-side NSFW screen. Items whose title / blurb / ticker / handle match a risk
 * term are dropped before they reach the reel, plus a manual blocklist of handles and tweet ids.
 *
 * bChatX (bit-sign) keeps an equivalent server-side list; the two are to be shared later — keep
 * them in step when adding terms here.
 */

/** Risk terms, matched case-insensitively as substrings (EN + JA/ZH/KO). */
export const RISK_TERMS: readonly string[] = [
  'nsfw',
  'nude',
  'nudity',
  'naked',
  'no nudity',
  'sfw illustration',
  'sexy',
  'lewd',
  'hentai',
  'ecchi',
  'r18',
  'r-18',
  'onlyfans',
  'bikini',
  'lingerie',
  'はだか',
  '裸',
  'ヌード',
  'えっち',
  'エロ',
  'セクシー',
  '下着',
  '水着',
  '色情',
  '裸体',
  '性感',
  '야한',
  '노출',
];

/** Creator handles never shown (lowercase, no @). */
export const BLOCKED_HANDLES: readonly string[] = [];

/** Tweet ids never shown. */
export const BLOCKED_TWEET_IDS: readonly string[] = [];

export type Screenable = { title: string; blurb: string; ticker: string; handle: string; tweetId: string | null };

/** True when the item must not be shown. */
export const isBlocked = (c: Screenable): boolean => {
  const handle = c.handle.toLowerCase();
  if (handle && BLOCKED_HANDLES.some((h) => h.toLowerCase() === handle)) return true;
  if (c.tweetId && BLOCKED_TWEET_IDS.includes(c.tweetId)) return true;
  const text = [c.title, c.blurb, c.ticker, c.handle].join('\n').toLowerCase();
  return RISK_TERMS.some((t) => text.includes(t));
};
