import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseOverlayAny, parsePeckBody, parsePeckItem, parseTreechatOverlayFeed } from './peck';
import { buildTreechatTree, treechatThreadIdFromRawTx, treechatThreadView } from './treechat';
import { sourceUrl } from './sources';
import { payDestination } from './tip';
import type { FeedPost } from './post';

// Recorded from overlay.peck.to (and the raw tx from WhatsOnChain) on 2026-10-06.
// Chain: ec3f3578 → 198f2276 → 0fab8ffe → 5bb4db10 (root). 198f's raw tx names thread 7f5409ba-….
const raw = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const fx = (f: string) => parsePeckBody(raw(f)) as { data?: unknown; replies?: unknown };
const feed = fx('overlay-treechat.json') as { data: Record<string, unknown>[] };
const posts = parseTreechatOverlayFeed(feed);
const ROOT = '5bb4db10f5d576d9ff7f970e03099ab389ba5f7a128329a62fc811be2a446084';
const MID = '0fab8ffec007fc0b099b6be093f04f6e72fa0782f7b9cb5433982b888d901cec';
const QUEST = '198f2276f348c12d2b512623cb1fae6d3d77c70961cda611ae813dde6881bdc7';
const LEAF = 'ec3f35788b68caf8acaf44a57f759b16330551b6e3fa32dddfb99abe897be146';
const QUEST_THREAD = '7f5409ba-50f3-42ad-9b98-89050de8ec3d';
const leaf = posts.find((p) => p.txid === LEAF)!;

describe('Treechat (overlay.peck.to)', () => {
  test('reads posts and replies', () => {
    expect(feed.data.length).toBe(12);
    expect(posts.length).toBe(12);
    expect(posts.every((p) => p.source === 'treechat' && p.app === 'treechat')).toBe(true);
    expect(posts.filter((p) => !p.replyTo).length).toBe(4);
  });
  test('reply fields', () => {
    expect(leaf.replyTo).toBe(QUEST);
    expect(leaf.author.name).toBe('Nakatoshi');
    expect(leaf.author.address).toBe('treechat:nakatoshi');
    expect(leaf.at).toBe(Date.parse('2026-10-06T21:21:10.000Z'));
    expect(leaf.threadId).toBeNull();
  });
  test('tips stay disabled (shared relay signer)', () => {
    expect(payDestination(leaf).ok).toBe(false);
  });
  test('the Peck parser ignores Treechat; parseOverlayAny reads both', () => {
    expect(parsePeckItem(feed.data[0])).toBeNull();
    expect(parseOverlayAny(feed.data[0])?.source).toBe('treechat');
  });
});

describe('Treechat thread id from the raw tx', () => {
  const hex = raw('treechat-rawtx-198f2276.hex').trim();
  test('reads MAP treechat_thread_id', () => {
    expect(treechatThreadIdFromRawTx(hex, QUEST)).toBe(QUEST_THREAD);
  });
  test('refuses hex that does not hash to the txid, and garbage', () => {
    expect(treechatThreadIdFromRawTx(hex, LEAF)).toBeNull();
    expect(treechatThreadIdFromRawTx('zz', QUEST)).toBeNull();
  });
  test('link to the original only with a thread id', () => {
    expect(sourceUrl({ ...leaf, threadId: QUEST_THREAD })).toBe(`https://app.treechat.com/p/${QUEST_THREAD}`);
    expect(sourceUrl(leaf)).toBeNull();
  });
});

describe('Treechat conversation tree', () => {
  const files: Record<string, string> = { [ROOT]: '5bb4db10', [MID]: '0fab8ffe', [QUEST]: '198f2276' };
  const reads = {
    post: async (t: string) => (files[t] ? parseOverlayAny(fx(`overlay-treechat-post-${files[t]}.json`).data) : null),
    replies: async (t: string) =>
      files[t] ? parseTreechatOverlayFeed({ data: fx(`overlay-treechat-thread-${files[t]}.json`).replies }) : [],
    extra: async (): Promise<FeedPost[]> => [],
  };
  test('walks up to the root and groups the whole chain', async () => {
    const tree = await buildTreechatTree(leaf, reads);
    expect(tree.root.txid).toBe(ROOT);
    const ids = new Set(tree.posts.map((p) => p.txid));
    for (const t of [ROOT, MID, QUEST, LEAF]) expect(ids.has(t)).toBe(true);
    expect(tree.posts.filter((p) => p.replyTo === ROOT).length).toBe(13);
    expect(tree.posts.some((p) => p.txid.startsWith('50a15817') && p.replyTo === MID)).toBe(true);
    const view = treechatThreadView(tree.posts.find((p) => p.txid === MID)!, tree);
    expect(view.parent?.txid).toBe(ROOT);
    expect(view.replies.length).toBe(tree.posts.length - 2);
  });
  test('bmap fallback replies merge in; a parent loop terminates', async () => {
    const old = { ...leaf, txid: 'aa'.repeat(32), replyTo: ROOT };
    const root = (await reads.post(ROOT))!;
    const t = await buildTreechatTree(root, {
      ...reads,
      replies: async () => [],
      extra: async (x) => (x === ROOT ? [old] : []),
    });
    expect(t.posts.some((p) => p.txid === old.txid)).toBe(true);
    const loop = await buildTreechatTree(
      { ...leaf, replyTo: LEAF },
      { post: async () => ({ ...leaf }), replies: async () => [], extra: async () => [] },
    );
    expect(loop.root.txid).toBe(LEAF);
  });
});
