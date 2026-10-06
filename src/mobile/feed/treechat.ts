import { Transaction, Utils } from '@bsv/sdk';
import { isThreadId, isTxid, MAP_PREFIX, type FeedPost } from './post';

/**
 * Treechat's thread id (MAP `treechat_thread_id`) from a post's raw transaction. The overlay
 * (overlay.peck.to) indexes Treechat posts but does not return this field, and the original-post
 * link (app.treechat.com/p/<thread id>) needs it. Verified 2026-10-06: /p/<thread id> redirects
 * to the thread; /p/<txid> does not resolve.
 *
 * The hex must hash to `txid` — whoever served it, a wrong tx never names a thread. PURE.
 */
export function treechatThreadIdFromRawTx(hex: string, txid: string): string | null {
  if (!isTxid(txid) || !/^[0-9a-f]+$/i.test(hex)) return null;
  try {
    const tx = Transaction.fromHex(hex);
    if (tx.id('hex') !== txid.toLowerCase()) return null;
    for (const out of tx.outputs) {
      const pushes = opReturnPushes(out.lockingScript.toBinary()).map((d) => Utils.toUTF8(d));
      const map = pushes.indexOf(MAP_PREFIX);
      if (map < 0) continue;
      for (let i = map + 1; i + 1 < pushes.length; i++) {
        if (pushes[i] === '|') break; // next protocol (AIP)
        if (pushes[i] === 'treechat_thread_id' && isThreadId(pushes[i + 1])) return pushes[i + 1].toLowerCase();
      }
    }
  } catch {
    /* unparseable */
  }
  return null;
}

/**
 * The data pushes after OP_RETURN, as raw bytes. The SDK keeps everything after OP_RETURN as one
 * chunk, so the pushes (B | MAP | AIP) are split here.
 */
function opReturnPushes(script: number[]): number[][] {
  // OP_RETURN or OP_FALSE OP_RETURN at the start — never a 0x6a byte inside a key hash.
  const at = script[0] === 0x6a ? 0 : script[0] === 0 && script[1] === 0x6a ? 1 : -1;
  if (at < 0) return [];
  const out: number[][] = [];
  let i = at + 1;
  while (i < script.length) {
    const op = script[i++];
    let len: number;
    if (op >= 1 && op <= 75) len = op;
    else if (op === 0x4c) {
      len = script[i];
      i += 1;
    } else if (op === 0x4d) {
      len = script[i] | (script[i + 1] << 8);
      i += 2;
    } else if (op === 0x4e) {
      len = (script[i] | (script[i + 1] << 8) | (script[i + 2] << 16)) + script[i + 3] * 0x1000000;
      i += 4;
    } else {
      out.push([]);
      continue;
    } // OP_0 and other opcodes: an empty slot
    if (i + len > script.length) break;
    out.push(script.slice(i, i + len));
    i += len;
  }
  return out;
}

const TREE_UP = 25;
const TREE_FETCHES = 30;
const TREE_MAX = 300;

export interface TreeReaders {
  /** One post by txid (the overlay, then the older indexers). */
  post: (txid: string) => Promise<FeedPost | null>;
  /** Direct overlay replies to a post. */
  replies: (txid: string) => Promise<FeedPost[]>;
  /** Replies the overlay may not have (bmap's old Treechat threads, bChat replies). */
  extra: (txid: string) => Promise<FeedPost[]>;
}

/**
 * A Treechat conversation as one tree. The overlay has no thread id, but every reply's
 * parent_txid (MAP context=tx) names the post it answers — which may itself be a reply (a
 * Treechat "quest" branches off any message). Walk up to the top root, then breadth-first down
 * through the replies, bounded. Old bmap threads (every reply pointed at the root) come in
 * through `extra` on the root and on the post.
 */
export async function buildTreechatTree(
  post: FeedPost,
  read: TreeReaders,
): Promise<{ root: FeedPost; posts: FeedPost[] }> {
  let root = post;
  const seen = new Set([post.txid]);
  for (let i = 0; i < TREE_UP && root.replyTo && !seen.has(root.replyTo); i++) {
    const up = await read.post(root.replyTo).catch(() => null);
    if (!up) break;
    seen.add(up.txid);
    root = up;
  }
  const all = new Map<string, FeedPost>([
    [root.txid, root],
    [post.txid, post],
  ]);
  let frontier = [root.txid];
  let fetches = 0;
  while (frontier.length && fetches < TREE_FETCHES && all.size < TREE_MAX) {
    const batch = frontier.slice(0, TREE_FETCHES - fetches);
    fetches += batch.length;
    const lists = await Promise.all(batch.map((t) => read.replies(t).catch(() => [] as FeedPost[])));
    frontier = [];
    for (const r of lists.flat()) {
      if (all.has(r.txid) || all.size >= TREE_MAX) continue;
      all.set(r.txid, r);
      if (r.replies > 0) frontier.push(r.txid);
    }
  }
  const extra = await Promise.all(
    [...new Set([root.txid, post.txid])].map((t) => read.extra(t).catch(() => [] as FeedPost[])),
  );
  for (const r of extra.flat()) if (!all.has(r.txid)) all.set(r.txid, r);
  return { root, posts: [...all.values()] };
}

/** The thread page for a Treechat post: the root above it, the rest of the tree below, oldest first. */
export function treechatThreadView(
  post: FeedPost,
  tree: { root: FeedPost; posts: FeedPost[] },
): { post: FeedPost; parent: FeedPost | null; replies: FeedPost[] } {
  const byId = new Map(tree.posts.map((p) => [p.txid, p]));
  const me = byId.get(post.txid) ?? post;
  const root = tree.root.txid !== post.txid ? (byId.get(tree.root.txid) ?? tree.root) : null;
  const replies = tree.posts.filter((p) => p.txid !== me.txid && p.txid !== root?.txid).sort((a, b) => a.at - b.at);
  return { post: me, parent: root, replies };
}
