import { applyBapAip, BSOCIAL_BASKET, executeTrackedAction, type OneSatContext } from '@1sat/actions';
import { Transaction, Utils, type Script } from '@bsv/sdk';
import { parseBmapFeed, parseLikes, type FeedPost } from './post';

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

export const fetchReplies = async (txid: string) => parseBmapFeed(await get(`/social/post/${txid}/reply?limit=50`));

export const fetchLikes = async (txid: string, mine: string[] = []) => parseLikes(await get(`/social/post/${txid}/like`), mine);

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
export async function publish(ctx: OneSatContext, script: Script, description: string, tags: string[]): Promise<string> {
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
    outputs: [{ lockingScript: signed.toHex(), satoshis: 0, outputDescription: description, basket: BSOCIAL_BASKET, tags }],
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
