/**
 * Feed › bMovies: the bmovies.app clip feed as a vertical reel (bWalletX only, BMOVIES_FEED_ENABLED).
 *
 * Source: GET https://www.bmovies.app/api/feed?cursor=<nextCursor> (public, no auth). It ignores
 * `limit`, returns ~20–34 items and is not date-sorted, so each page is sorted here (newest first).
 * Clips play through bMovies' own /api/tweet-video proxy (direct video.twimg.com URLs 403); the proxy
 * is slow, so the reel mounts one player (plus the next, preloading) at a time.
 *
 * Posters must show at once: the item's `art`; else X's public embed JSON for the tweet in the item
 * id (`tweet-<id>` / `convert-<id>-…`); else the reel shows the clip's first frame. bmovies.app and
 * the syndication host send no CORS header for us, so phones read both through native HTTP; web and
 * desktop try fetch and show a link out when the browser blocks it.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { isBlocked } from './screen';

export const BMOVIES_ORIGIN = 'https://www.bmovies.app';
const FEED_URL = `${BMOVIES_ORIGIN}/api/feed`;
const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result';
const TITLE_MAX = 140;
const BLURB_MAX = 200;

export type Clip = {
  /** bMovies item id (also the tweet id carrier). */
  id: string;
  /** The id its share page focuses (`offerId`, else `id`). */
  offerId: string;
  title: string;
  blurb: string;
  ticker: string;
  /** The creator's X handle (validated, no @), or '' when unknown. Shown as the author. */
  handle: string;
  /** The original post on X (https x.com / twitter.com), or null. */
  tweetUrl: string | null;
  /** Playable clip URL: bMovies' tweet-video proxy or a direct https .mp4. */
  src: string;
  /** https poster, or null until one is found. */
  poster: string | null;
  at: number;
};

export type ClipPage = { clips: Clip[]; next: string | null };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** https only; a bMovies-relative path (its proxy) resolves against its origin. */
export const absUrl = (v: unknown): string | null => {
  const s = str(v);
  if (/^https:\/\//i.test(s)) return s;
  if (s.startsWith('/') && !s.startsWith('//')) return `${BMOVIES_ORIGIN}${s}`;
  return null;
};

/** A URL that will play in a <video>: the tweet-video proxy wrapping video.twimg.com, or a direct .mp4. */
export const playableUrl = (v: unknown): string | null => {
  const url = absUrl(v);
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.origin === BMOVIES_ORIGIN && u.pathname === '/api/tweet-video') {
      const inner = new URL(u.searchParams.get('u') ?? '');
      return inner.protocol === 'https:' && inner.hostname === 'video.twimg.com' ? url : null;
    }
    return u.protocol === 'https:' && /\.mp4$/i.test(u.pathname) ? url : null;
  } catch {
    return null;
  }
};

/** An X handle: 1–15 of [A-Za-z0-9_] (a leading @ is dropped), else ''. */
export const xHandle = (v: unknown): string => {
  const s = str(v).replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : '';
};

/** The original post's URL when it is https on x.com / twitter.com, else null. */
export const xPostUrl = (v: unknown): string | null => {
  const s = str(v);
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
};

/**
 * The handle to credit as the clip's creator: only when its original post is an x.com / twitter.com
 * status by that same handle (/<handle>/status/<id>, case-insensitive), as bChatX decides it
 * (bit-sign `src/lib/feed/bmovies.ts` creditFor). Otherwise '' and the card says "via bMovies" only.
 */
export const creditedHandle = (c: Pick<Clip, 'handle' | 'tweetUrl'>): string => {
  if (!c.handle || !c.tweetUrl) return '';
  const m =
    /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})(?:[/?#]|$)/i.exec(
      c.tweetUrl,
    );
  return m && m[1].toLowerCase() === c.handle.toLowerCase() ? c.handle : '';
};

/** The creator's avatar (unavatar.io for the X handle; 404 rather than a stock fallback). */
export const avatarUrl = (handle: string) => `https://unavatar.io/x/${encodeURIComponent(handle)}?fallback=false`;

/** One feed item → a clip, or null (no id, no playable video or no time). */
export const toClip = (raw: unknown): Clip | null => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r) return null;
  const id = str(r.id);
  const src = playableUrl(r.trailerUrl);
  const at = Date.parse(str(r.createdAt));
  if (!id || !src || !Number.isFinite(at)) return null;
  return {
    id,
    offerId: str(r.offerId) || id,
    title: clip(str(r.title) || 'A clip on bMovies', TITLE_MAX),
    blurb: clip(str(r.blurb), BLURB_MAX),
    ticker: str(r.ticker)
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 20),
    handle: xHandle(r.handle),
    tweetUrl: xPostUrl(r.tweetUrl),
    src,
    poster: absUrl(r.art),
    at,
  };
};

/** The API's `{ items, nextCursor }` → unique, screened clips (see screen.ts), newest first. */
export const parseFeed = (json: unknown): ClipPage => {
  const j = json && typeof json === 'object' ? (json as { items?: unknown; nextCursor?: unknown }) : {};
  const seen = new Set<string>();
  const clips: Clip[] = [];
  for (const it of Array.isArray(j.items) ? j.items : []) {
    const c = toClip(it);
    if (c && !seen.has(c.id) && !isBlocked({ ...c, tweetId: clipTweetId(c) })) {
      seen.add(c.id);
      clips.push(c);
    }
  }
  clips.sort((a, b) => b.at - a.at);
  return { clips, next: str(j.nextCursor) || null };
};

/** Append a page, skipping clips already listed (the API can repeat across pages). */
export const appendPage = (have: Clip[], page: Clip[]): Clip[] => {
  const ids = new Set(have.map((c) => c.id));
  return [...have, ...page.filter((c) => !ids.has(c.id))];
};

/** The clip's page on bmovies.app (its own Share link). */
export const clipPageUrl = (c: Pick<Clip, 'offerId'>) =>
  `${BMOVIES_ORIGIN}/feed?focus=${encodeURIComponent(c.offerId)}`;

/** The tweet id in a bMovies item id (`tweet-<id>` / `convert-<id>-…`), or null. */
export const tweetIdOf = (itemId: string): string | null =>
  /^(?:tweet|convert)-(\d{10,20})(?:-|$)/.exec(itemId)?.[1] ?? null;

/** The clip's tweet id: from its original post URL, else its bMovies item id. */
export const clipTweetId = (c: Pick<Clip, 'id' | 'tweetUrl'>): string | null =>
  (c.tweetUrl && /\/status(?:es)?\/(\d{5,25})/.exec(c.tweetUrl)?.[1]) || tweetIdOf(c.id);

/**
 * X's poster for the tweet's video from its public embed JSON: mediaDetails[].media_url_https on
 * pbs.twimg.com, preferring the one whose media id matches the clip's video URL.
 */
export const posterFromSyndication = (json: unknown, videoSrc: string): string | null => {
  const j = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  const quoted =
    j?.quoted_tweet && typeof j.quoted_tweet === 'object' ? (j.quoted_tweet as Record<string, unknown>) : null;
  const urls = [j?.mediaDetails, quoted?.mediaDetails]
    .flatMap((m) => (Array.isArray(m) ? m : []))
    .map((m) => str((m as { media_url_https?: unknown })?.media_url_https))
    .filter((u) => /^https:\/\/pbs\.twimg\.com\//.test(u));
  let mediaId = '';
  try {
    mediaId = /\/(\d{10,20})\//.exec(new URL(videoSrc).searchParams.get('u') ?? videoSrc)?.[1] ?? '';
  } catch {
    // no media id
  }
  return urls.find((u) => mediaId && u.includes(`/${mediaId}/`)) ?? urls[0] ?? null;
};

/** The clip's first frame, as a <video> poster fallback (metadata only). */
export const firstFrameUrl = (src: string) => `${src}#t=0.5`;

// ── fetching ──────────────────────────────────────────────────────────────

export type FetchJson = (url: string) => Promise<unknown>;

const nativeJson: FetchJson = async (url) => {
  const r = await CapacitorHttp.request({ method: 'GET', url, headers: { accept: 'application/json' } });
  if (r.status !== 200) return null;
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
};

const webJson: FetchJson = async (url) => {
  const r = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(12_000) });
  return r.ok ? r.json() : null;
};

export const defaultJson: FetchJson = Capacitor.isNativePlatform() ? nativeJson : webJson;

/** One page of clips (`cursor` = the previous page's next). Throws when the feed can't be read. */
export async function fetchClips(cursor: string | null = null, json: FetchJson = defaultJson): Promise<ClipPage> {
  const url = cursor ? `${FEED_URL}?cursor=${encodeURIComponent(cursor)}&limit=20` : `${FEED_URL}?limit=20`;
  const data = await json(url);
  if (!data) throw new Error('bMovies is not answering');
  return parseFeed(data);
}

const posterCache = new Map<string, Promise<string | null>>();

/** A poster for a clip bMovies gave no art, from X's embed JSON. Cached; any failure is null. */
export function findPoster(c: Clip, json: FetchJson = defaultJson): Promise<string | null> {
  if (c.poster) return Promise.resolve(c.poster);
  const tid = tweetIdOf(c.id);
  if (!tid) return Promise.resolve(null);
  let p = posterCache.get(tid);
  if (!p) {
    p = json(`${SYNDICATION}?id=${tid}&token=x`)
      .then((j) => posterFromSyndication(j, c.src))
      .catch(() => null);
    posterCache.set(tid, p);
  }
  return p;
}
