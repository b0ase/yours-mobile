/**
 * Feed › bMovies: client-side NSFW screen. bMovies relays other creators' X clips, so anything that
 * looks adult is DROPPED (never blurred). Deliberately conservative; a false positive costs one clip.
 *
 * Two layers:
 *  1. RISK TERMS matched against title / blurb / ticker (English as whole words, "18+" as a token,
 *     JA/ZH/KO as substrings), after NFKC folds full-width "ＮＳＦＷ" and half-width kana.
 *  2. A static BLOCKLIST of creator handles and tweet ids.
 *
 * bChatX keeps the server-side twin in bit-sign `src/lib/feed/bmovies-screen.ts`; keep the term
 * lists and blocklists here in step with it.
 */

/** Creator X handles never shown (lowercase, no @). */
export const BLOCKED_HANDLES: ReadonlySet<string> = new Set<string>([]);

/** Tweet ids never shown. */
export const BLOCKED_TWEET_IDS: ReadonlySet<string> = new Set<string>([]);

/** English (Latin-script) terms, matched as whole words (so "Essex" never hits "sex"). */
export const WORD_TERMS: readonly string[] = [
  'nsfw', 'sfw', 'nude', 'nudes', 'nudity', 'naked', 'topless', 'nsfl',
  'sex', 'sexy', 'sexual', 'sexualized', 'sexualised', 'suggestive', 'erotic', 'erotica', 'porn', 'porno',
  'lewd', 'hentai', 'ecchi', 'ahegao', 'oppai', 'boobs', 'busty', 'thicc',
  'r18', 'r-18', 'r18g', 'xxx', 'onlyfans', 'fansly', 'fanvue',
  'bikini', 'bikinis', 'lingerie', 'underwear', 'panties', 'swimsuit', 'fetish', 'bdsm',
]; // prettier-ignore
const WORD_RE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${WORD_TERMS.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'u');

/** "18+" / "+18" / "18禁" standing alone (not "2018+" or "118+"). */
const AGE_RE = /(?:^|[^\d])(?:18\s*\+|\+\s*18(?!\d)|18禁)/u;

/** Japanese / Chinese / Korean terms, matched as substrings (no word spaces in CJK). */
export const CJK_TERMS: readonly string[] = [
  // Japanese
  'はだか', 'ハダカ', '裸', 'ヌード', 'えっち', 'エッチ', 'エロ', 'えろ', 'セクシー', '下着', '水着', 'ランジェリー',
  'おっぱい', 'パンチラ', '成人向け', '全年齢', 'センシティブ',
  // Chinese
  '色情', '裸体', '性感', '情色', '成人', '涩图', '瑟图', '内衣', '泳装', '比基尼',
  // Korean
  '야한', '노출', '섹시', '누드', '야동', '성인', '비키니', '속옷', '수영복',
]; // prettier-ignore

/** NFKC folds full-width "ＮＳＦＷ" and half-width kana to the forms above. */
const norm = (s: string) => s.normalize('NFKC').toLowerCase();
const CJK_NORM = CJK_TERMS.map(norm);

/** True when the text carries a risk term. */
export const hasRiskTerm = (text: string): boolean => {
  const t = norm(text);
  if (!t) return false;
  return WORD_RE.test(t) || AGE_RE.test(t) || CJK_NORM.some((w) => t.includes(w));
};

export type Screenable = { title: string; blurb: string; ticker: string; handle: string; tweetId: string | null };

/** True when the item must not be shown. */
export const isBlocked = (c: Screenable): boolean => {
  const handle = c.handle.replace(/^@/, '').toLowerCase();
  if (handle && BLOCKED_HANDLES.has(handle)) return true;
  if (c.tweetId && BLOCKED_TWEET_IDS.has(c.tweetId)) return true;
  return hasRiskTerm([c.title, c.blurb, c.ticker].join('\n'));
};
