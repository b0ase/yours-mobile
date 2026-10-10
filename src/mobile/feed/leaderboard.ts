import type { PostLock } from './locks';
import type { Author, FeedPost } from './post';
import { currentFx, formatFiat } from '../../utils/displayCurrency';

/**
 * "Most locked" leaderboard (Twetch-leaderboard style): pure ranking / aggregation / caching.
 *
 * Accuracy: no live indexer serves lock totals over a time range (hodlocker.com and LooLock are
 * gone). We can only total locks for posts we have loaded: bmap's recent feed (a few pages,
 * capped), each post's lock-likes, each lock tx decoded from WhatsOnChain. So the timeframe filters
 * by when the POST was made, over that loaded window, and every lock ever made on it counts
 * (expired or not). The UI says so. Network lives in feedApi.ts.
 */

export type Timeframe = '1d' | '7d' | '1m' | 'all';
export const TIMEFRAMES: { id: Timeframe; label: string; ms: number }[] = [
  { id: '1d', label: '1D', ms: 86_400_000 },
  { id: '7d', label: '7D', ms: 7 * 86_400_000 },
  { id: '1m', label: '1M', ms: 30 * 86_400_000 },
  { id: 'all', label: 'ALL', ms: Infinity },
];

/** Earliest post time (ms) in the timeframe; 0 for ALL. */
export const cutoff = (tf: Timeframe, now = Date.now()) => {
  const ms = TIMEFRAMES.find((t) => t.id === tf)?.ms ?? Infinity;
  return Number.isFinite(ms) ? now - ms : 0;
};

/** Total satoshis locked against a post (each lock tx once, expired included). */
export function lockedSats(locks: PostLock[] | undefined): { sats: number; lockers: number } {
  const seen = new Set<string>();
  const lockers = new Set<string>();
  let sats = 0;
  for (const l of locks ?? []) {
    if (seen.has(l.lockTxid) || !(l.satoshis > 0)) continue;
    seen.add(l.lockTxid);
    lockers.add(l.address);
    sats += l.satoshis;
  }
  return { sats, lockers: lockers.size };
}

export type PostRow = { rank: number; post: FeedPost; sats: number; lockers: number };
export type PersonRow = {
  rank: number;
  key: string;
  author: Author;
  source: FeedPost['source'];
  sats: number;
  posts: number;
};

/** Same author across posts: BAP id first, then address, then source + name (Treechat / Twetch handles). */
export const authorKey = (p: Pick<FeedPost, 'author' | 'source'>) =>
  p.author.bapId
    ? `bap:${p.author.bapId}`
    : p.author.address
      ? `addr:${p.author.address}`
      : `name:${p.source}:${p.author.name}`;

const inWindow = (p: FeedPost, since: number) => p.at >= since;

/** Most-locked posts made since `since`; posts with no locks are left out. Ties: newer first. */
export function rankPosts(
  posts: FeedPost[],
  locksBy: Record<string, PostLock[] | undefined>,
  since: number,
  limit = 50,
): PostRow[] {
  const seen = new Set<string>();
  return posts
    .filter((p) => inWindow(p, since) && !seen.has(p.txid) && !!seen.add(p.txid))
    .map((post) => ({ post, ...lockedSats(locksBy[post.txid]) }))
    .filter((r) => r.sats > 0)
    .sort((a, b) => b.sats - a.sats || b.post.at - a.post.at)
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

/** Authors by total BSV locked behind their posts made since `since`. Ties: more posts, then name. */
export function rankPeople(
  posts: FeedPost[],
  locksBy: Record<string, PostLock[] | undefined>,
  since: number,
  limit = 50,
): PersonRow[] {
  const by = new Map<string, Omit<PersonRow, 'rank'>>();
  for (const r of rankPosts(posts, locksBy, since, Infinity)) {
    const key = authorKey(r.post);
    const cur = by.get(key);
    if (cur) {
      cur.sats += r.sats;
      cur.posts += 1;
      if (!cur.author.avatar && r.post.author.avatar) cur.author = r.post.author;
    } else by.set(key, { key, author: r.post.author, source: r.post.source, sats: r.sats, posts: 1 });
  }
  return [...by.values()]
    .sort((a, b) => b.sats - a.sats || b.posts - a.posts || a.author.name.localeCompare(b.author.name))
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

/** Is this author the current user (by BAP id or one of the user's addresses)? */
export const isMe = (a: Pick<Author, 'bapId' | 'address'>, me: { bapId: string | null; addresses?: string[] }) =>
  (!!me.bapId && a.bapId === me.bapId) || (!!a.address && !!me.addresses?.includes(a.address));

export const formatUsd = (sats: number, rate: number) => {
  if (!(rate > 0)) return '';
  const usd = (sats / 1e8) * rate;
  return `≈ ${formatFiat(usd, currentFx(), { wholeAbove100: true })}`;
};

// ── cache (in-memory + short localStorage TTL) ───────────────────────────────

export type LeaderboardData = {
  posts: FeedPost[];
  locks: Record<string, PostLock[]>;
  /** Oldest post time actually loaded (ms): the real lower bound of the window. */
  oldest: number;
  /** True when the loaded window reaches back past the timeframe's start. */
  complete: boolean;
  at: number;
};

export const LEADERBOARD_TTL = 10 * 60_000;
const LS_KEY = (tf: Timeframe) => `bwallet.feed.leaderboard.${tf}`;
const mem = new Map<Timeframe, LeaderboardData>();

export const fresh = (d: LeaderboardData | null | undefined, now = Date.now()): d is LeaderboardData =>
  !!d && now - d.at < LEADERBOARD_TTL;

export function readCache(tf: Timeframe, now = Date.now()): LeaderboardData | null {
  const m = mem.get(tf);
  if (fresh(m, now)) return m;
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY(tf)) ?? 'null') as LeaderboardData | null;
    if (fresh(d, now) && Array.isArray(d.posts) && d.locks && typeof d.locks === 'object') {
      mem.set(tf, d);
      return d;
    }
  } catch {
    // storage unavailable or corrupt
  }
  return null;
}

export function writeCache(tf: Timeframe, d: LeaderboardData) {
  mem.set(tf, d);
  try {
    // Only posts that carry locks are worth persisting.
    const posts = d.posts.filter((p) => d.locks[p.txid]?.length);
    localStorage.setItem(LS_KEY(tf), JSON.stringify({ ...d, posts }));
  } catch {
    // quota / unavailable: memory cache still works
  }
}

export const clearLeaderboardCache = () => mem.clear();
