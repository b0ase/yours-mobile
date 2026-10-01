import { describe, expect, test } from 'bun:test';
import type { PostLock } from './locks';
import type { FeedPost } from './post';
import {
  authorKey,
  cutoff,
  formatUsd,
  fresh,
  isMe,
  LEADERBOARD_TTL,
  lockedSats,
  rankPeople,
  rankPosts,
} from './leaderboard';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const tx = (n: number) => n.toString(16).padStart(64, '0');

const post = (
  n: number,
  author: Partial<FeedPost['author']>,
  at: number,
  source: FeedPost['source'] = 'bsocial',
): FeedPost =>
  ({
    txid: tx(n),
    text: `post ${n}`,
    images: [],
    media: [],
    links: [],
    app: 'bsocial',
    source,
    threadId: null,
    replyTo: null,
    author: { address: '', bapId: null, name: 'anon', avatar: null, ...author },
    at,
  }) as FeedPost;

const lock = (post: number, id: number, satoshis: number, address = 'L1'): PostLock => ({
  lockTxid: tx(1000 + id),
  postTxid: tx(post),
  satoshis,
  until: 900_000,
  address,
});

describe('cutoff', () => {
  test('timeframes', () => {
    expect(cutoff('1d', NOW)).toBe(NOW - DAY);
    expect(cutoff('7d', NOW)).toBe(NOW - 7 * DAY);
    expect(cutoff('1m', NOW)).toBe(NOW - 30 * DAY);
    expect(cutoff('all', NOW)).toBe(0);
  });
});

describe('lockedSats', () => {
  test('dedupes lock txs, counts lockers, ignores zero', () => {
    const l = lock(1, 1, 500, 'A');
    expect(lockedSats([l, l, lock(1, 2, 300, 'B'), lock(1, 3, 0, 'C')])).toEqual({ sats: 800, lockers: 2 });
    expect(lockedSats(undefined)).toEqual({ sats: 0, lockers: 0 });
  });
});

describe('rankPosts', () => {
  const alice = { bapId: 'BAPA', name: 'alice' };
  const posts = [
    post(1, alice, NOW - 1000),
    post(2, alice, NOW - 2 * DAY),
    post(3, { address: '1Bob', name: 'bob' }, NOW - 500),
    post(4, alice, NOW),
  ];
  const locks = { [tx(1)]: [lock(1, 1, 100)], [tx(2)]: [lock(2, 2, 900)], [tx(3)]: [lock(3, 3, 100)] };

  test('orders by sats, ties newer first, drops unlocked posts, ranks 1..n', () => {
    const r = rankPosts(posts, locks, 0);
    expect(r.map((x) => [x.rank, x.post.txid])).toEqual([
      [1, tx(2)],
      [2, tx(3)],
      [3, tx(1)],
    ]);
  });

  test('filters by post time', () => {
    expect(rankPosts(posts, locks, NOW - DAY).map((x) => x.post.txid)).toEqual([tx(3), tx(1)]);
  });

  test('dedupes posts and respects limit', () => {
    expect(rankPosts([...posts, posts[1]], locks, 0, 1)).toHaveLength(1);
  });
});

describe('rankPeople', () => {
  test('sums by author key and ranks', () => {
    const alice = { bapId: 'BAPA', name: 'alice', address: '1A' };
    const posts = [
      post(1, alice, NOW),
      post(2, { ...alice, address: '1A2', avatar: 'https://x/a.png' }, NOW),
      post(3, { address: '1Bob', name: 'bob' }, NOW),
      post(4, { name: 'treeuser' }, NOW, 'treechat'),
    ];
    const locks = {
      [tx(1)]: [lock(1, 1, 300)],
      [tx(2)]: [lock(2, 2, 300)],
      [tx(3)]: [lock(3, 3, 500)],
      [tx(4)]: [lock(4, 4, 50)],
    };
    const r = rankPeople(posts, locks, 0);
    expect(r.map((x) => [x.rank, x.author.name, x.sats, x.posts])).toEqual([
      [1, 'alice', 600, 2],
      [2, 'bob', 500, 1],
      [3, 'treeuser', 50, 1],
    ]);
    expect(r[0].author.avatar).toBe('https://x/a.png');
    expect(r[2].key).toBe('name:treechat:treeuser');
    expect(r[2].source).toBe('treechat');
  });

  test('timeframe excludes old posts from totals', () => {
    const posts = [post(1, { bapId: 'X', name: 'x' }, NOW), post(2, { bapId: 'X', name: 'x' }, NOW - 10 * DAY)];
    const locks = { [tx(1)]: [lock(1, 1, 10)], [tx(2)]: [lock(2, 2, 1000)] };
    expect(rankPeople(posts, locks, cutoff('7d', NOW))[0].sats).toBe(10);
    expect(rankPeople(posts, locks, cutoff('all', NOW))[0].sats).toBe(1010);
  });
});

describe('helpers', () => {
  test('authorKey precedence', () => {
    expect(authorKey(post(1, { bapId: 'B', address: '1A' }, 0))).toBe('bap:B');
    expect(authorKey(post(1, { address: '1A' }, 0))).toBe('addr:1A');
  });
  test('isMe', () => {
    expect(isMe({ bapId: 'B', address: '' }, { bapId: 'B' })).toBe(true);
    expect(isMe({ bapId: null, address: '1A' }, { bapId: null, addresses: ['1A'] })).toBe(true);
    expect(isMe({ bapId: null, address: '' }, { bapId: null, addresses: [''] })).toBe(false);
  });
  test('formatUsd', () => {
    expect(formatUsd(100_000_000, 50)).toBe('≈ $50.00');
    expect(formatUsd(1_000_000_000, 50)).toBe('≈ $500');
    expect(formatUsd(1, 0)).toBe('');
  });
  test('cache freshness', () => {
    const d = { posts: [], locks: {}, oldest: 0, complete: true, at: NOW };
    expect(fresh(d, NOW + LEADERBOARD_TTL - 1)).toBe(true);
    expect(fresh(d, NOW + LEADERBOARD_TTL)).toBe(false);
  });
});
