import { describe, expect, test } from 'bun:test';
import {
  decodeScript,
  filterFeed,
  groupThread,
  buildPostScript,
  parseBmapPost,
  sourceLabel,
  sourceOf,
  sourceUrl,
  threadRoot,
  validatePost,
  type FeedPost,
} from './post';
import { visiblePosts } from './store';
import { SafetyFilter, normalizeBlocklist } from '../market/safety';

const tx = (n: number) => n.toString(16).padStart(64, '0');
const THREAD = '66b31fb5-a3cb-4245-b457-3774101e04a4';

// Shapes copied from live bmap documents (Treechat root + reply, Twetch post).
const treechat = (n: number, at: string, extra: Record<string, string> = {}, thread = THREAD) => ({
  _id: tx(n),
  tx: { h: tx(n) },
  timestamp: 1788935644881,
  AIP: [{ address: '14aqJ2hMtENYJVCJaekcrqi12fiZJzoWGK' }],
  B: [{ 'content-type': 'text/markdown', encoding: 'UTF-8', content: `post ${n}` }],
  MAP: [
    {
      CMD: 'SET',
      app: 'treechat',
      type: 'post',
      username: 'SMART_SOY',
      treechat_msg_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      treechat_thread_id: thread,
      treechat_created_at: at,
      bapID: '',
      ...extra,
    },
  ],
});
const p = (doc: unknown) => parseBmapPost(doc)!;

describe('source app', () => {
  test('sourceOf / sourceLabel from MAP app', () => {
    expect(sourceOf('bWallet')).toBe('bwallet');
    expect(sourceOf('treechat')).toBe('treechat');
    expect(sourceOf('treechat_staging')).toBe('treechat');
    expect(sourceOf('twetch')).toBe('twetch');
    expect(sourceOf('1satsocial')).toBe('other');
    expect(sourceOf('')).toBe('other');
    expect(sourceLabel('treechat_staging')).toBe('Treechat');
    expect(sourceLabel('twetch')).toBe('Twetch');
    expect(sourceLabel('1satsocial')).toBe('1satsocial');
    expect(sourceLabel('bWallet')).toBe('');
    expect(sourceLabel('peck.agents')).toBe('peck.agents');
  });

  test('Treechat post: username as author, created_at as time, thread id, link', () => {
    const post = p(treechat(1, '2026-04-13T18:29:19Z'));
    expect(post.source).toBe('treechat');
    expect(post.author.name).toBe('SMART_SOY');
    expect(post.author.bapId).toBeNull();
    expect(post.at).toBe(Date.parse('2026-04-13T18:29:19Z'));
    expect(post.threadId).toBe(THREAD);
    expect(sourceUrl(post)).toBe(`https://app.treechat.com/p/${THREAD}`);
  });

  test('Twetch post: reply field, numeric user, link by txid', () => {
    const post = p({
      tx: { h: tx(9) },
      timestamp: 1746809196260,
      B: [{ 'content-type': 'text/plain', content: 'gm twetch' }],
      MAP: [{ CMD: 'SET', app: 'twetch', type: 'post', mb_user: '229', reply: tx(8), twdata_json: 'null' }],
    });
    expect(post.source).toBe('twetch');
    expect(post.author.name).toBe('Twetch user 229');
    expect(post.replyTo).toBe(tx(8));
    expect(post.threadId).toBeNull();
    expect(sourceUrl(post)).toBe(`https://twetch.com/t/${tx(9)}`);
    const top = p({
      tx: { h: tx(7) },
      B: [{ 'content-type': 'text/plain', content: 'x' }],
      MAP: [{ app: 'twetch', reply: 'null' }],
    });
    expect(top.replyTo).toBeNull();
  });

  test('other apps get no link', () => {
    const post = p({
      tx: { h: tx(5) },
      B: [{ 'content-type': 'text/plain', content: 'x' }],
      MAP: [{ app: '1satsocial', type: 'post' }],
    });
    expect(sourceUrl(post)).toBeNull();
  });
});

describe('thread grouping', () => {
  const root = p(treechat(1, '2026-04-13T18:29:19Z'));
  const r1 = p(treechat(2, '2026-04-13T18:40:00Z', { context: 'tx', tx: tx(1) }));
  const r2 = p(treechat(3, '2026-04-13T18:35:00Z', { context: 'tx', tx: tx(1) }));
  const sameThreadNoContext = p(treechat(4, '2026-04-13T18:31:00Z'));
  const otherThread = p(treechat(5, '2026-04-13T18:30:00Z', {}, 'c596a6e1-d65e-4945-97af-f0dd8efc93eb'));

  test('threadRoot: Treechat replies point at the root', () => {
    expect(threadRoot(r1)).toBe(tx(1));
    expect(threadRoot(root)).toBe(tx(1));
  });

  test('groups every post sharing treechat_thread_id, oldest first, drops noise', () => {
    const g = groupThread(r1, [otherThread, r1, r2, root, sameThreadNoContext, r2]);
    expect(g.map((x) => x.txid)).toEqual([tx(1), tx(4), tx(3), tx(2)]);
  });

  test('non-Treechat: root plus direct replies', () => {
    const a = { ...root, source: 'other' as const, threadId: null, replyTo: null };
    const b = { ...r1, source: 'other' as const, threadId: null };
    const c = { ...otherThread, source: 'other' as const, threadId: null, replyTo: null };
    expect(groupThread(a, [b, c]).map((x) => x.txid)).toEqual([tx(1), tx(2)]);
  });

  test('safety filter + mutes still apply to syndicated posts', () => {
    const none = new SafetyFilter(normalizeBlocklist({}));
    expect(visiblePosts([root, r1], [root.author.address], none)).toHaveLength(0);
    const s = new SafetyFilter(normalizeBlocklist({ keywords: ['post 2'] }));
    expect(visiblePosts([root, r1], [], s).map((x) => x.txid)).toEqual([tx(1)]);
  });
});

describe('source filter', () => {
  const mk = (n: number, app: string, at: number, address = `addr${n}`): FeedPost => ({
    ...p({ tx: { h: tx(n) }, B: [{ 'content-type': 'text/plain', content: 'x' }], MAP: [{ app, type: 'post' }] }),
    at,
    author: { address, bapId: null, name: address, avatar: null },
  });
  const posts = [mk(1, 'bWallet', 1), mk(2, 'treechat', 4), mk(3, 'twetch', 3), mk(4, 'peck.agents', 2, 'friend')];
  test('filters by source', () => {
    expect(filterFeed(posts, 'treechat').map((x) => x.txid)).toEqual([tx(2)]);
    expect(filterFeed(posts, 'other').map((x) => x.txid)).toEqual([tx(4)]);
    expect(filterFeed(posts, 'all')).toHaveLength(4);
  });
  test('followed authors rank first', () => {
    expect(filterFeed(posts, 'all', (a) => a.address === 'friend').map((x) => x.txid)).toEqual([
      tx(4),
      tx(2),
      tx(3),
      tx(1),
    ]);
  });
});

describe('Treechat reply interop', () => {
  test('reply carries context tx (root) + treechat_thread_id, app stays bWallet', () => {
    const d = decodeScript(buildPostScript({ text: 'from bWallet', replyTo: tx(1), threadId: THREAD.toUpperCase() }))!;
    expect(d.MAP).toEqual({ app: 'bWallet', type: 'post', context: 'tx', tx: tx(1), treechat_thread_id: THREAD });
  });
  test('thread id needs a reply and a UUID', () => {
    expect(decodeScript(buildPostScript({ text: 'x', threadId: THREAD }))!.MAP).toEqual({
      app: 'bWallet',
      type: 'post',
    });
    expect(validatePost({ text: 'x', replyTo: tx(1), threadId: 'nope' })).toMatch(/thread/);
  });
});
