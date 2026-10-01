import { applyBapAip, BSOCIAL_BASKET, executeTrackedAction, LOCK_BASKET, type OneSatContext } from '@1sat/actions';
import { P1SAT_PROTOCOL } from '@1sat/types';
import { decodeLockTx, lockCandidates, lockOutputs, type PostLock } from './locks';
import { FEED_APP } from './sources';
import { cutoff, readCache, writeCache, type LeaderboardData, type Timeframe } from './leaderboard';
import { PublicKey, Transaction, Utils, type Script } from '@bsv/sdk';
import {
  groupThread,
  mergePosts,
  parseBmapFeed,
  parseBmapPost,
  parseLikes,
  parseTwetchFeed,
  threadRoot,
  TWETCH_API,
  type FeedPost,
} from './post';

/**
 * Feed read source: the bmap API (BitcoinSchema/bmap-api, the indexer behind 1satsocial /
 * bSocial). b.map.sv no longer resolves; the maintained deployment is on Railway. To move it,
 * add a vite define for __FEED_API__ (read defensively below, so none is required).
 */
declare const __FEED_API__: string | undefined;
export const FEED_API =
  (typeof __FEED_API__ === 'string' && __FEED_API__.trim()) || 'https://bmap-api-production.up.railway.app';

const get = async (path: string): Promise<unknown> => {
  const res = await fetch(`${FEED_API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Feed server error (${res.status})`);
  return res.json();
};

/** "For you": the most recent posts network-wide. */
export const fetchRecent = async (page = 1, limit = 30): Promise<FeedPost[]> =>
  parseBmapFeed(await get(`/social/feed?page=${page}&limit=${limit}`));

export const fetchByBap = async (bapId: string, page = 1, limit = 30) =>
  parseBmapFeed(await get(`/social/post/bap/${encodeURIComponent(bapId)}?page=${page}&limit=${limit}`));

export const fetchByAddress = async (address: string, page = 1, limit = 30) =>
  parseBmapFeed(await get(`/social/post/address/${encodeURIComponent(address)}?page=${page}&limit=${limit}`));

export const fetchReplies = async (txid: string) => parseBmapFeed(await get(`/social/post/${txid}/reply?limit=100`));

export const fetchLikes = async (txid: string, mine: string[] = []) =>
  parseLikes(await get(`/social/post/${txid}/like`), mine);

/**
 * Recent public Twetch posts from Twetch's own read API (bmap stopped indexing Twetch around
 * block 843k). One plain GET per refresh, no auth, no spoofed headers: Twetch's terms allow
 * legitimate automation that does not burden the service.
 */
export const fetchTwetch = async (limit = 60): Promise<FeedPost[]> => {
  const res = await fetch(`${TWETCH_API}/v1/feed/latest?limit=${limit}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Twetch error (${res.status})`);
  return parseTwetchFeed(await res.json(), (pk) => PublicKey.fromString(pk).toAddress());
};

/** For you: network-wide recent posts plus a slice of Twetch. Twetch failing never blanks the feed. */
export async function fetchForYou(): Promise<FeedPost[]> {
  const [recent, twetch] = await Promise.allSettled([fetchRecent(), fetchTwetch()]);
  if (recent.status === 'rejected') throw recent.reason;
  return mergePosts(recent.value, twetch.status === 'fulfilled' ? twetch.value : []);
}

/**
 * A whole thread. Treechat: the root post + its replies (Treechat points every reply's MAP tx
 * at the root), plus a text search for the thread id (bmap has no index on
 * MAP.treechat_thread_id, so a direct query times out) filtered to exact matches.
 * Others: the post's direct replies. Each source is optional; whatever loads is shown.
 */
export async function fetchThread(post: FeedPost): Promise<FeedPost[]> {
  const root = threadRoot(post);
  const jobs: Promise<FeedPost[]>[] = [fetchReplies(root)];
  if (root !== post.txid)
    jobs.push(
      get(`/social/post/${root}`).then((b) => {
        const p = parseBmapPost((b as { post?: unknown })?.post);
        return p ? [p] : [];
      }),
    );
  if (post.threadId)
    jobs.push(get(`/social/post/search?q=${encodeURIComponent(post.threadId)}&limit=100`).then(parseBmapFeed));
  const got = await Promise.allSettled(jobs);
  return groupThread(
    post,
    got.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])),
  );
}

/** Posts by a set of authors (bapId when known, else address), merged newest-first. */
export async function fetchFollowing(follows: { bapId: string | null; address: string }[]): Promise<FeedPost[]> {
  const lists = await Promise.allSettled(
    follows.slice(0, 40).map((f) => (f.bapId ? fetchByBap(f.bapId, 1, 20) : fetchByAddress(f.address, 1, 20))),
  );
  const seen = new Set<string>();
  return lists
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((p) => !seen.has(p.txid) && !!seen.add(p.txid))
    .sort((a, b) => b.at - a.at);
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * Sign `script` with the account's BAP identity key (AIP), then create + broadcast a 0-sat
 * OP_RETURN output through the wallet (normal approval rules apply). Hands the raw tx to the
 * indexer so the post shows up without waiting for a block.
 */
export async function publish(
  ctx: OneSatContext,
  script: Script,
  description: string,
  tags: string[],
): Promise<string> {
  let signed: Script;
  try {
    signed = await applyBapAip(ctx, script);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/No BAP identity/i.test(m)) throw new Error('Publish your identity first (Settings → Identity), then post.');
    throw e;
  }
  const res = await executeTrackedAction(ctx.wallet, {
    description,
    outputs: [
      { lockingScript: signed.toHex(), satoshis: 0, outputDescription: description, basket: BSOCIAL_BASKET, tags },
    ],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  });
  if (!res.txid) throw new Error('The wallet did not return a transaction id.');
  if (res.tx) void ingest(res.tx);
  return res.txid;
}

async function ingest(tx: number[]) {
  try {
    let rawTx: string;
    try {
      rawTx = Transaction.fromAtomicBEEF(tx).toHex();
    } catch {
      rawTx = Utils.toHex(tx);
    }
    await fetch(`${FEED_API}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rawTx }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // best effort: the indexer also picks it up from the chain
  }
}

// ── social locks ─────────────────────────────────────────────────────────────

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
/** Lock txs are immutable: cache decoded results (null = not a lock) for the session. */
const lockTxCache = new Map<string, Promise<PostLock | null>>();

const fetchLockTx = (lockTxid: string, postTxid: string) => {
  let p = lockTxCache.get(lockTxid);
  if (!p) {
    p = fetch(`${WOC}/tx/${lockTxid}/hex`, { signal: AbortSignal.timeout(15_000) })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`tx ${r.status}`))))
      .then((hex) => decodeLockTx(hex.trim(), postTxid));
    p.catch(() => lockTxCache.delete(lockTxid));
    lockTxCache.set(lockTxid, p);
  }
  return p;
};

/**
 * Locks backing a post. No live indexer serves Hodlocker-style lock totals any more (hodlocker.com
 * and its LooLock API are gone), so: bmap's like index for the post (lock-likes are MAP likes),
 * keep those with a non-address output, and decode each tx's lock output (WhatsOnChain raw tx).
 */
export async function fetchPostLocks(postTxid: string): Promise<PostLock[]> {
  const ids = lockCandidates(await get(`/social/post/${postTxid}/like?limit=100`));
  const got = await Promise.allSettled(ids.slice(0, 40).map((id) => fetchLockTx(id, postTxid)));
  return got.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}

/**
 * Lock `satoshis` until block `until` against `postTxid`: the same lock output, basket, tags and
 * key as @1sat/actions lockBsv (so the Wallet's Locks row lists it and unlockBsv spends it), plus a
 * MAP like for the post, AIP-signed when the account has a BAP identity.
 */
export async function lockToPost(
  ctx: OneSatContext,
  o: { postTxid: string; satoshis: number; until: number },
): Promise<PostLock> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID: 'lock',
    counterparty: 'self',
    forSelf: true,
  });
  const address = PublicKey.fromString(publicKey).toAddress();
  const { lock, map, until } = lockOutputs({ ...o, address, app: FEED_APP });
  let mapScript = map;
  try {
    mapScript = await applyBapAip(ctx, map);
  } catch {
    // no BAP identity: an unsigned MAP like still counts for lock indexers
  }
  const res = await executeTrackedAction(
    ctx.wallet,
    {
      description: 'Lock BSV to a post',
      outputs: [
        {
          lockingScript: lock.toHex(),
          satoshis: o.satoshis,
          outputDescription: `Lock ${o.satoshis} sats until block ${until}`,
          basket: LOCK_BASKET,
          tags: [`until:${until}`],
          customInstructions: JSON.stringify({ protocolID: P1SAT_PROTOCOL, keyID: 'lock' }),
        },
        {
          lockingScript: mapScript.toHex(),
          satoshis: 0,
          outputDescription: 'Feed lock',
          basket: BSOCIAL_BASKET,
          tags: [`app:${FEED_APP}`, 'type:lock', `tx:${o.postTxid}`],
        },
      ],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
    },
    undefined,
    undefined,
    undefined,
    { spends: [], permissionScheme: 'lock' },
  );
  if (!res.txid) throw new Error('The wallet did not return a transaction id.');
  if (res.tx) void ingest(res.tx);
  return { lockTxid: res.txid, postTxid: o.postTxid, satoshis: o.satoshis, until, address };
}

// ── most-locked leaderboard ──────────────────────────────────────────────────

/** Request caps: at most this many feed pages and this many posts' lock lookups per refresh. */
export const LEADERBOARD_PAGES = 4;
export const LEADERBOARD_PAGE_SIZE = 50;
export const LEADERBOARD_MAX_POSTS = 120;

/**
 * Posts + their locks for a leaderboard timeframe. bmap's recent feed is paged back until a page
 * reaches past the timeframe's start (or the page cap), then each in-window post's locks are read
 * (3 at a time; lock txs are cached). Results cached in memory + localStorage for 10 minutes.
 */
export async function fetchLeaderboard(tf: Timeframe, force = false): Promise<LeaderboardData> {
  if (!force) {
    const hit = readCache(tf);
    if (hit) return hit;
  }
  const since = cutoff(tf);
  const posts: FeedPost[] = [];
  let complete = false;
  for (let page = 1; page <= LEADERBOARD_PAGES; page++) {
    const got = await fetchRecent(page, LEADERBOARD_PAGE_SIZE);
    posts.push(...got);
    if (got.length < LEADERBOARD_PAGE_SIZE) complete = true;
    if (since > 0 && got.some((p) => p.at && p.at < since)) complete = true;
    if (complete) break;
  }
  const oldest = posts.reduce((m, p) => (p.at && p.at < m ? p.at : m), Date.now());
  const todo = [...new Set(posts.filter((p) => p.at >= since).map((p) => p.txid))].slice(0, LEADERBOARD_MAX_POSTS);
  const locks: Record<string, PostLock[]> = {};
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const txid = todo[i++];
      try {
        const ls = await fetchPostLocks(txid);
        if (ls.length) locks[txid] = ls;
      } catch {
        // one post failing never blanks the board
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const data: LeaderboardData = { posts, locks, oldest, complete, at: Date.now() };
  writeCache(tf, data);
  return data;
}
