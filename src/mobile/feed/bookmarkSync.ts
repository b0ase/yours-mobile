/**
 * Feed bookmarks synced across devices through bit-sign (/api/bitsign/me/bookmarks), keyed by the
 * signed-in bChat $handle. Not signed in to bChat: bookmarks stay on this phone (store.ts).
 *
 * The phone keeps a copy (store.ts) so bookmarks show offline. Each tap is applied locally at once and
 * queued; the queue is sent on the next sync, so taps made offline aren't lost. Once the queue is
 * empty the server list is the truth and replaces the local copy, which is how a removal on one
 * phone reaches the others. The first sync for a handle uploads bookmarks saved before sync existed.
 */
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { isNative } from '../native';
import type { FeedPost } from './post';
import { isBookmarked, loadBookmarks, saveBookmarks, toggleBookmark } from './store';

export type BookmarkOp = { op: 'add'; post: FeedPost } | { op: 'del'; txid: string };

const OPS_KEY = 'bwallet.feed.bookmarkOps';
const SEEDED_KEY = 'bwallet.feed.bookmarksSynced';

const read = <T>(k: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(k) ?? 'null') as T | null) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // storage unavailable
  }
};

/** Later ops on the same post replace earlier ones, so the queue never holds add-then-remove pairs. */
export const queueOp = (ops: BookmarkOp[], op: BookmarkOp): BookmarkOp[] => {
  const id = op.op === 'add' ? op.post.txid : op.txid;
  return [...ops.filter((o) => (o.op === 'add' ? o.post.txid : o.txid) !== id), op];
};

/** Bookmarks saved on this phone that the server doesn't have yet (first sync for a handle). */
export const unsynced = (local: FeedPost[], server: FeedPost[]): FeedPost[] => {
  const have = new Set(server.map((p) => p.txid));
  return local.filter((p) => !have.has(p.txid));
};

/** Apply taps still waiting to be sent on top of a list (so a tap made mid-sync isn't undone). */
export const applyOps = (list: FeedPost[], ops: BookmarkOp[]): FeedPost[] =>
  ops.reduce(
    (acc, o) =>
      o.op === 'add'
        ? [o.post, ...acc.filter((p) => p.txid !== o.post.txid)]
        : acc.filter((p) => p.txid !== o.txid),
    list,
  );

const recordBookmarkOp = (op: BookmarkOp) => write(OPS_KEY, queueOp(read<BookmarkOp[]>(OPS_KEY, []), op));

export const bookmarkClient = () => new BchatClient(defaultHttp(isNative), loadSession());

/** Save or remove a bookmark: on this phone at once, and on the other devices at the next sync. */
export const toggleSyncedBookmark = (bookmarks: FeedPost[], p: FeedPost): FeedPost[] => {
  recordBookmarkOp(isBookmarked(bookmarks, p.txid) ? { op: 'del', txid: p.txid } : { op: 'add', post: p });
  return toggleBookmark(bookmarks, p);
};

/**
 * Send queued taps, then pull the server list into the local copy. Returns the bookmarks to show:
 * the server's list, or the local copy when not signed in or offline.
 */
export async function syncBookmarks(client: BchatClient): Promise<FeedPost[]> {
  const handle = loadSession()?.handle ?? client.handle;
  if (!handle) return loadBookmarks();
  try {
    let ops = read<BookmarkOp[]>(OPS_KEY, []);
    while (ops.length) {
      const o = ops[0];
      if (o.op === 'add') await client.addBookmark(o.post);
      else await client.removeBookmark(o.txid);
      ops = ops.slice(1);
      write(OPS_KEY, ops);
    }
    let server = await client.bookmarks<FeedPost>();
    const seeded = read<string[]>(SEEDED_KEY, []);
    if (!seeded.includes(handle)) {
      const missing = unsynced(loadBookmarks(), server);
      for (const p of [...missing].reverse()) await client.addBookmark(p);
      write(SEEDED_KEY, [...seeded, handle]);
      if (missing.length) server = await client.bookmarks<FeedPost>();
    }
    return saveBookmarks(applyOps(server, read<BookmarkOp[]>(OPS_KEY, [])));
  } catch {
    // Offline or the server refused: keep the local copy; the queue is retried next time.
    return loadBookmarks();
  }
}
