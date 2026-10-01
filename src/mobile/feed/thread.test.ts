import { describe, expect, test } from 'bun:test';
import { ancestorChain, parentRef, parseTwetchFeed, parseTwetchPost, type FeedPost } from './post';

const tx = (n: number) => n.toString(16).padStart(64, '0');
const post = (n: number, extra: Partial<FeedPost> = {}): FeedPost => ({
  txid: tx(n),
  text: `post ${n}`,
  images: [],
  media: [],
  links: [],
  app: 'bChat',
  source: 'bchat',
  threadId: null,
  replyTo: null,
  author: { address: `a${n}`, bapId: null, name: `n${n}`, avatar: null },
  at: n,
  likes: 0,
  replies: 0,
  ...extra,
});

describe('parentRef', () => {
  test('reply beats quote; none for a root', () => {
    expect(parentRef(post(1))).toBeNull();
    expect(parentRef(post(2, { replyTo: tx(1), quoteTxid: tx(9) }))).toEqual({
      kind: 'reply',
      txid: tx(1),
      twetchId: undefined,
    });
    expect(parentRef(post(3, { quoteTxid: tx(1) }))).toEqual({ kind: 'quote', txid: tx(1), twetchId: undefined });
    expect(parentRef(post(4, { parentId: 77, replyTo: null }))).toEqual({ kind: 'reply', txid: null, twetchId: 77 });
  });
});

describe('ancestorChain', () => {
  const byTx = new Map<string, FeedPost>([
    [tx(1), post(1)],
    [tx(2), post(2, { replyTo: tx(1) })],
    [tx(3), post(3, { quoteTxid: tx(2) })],
  ]);
  const get = async (r: { txid: string | null }) => (r.txid ? (byTx.get(r.txid) ?? null) : null);

  test('walks to the root, root first', async () => {
    const chain = await ancestorChain(post(4, { replyTo: tx(3) }), get);
    expect(chain.map((p) => p.txid)).toEqual([tx(1), tx(2), tx(3)]);
  });
  test('stops at a missing or failing parent', async () => {
    expect(await ancestorChain(post(5, { replyTo: tx(99) }), get)).toEqual([]);
    expect(
      await ancestorChain(post(5, { replyTo: tx(3) }), async (r) => {
        if (r.txid === tx(2)) throw new Error('down');
        return get(r);
      }),
    ).toEqual([byTx.get(tx(3))!]);
  });
  test('cycles and the depth cap end the walk', async () => {
    const loop = new Map([
      [tx(1), post(1, { replyTo: tx(2) })],
      [tx(2), post(2, { replyTo: tx(1) })],
    ]);
    const chain = await ancestorChain(post(3, { replyTo: tx(1) }), async (r) => loop.get(r.txid!) ?? null);
    expect(chain.map((p) => p.txid)).toEqual([tx(2), tx(1)]);
    const deep = await ancestorChain(post(9, { replyTo: tx(1) }), async (r) => loop.get(r.txid!) ?? null, 1);
    expect(deep).toHaveLength(1);
  });
});

describe('Twetch thread fields', () => {
  const body = {
    data: [
      { id: 10, txid: tx(10), userId: 5, type: 'post', replyPostId: 7, content: 'a reply', postedAtMs: 2 },
      { id: 11, txid: tx(11), userId: 5, type: 'branch', quotedPostId: 8, content: 'a quote', postedAtMs: 3 },
      { id: 12, txid: tx(12), userId: 5, type: 'branch', quotedPostId: 8, content: '', postedAtMs: 4 },
    ],
    users: { '5': { id: 5, name: 'Bob' } },
    replyPosts: { '7': { id: 7, txid: tx(7) } },
    quotedPosts: { '8': { id: 8, txid: tx(8) } },
  };
  test('list: numeric ids, parent and quote; bare branches dropped', () => {
    const got = parseTwetchFeed(body);
    expect(got.map((p) => p.txid)).toEqual([tx(11), tx(10)]);
    const [quote, reply] = got;
    expect(reply).toMatchObject({ twetchId: 10, parentId: 7, replyTo: tx(7), twetchUserId: '5' });
    expect(quote).toMatchObject({ twetchId: 11, quoteId: 8, quoteTxid: tx(8), replyTo: null });
    expect(parentRef(reply)).toEqual({ kind: 'reply', txid: tx(7), twetchId: 7 });
  });
  test('detail: /v1/posts/{id}', () => {
    const p = parseTwetchPost({
      post: { id: 7, txid: tx(7), userId: 13, type: 'post', replyPostId: 3, content: 'parent', postedAtMs: 1 },
      author: { id: 13, name: 'Alice' },
      quotedPost: null,
    });
    expect(p).toMatchObject({ twetchId: 7, parentId: 3, replyTo: null, author: { name: 'Alice' } });
    expect(parentRef(p!)).toEqual({ kind: 'reply', txid: null, twetchId: 3 });
    expect(parseTwetchPost({})).toBeNull();
  });
});
