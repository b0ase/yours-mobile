import { describe, expect, test } from 'bun:test';
import { authorFeedUrl, fetchBrandPage, parseBrandPage, parseBrandPost, profileUrl } from './bchatxFeed';

const TX = 'a'.repeat(64);

describe('bChatX brand feed', () => {
  test('urls', () => {
    expect(authorFeedUrl('bmusic')).toBe('https://www.bchatx.com/api/feed/author/bmusic?tab=posts');
    expect(authorFeedUrl('bmusic', '2')).toBe('https://www.bchatx.com/api/feed/author/bmusic?tab=posts&cursor=2');
    expect(profileUrl('bradio')).toBe('https://www.bchatx.com/u/bradio');
  });

  test('on-chain posts link to /feed/p; media kept https only', () => {
    const p = parseBrandPost({
      txid: TX.toUpperCase(),
      text: 'hi',
      at: 5,
      media: [
        { kind: 'image', src: 'https://x/i.jpg', thumb: null },
        { kind: 'video', src: 'http://insecure/v.mp4' },
        { kind: 'evil', src: 'https://x/e' },
      ],
    });
    expect(p?.link).toBe(`https://www.bchatx.com/feed/p/${TX}`);
    expect(p?.media).toEqual([{ kind: 'image', src: 'https://x/i.jpg', thumb: null }]);
    expect(p?.at).toBe(5);
  });

  test('external posts link to their original and carry the credit', () => {
    const p = parseBrandPost({
      txid: 'bmovies:123',
      text: 'clip',
      credit: { via: '@maker', profileUrl: 'https://x.com/maker', originalUrl: 'https://x.com/maker/status/1' },
    });
    expect(p?.link).toBe('https://x.com/maker/status/1');
    expect(p?.credit).toEqual({ via: '@maker', profileUrl: 'https://x.com/maker' });
    expect(parseBrandPost({ txid: 'b0x:9', credit: { originalUrl: 'javascript:alert(1)' } })?.link).toBe(
      'https://www.bchatx.com/feed/p/b0x%3A9',
    );
  });

  test('pages: malformed is empty; posts without an id are dropped; images fall back', () => {
    expect(parseBrandPage(null)).toEqual({ posts: [], next: null });
    const page = parseBrandPage({ posts: [{ text: 'no id' }, { txid: TX, images: ['https://x/a.png'] }], next: '3' });
    expect(page.posts).toHaveLength(1);
    expect(page.posts[0].media).toEqual([{ kind: 'image', src: 'https://x/a.png', thumb: null }]);
    expect(page.next).toBe('3');
  });

  test('fetch uses the given client and throws on failure', async () => {
    const seen: string[] = [];
    const page = await fetchBrandPage('bnews', null, async (u) => (seen.push(u), { posts: [], next: null }));
    expect(page.posts).toEqual([]);
    expect(seen[0]).toContain('/api/feed/author/bnews');
    await expect(fetchBrandPage('bnews', null, async () => null)).rejects.toThrow();
  });
});
