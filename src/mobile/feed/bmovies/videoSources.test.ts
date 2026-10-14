import { describe, expect, test } from 'bun:test';
import { clipPageUrl, feedPageUrl, type Clip } from './bmovies';
import { BMUSIC_SOURCES, BNEWS_SOURCES, fetchMerged, mergeClips, type VideoSource } from './videoSources';

const PROXY = '/api/tweet-video?u=https%3A%2F%2Fvideo.twimg.com%2Fext_tw_video%2F1%2Fpu%2Fvid%2Fa.mp4';
const item = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Clip ${id}`,
  ticker: 'T',
  trailerUrl: PROXY,
  createdAt,
  ...over,
});
const clip = (id: string, at: number): Clip => ({
  id,
  offerId: id,
  title: id,
  blurb: '',
  ticker: '',
  handle: '',
  tweetUrl: null,
  src: 'https://x.example/a.mp4',
  poster: null,
  at,
});
const src = (id: string, enabled = true): VideoSource => ({
  id,
  label: id.toUpperCase(),
  url: `https://www.bmovies.app/api/feed?skin=${id}`,
  skin: id,
  enabled,
});

describe('video source registry', () => {
  test('bMusic reads the bMusic skin of bmovies.app; VexVoid, NPGX and GZONE are listed but off with a todo', () => {
    expect(BMUSIC_SOURCES[0]).toMatchObject({ id: 'bmusic', enabled: true });
    expect(BMUSIC_SOURCES[0].url).toBe('https://www.bmovies.app/api/feed?skin=bmusic');
    for (const id of ['vexvoid', 'npgx', 'gzone']) {
      const s = BMUSIC_SOURCES.find((x) => x.id === id);
      expect(s?.enabled).toBe(false);
      expect(s?.todo).toBeTruthy();
    }
    expect(BNEWS_SOURCES.map((s) => [s.id, s.enabled])).toEqual([['gmehl', true]]);
  });

  test('page URLs append to a skin URL with &, and share pages keep the skin', () => {
    expect(feedPageUrl(null, 'https://www.bmovies.app/api/feed?skin=bmusic')).toBe(
      'https://www.bmovies.app/api/feed?skin=bmusic&limit=20',
    );
    expect(feedPageUrl('c 1', 'https://www.bmovies.app/api/feed?skin=gmehl')).toBe(
      'https://www.bmovies.app/api/feed?skin=gmehl&cursor=c%201&limit=20',
    );
    expect(feedPageUrl(null)).toBe('https://www.bmovies.app/api/feed?limit=20');
    expect(clipPageUrl({ offerId: 'a b', skin: 'bmusic' })).toBe(
      'https://www.bmovies.app/feed?focus=a%20b&skin=bmusic',
    );
    expect(clipPageUrl({ offerId: 'x' })).toBe('https://www.bmovies.app/feed?focus=x');
  });
});

describe('merging sources', () => {
  test('dedupes by id (first wins) and sorts newest first', () => {
    const merged = mergeClips([
      [clip('a', 1), clip('b', 5)],
      [{ ...clip('a', 9), via: 'other' }, clip('c', 3)],
    ]);
    expect(merged.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(merged.find((c) => c.id === 'a')?.via).toBeUndefined();
  });

  test('fetches only enabled sources, tags via/skin, tracks cursors per source', async () => {
    const seen: string[] = [];
    const pages: Record<string, unknown> = {
      one: { items: [item('x', '2026-10-01T00:00:00Z'), item('dup', '2026-09-01T00:00:00Z')], nextCursor: 'n1' },
      two: { items: [item('y', '2026-10-05T00:00:00Z'), item('dup', '2026-09-01T00:00:00Z')], nextCursor: null },
    };
    const json = async (u: string) => {
      seen.push(u);
      return pages[/skin=(\w+)/.exec(u)?.[1] ?? ''] ?? null;
    };
    const page = await fetchMerged([src('one'), src('two'), src('off', false)], {}, json);
    expect(seen.length).toBe(2);
    expect(page.clips.map((c) => [c.id, c.via, c.skin])).toEqual([
      ['y', 'TWO', 'two'],
      ['x', 'ONE', 'one'],
      ['dup', 'ONE', 'one'],
    ]);
    expect(page.cursors).toEqual({ one: 'n1', two: null });
    expect(page.more).toBe(true);

    seen.length = 0;
    const p2 = await fetchMerged([src('one'), src('two')], page.cursors, json);
    expect(seen).toEqual(['https://www.bmovies.app/api/feed?skin=one&cursor=n1&limit=20']);
    expect(p2.clips.length).toBe(2);
  });

  test('a failing source is skipped; all failing on page one throws', async () => {
    const ok = async (u: string) => (u.includes('skin=one') ? { items: [item('x', '2026-10-01T00:00:00Z')] } : null);
    const page = await fetchMerged([src('one'), src('two')], {}, ok);
    expect(page.clips.map((c) => c.id)).toEqual(['x']);
    expect(page.cursors.two).toBeUndefined();
    expect(fetchMerged([src('one')], {}, async () => null)).rejects.toThrow();
  });

  test('adult-looking items are screened out of merged sources too', async () => {
    const json = async () => ({
      items: [item('ok', '2026-10-01T00:00:00Z'), item('bad', '2026-10-02T00:00:00Z', { title: 'nsfw clip' })],
    });
    const page = await fetchMerged([src('one')], {}, json);
    expect(page.clips.map((c) => c.id)).toEqual(['ok']);
  });
});
