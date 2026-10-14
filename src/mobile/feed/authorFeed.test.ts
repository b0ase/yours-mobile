import { describe, expect, it } from 'bun:test';
import {
  authorProfileUrl,
  authorRef,
  fetchAuthorPage,
  fetchAuthorProfile,
  parseTwetchUser,
  type AuthorDeps,
} from './authorFeed';
import { parseTwetchFeed } from './post';
import { parsePeckItem, parseTreechatOverlayItem } from './peck';
import { parseFwetchItem } from './fwetch';

const tx = (n: number) => n.toString(16).padStart(64, '0');

const deps = (routes: Record<string, unknown>, seen: string[] = []): AuthorDeps => ({
  getJson: async (url) => {
    seen.push(url);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (!hit) throw new Error(`no route ${url}`);
    return routes[hit];
  },
  bchatApi: 'https://bchat.test',
  bmapApi: 'https://bmap.test',
  fwetchPage: async () => [],
});

describe('authorRef (author id mapping)', () => {
  it('Twetch authors use their Twetch user id, even when the address is key-derived', () => {
    const [p] = parseTwetchFeed(
      {
        data: [{ id: 5, txid: tx(1), userId: 92557, type: 'post', content: 'gm', postedAtMs: 1 }],
        users: { 92557: { id: 92557, name: "m's attic", publicKey: '02aa' } },
      },
      () => '1DerivedAddr',
    );
    expect(p.author.address).toBe('1DerivedAddr');
    expect(authorRef(p.author)).toEqual({ source: 'twetch', id: '92557', bapId: null });
    expect(authorProfileUrl(authorRef(p.author))).toBe('https://twetch.com/u/92557');
  });

  it('falls back to the prefixed key for older Author objects', () => {
    expect(authorRef({ address: 'twetch:42', bapId: null })).toEqual({ source: 'twetch', id: '42', bapId: null });
    expect(authorRef({ address: 'treechat:brooz', bapId: null }).source).toBe('treechat');
  });

  it('Peck, Treechat and Fwetch authors carry their source ids', () => {
    const peck = parsePeckItem({
      txid: tx(2),
      type: 'post',
      app: 'peck.to',
      content: 'hi',
      author: '03ab',
      timestamp: '2026-01-01',
    });
    expect(authorRef(peck!.author)).toEqual({ source: 'peck', id: '03ab', bapId: null });
    const tc = parseTreechatOverlayItem({
      txid: tx(3),
      type: 'post',
      app: 'treechat',
      content: 'hi',
      author: '14aq',
      display_name: 'Brooz',
    });
    expect(authorRef(tc!.author)).toEqual({ source: 'treechat', id: 'Brooz', bapId: null });
    expect(authorProfileUrl(authorRef(tc!.author))).toBe('https://app.treechat.com/u/Brooz');
    const fw = parseFwetchItem({ txid: tx(4), body: 'yo', author_addr: '1Kc8', ts: 1 });
    expect(authorRef(fw!.author)).toEqual({ source: 'fwetch', id: '1Kc8', bapId: null });
  });

  it('bChat authors use address + BAP id', () => {
    expect(authorRef({ address: '1Abc', bapId: 'bap1' })).toEqual({ source: 'bchat', id: '1Abc', bapId: 'bap1' });
    expect(authorProfileUrl(authorRef({ address: '1Abc', bapId: null }))).toBeNull();
  });
});

describe('fetchAuthorPage', () => {
  it('reads a Twetch user’s posts, newest first, with a cursor for the next page', async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      txid: tx(i + 1),
      userId: 7,
      type: 'post',
      content: `post ${i}`,
      postedAtMs: i,
    }));
    const seen: string[] = [];
    const pg = await fetchAuthorPage(
      { source: 'twetch', id: '7', bapId: null },
      null,
      deps({ '/v1/users/7/posts': { data, users: { 7: { id: 7, name: 'seven' } }, nextCursor: 'abc' } }, seen),
    );
    expect(seen[0]).toBe('https://api.twetch.com/v1/users/7/posts?limit=20');
    expect(pg.posts).toHaveLength(20);
    expect(pg.posts[0].text).toBe('post 19');
    expect(pg.posts[0].author.name).toBe('seven');
    expect(pg.next).toBe('abc');
    const pg2 = await fetchAuthorPage(
      { source: 'twetch', id: '7', bapId: null },
      'abc',
      deps({ cursor: { data: [] } }, seen),
    );
    expect(seen[1]).toContain('cursor=abc');
    expect(pg2).toEqual({ posts: [], next: null });
  });

  it('filters Treechat (one shared key) by username', async () => {
    const pg = await fetchAuthorPage(
      { source: 'treechat', id: 'Brooz', bapId: null },
      null,
      deps({
        'app=treechat': {
          data: [
            {
              txid: tx(1),
              type: 'post',
              app: 'treechat',
              content: 'mine',
              display_name: 'Brooz',
              timestamp: '2026-01-02',
            },
            {
              txid: tx(2),
              type: 'post',
              app: 'treechat',
              content: 'theirs',
              display_name: 'popo',
              timestamp: '2026-01-03',
            },
          ],
        },
      }),
    );
    expect(pg.posts.map((p) => p.text)).toEqual(['mine']);
    expect(pg.next).toBeNull();
  });

  it('asks the Peck overlay by author key', async () => {
    const seen: string[] = [];
    const pg = await fetchAuthorPage(
      { source: 'peck', id: '03ab', bapId: null },
      null,
      deps(
        { 'author=03ab': { data: [{ txid: tx(9), type: 'post', app: 'peck.to', content: 'halo', author: '03ab' }] } },
        seen,
      ),
    );
    expect(pg.posts).toHaveLength(1);
    expect(seen[0]).toContain('author=03ab');
  });

  it('bChat: merges our indexer and bmap; one failing source is not fatal', async () => {
    const post = (n: number) => ({
      tx: { h: tx(n) },
      B: [{ content: `b${n}`, 'content-type': 'text/plain', encoding: 'UTF-8' }],
      MAP: [{ app: 'bChat', type: 'post' }],
      AIP: [{ address: '1Abc' }],
      timestamp: n,
    });
    const pg = await fetchAuthorPage(
      { source: 'bchat', id: '1Abc', bapId: null },
      null,
      deps({ 'bchat.test/social/post/address/1Abc': { results: [post(1), post(2)] } }),
    );
    expect(pg.posts.length).toBeGreaterThan(0);
  });

  it('Twetch profile info', async () => {
    const info = await fetchAuthorProfile(
      { source: 'twetch', id: '1', bapId: null },
      deps({
        '/v1/users/1': {
          id: 1,
          name: 'utxo detective',
          description: 'coining bits',
          numFollowers: 1722,
          numFollowing: 1137,
        },
      }),
    );
    expect(info).toEqual({ name: 'utxo detective', bio: 'coining bits', followers: 1722, following: 1137 });
    expect(parseTwetchUser({})).toBeNull();
    expect(await fetchAuthorProfile({ source: 'peck', id: 'x', bapId: null }, deps({}))).toBeNull();
  });
});
