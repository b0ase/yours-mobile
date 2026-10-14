import { describe, expect, test } from 'bun:test';
import {
  appendPage,
  clipPageUrl,
  fetchClips,
  findPoster,
  firstFrameUrl,
  parseFeed,
  playableUrl,
  posterFromSyndication,
  toClip,
  tweetIdOf,
} from './bmovies';

const PROXY =
  '/api/tweet-video?u=https%3A%2F%2Fvideo.twimg.com%2Famplify_video%2F2102001491888279552%2Fvid%2F720x1280%2Fa.mp4';
const item = (over: Record<string, unknown> = {}) => ({
  id: 'convert-2102001651062026668-bnpua0',
  offerId: 'convert-2102001651062026668-bnpua0',
  kind: 'pitch',
  title: 'A masterpiece',
  ticker: 'YASEEN',
  blurb: '',
  art: 'https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg',
  trailerUrl: PROXY,
  handle: 'yaseenk7212',
  createdAt: '2026-09-21T18:45:55.173113+00:00',
  ...over,
});

describe('bMovies feed parsing', () => {
  test('relative proxy URLs get the bMovies origin; other hosts and http are refused', () => {
    expect(playableUrl(PROXY)).toBe(`https://www.bmovies.app${PROXY}`);
    expect(playableUrl('/api/tweet-video?u=https%3A%2F%2Fevil.example%2Fa.mp4')).toBeNull();
    expect(playableUrl('http://x.example/a.mp4')).toBeNull();
    expect(playableUrl('https://cdn.example/a.mp4')).toBe('https://cdn.example/a.mp4');
    expect(playableUrl('//evil.example/a.mp4')).toBeNull();
  });

  test('an item becomes a clip; no video or no time drops it', () => {
    const c = toClip(item());
    expect(c?.src.startsWith('https://www.bmovies.app/api/tweet-video?')).toBe(true);
    expect(c?.poster).toBe('https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg');
    expect(c?.handle).toBe('yaseenk7212');
    expect(toClip(item({ trailerUrl: null }))).toBeNull();
    expect(toClip(item({ createdAt: 'never' }))).toBeNull();
    expect(toClip(item({ art: null }))?.poster).toBeNull();
  });

  test('pages are sorted newest first (the API is not) and deduped', () => {
    const page = parseFeed({
      items: [
        item({ id: 'a', createdAt: '2026-09-01T00:00:00Z' }),
        item({ id: 'b', createdAt: '2026-10-01T00:00:00Z' }),
        item({ id: 'a', createdAt: '2026-09-01T00:00:00Z' }),
        item({ id: 'c', createdAt: '2026-09-15T00:00:00Z' }),
      ],
      nextCursor: '2026-09-01T00:00:00Z',
    });
    expect(page.clips.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(page.next).toBe('2026-09-01T00:00:00Z');
    expect(parseFeed(null)).toEqual({ clips: [], next: null });
    expect(
      appendPage(page.clips, parseFeed({ items: [item({ id: 'a' }), item({ id: 'd' })] }).clips).map((c) => c.id),
    ).toEqual(['b', 'c', 'a', 'd']);
  });

  test('share link focuses the offer', () => {
    expect(clipPageUrl({ offerId: 'tweet-1 2' })).toBe('https://www.bmovies.app/feed?focus=tweet-1%202');
  });

  test('fetch passes the cursor and throws when bMovies does not answer', async () => {
    const seen: string[] = [];
    const page = await fetchClips('2026-09-01T00:00:00.000Z', async (u) => {
      seen.push(u);
      return { items: [item()] };
    });
    expect(seen[0]).toBe('https://www.bmovies.app/api/feed?cursor=2026-09-01T00%3A00%3A00.000Z&limit=20');
    expect(page.clips).toHaveLength(1);
    expect(fetchClips(null, async () => null)).rejects.toThrow();
  });
});

describe('bMovies poster fallback', () => {
  test('tweet id from the item id', () => {
    expect(tweetIdOf('tweet-2103132532766331372')).toBe('2103132532766331372');
    expect(tweetIdOf('convert-2102001651062026668-bnpua0')).toBe('2102001651062026668');
    expect(tweetIdOf('pitch-abc')).toBeNull();
  });

  test('syndication poster: pbs.twimg.com only, the matching media id first', () => {
    const src = `https://www.bmovies.app${PROXY}`;
    const json = {
      mediaDetails: [
        { media_url_https: 'https://pbs.twimg.com/media/other.jpg' },
        { media_url_https: 'https://pbs.twimg.com/amplify_video_thumb/2102001491888279552/img/x.jpg' },
        { media_url_https: 'https://evil.example/x.jpg' },
      ],
    };
    expect(posterFromSyndication(json, src)).toBe(
      'https://pbs.twimg.com/amplify_video_thumb/2102001491888279552/img/x.jpg',
    );
    expect(
      posterFromSyndication({ mediaDetails: [{ media_url_https: 'https://evil.example/x.jpg' }] }, src),
    ).toBeNull();
    expect(posterFromSyndication(null, src)).toBeNull();
  });

  test('findPoster: art first, else X embed JSON, failures are null', async () => {
    const withArt = toClip(item())!;
    expect(await findPoster(withArt, async () => ({}))).toBe(withArt.poster);
    const noArt = toClip(item({ id: 'tweet-2103132532766331372', art: null }))!;
    const urls: string[] = [];
    const p = await findPoster(noArt, async (u) => {
      urls.push(u);
      return { mediaDetails: [{ media_url_https: 'https://pbs.twimg.com/media/p.jpg' }] };
    });
    expect(urls[0]).toBe('https://cdn.syndication.twimg.com/tweet-result?id=2103132532766331372&token=x');
    expect(p).toBe('https://pbs.twimg.com/media/p.jpg');
    const broken = toClip(item({ id: 'convert-2109999999999999999-x', art: null }))!;
    expect(
      await findPoster(broken, async () => {
        throw new Error('cors');
      }),
    ).toBeNull();
    expect(firstFrameUrl('https://a.example/v.mp4')).toBe('https://a.example/v.mp4#t=0.5');
  });
});

describe('attribution', () => {
  test('parses a valid handle and original post URL', () => {
    const c = toClip(
      item({ handle: '@some_artist', tweetUrl: 'https://x.com/some_artist/status/2102001651062026668' }),
    );
    expect(c?.handle).toBe('some_artist');
    expect(c?.tweetUrl).toBe('https://x.com/some_artist/status/2102001651062026668');
  });
  test('rejects bad handles and non-X URLs', () => {
    const c = toClip(item({ handle: 'not a handle!', tweetUrl: 'http://x.com/a/status/1' }));
    expect(c?.handle).toBe('');
    expect(c?.tweetUrl).toBeNull();
    expect(toClip(item({ tweetUrl: 'https://evil.com/x.com' }))?.tweetUrl).toBeNull();
    expect(toClip(item({ tweetUrl: 'https://twitter.com/a/status/123' }))?.tweetUrl).toBe(
      'https://twitter.com/a/status/123',
    );
    expect(toClip(item({ handle: 'a'.repeat(16) }))?.handle).toBe('');
  });
  test('parseFeed drops screened items', () => {
    const page = parseFeed({ items: [item({ title: 'はだかつ' }), item({ id: 'tweet-2102001651062026669' })] });
    expect(page.clips.map((c) => c.id)).toEqual(['tweet-2102001651062026669']);
  });
});
