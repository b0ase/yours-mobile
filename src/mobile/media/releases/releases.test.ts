import { describe, expect, test } from 'bun:test';

(globalThis as Record<string, unknown>).__MINT_FEE_ADDRESS__ = '';
const r = await import('./releases');
const { RepeatGuard, requestFingerprint } = await import('../../../services/repeatGuard');

const tx = (n: number) => n.toString(16).padStart(64, '0');
const tracks = (k = 'audio/mpeg') => JSON.stringify([{ o: `${tx(99)}_0`, t: 'One', k }]);
const row = (
  n: number,
  o: { cover?: string; app?: string; type?: string; tracks?: string; height?: number; ai?: string } = {},
) => ({
  outpoint: `${tx(n)}_0`,
  owner: `1Owner${n}`,
  height: o.height ?? 900_000 + n,
  idx: n,
  origin: {
    outpoint: `${tx(n)}_0`,
    data: {
      map: {
        app: o.app ?? 'bwallet-media',
        type: o.type ?? 'release',
        name: `Album ${n}`,
        artist: 'V3XV0ID',
        ai: o.ai ?? 'false',
        tracks: o.tracks ?? tracks(),
      },
      insc: { file: { type: o.cover ?? 'image/jpeg' } },
    },
  },
});

describe('release tags', () => {
  test('release MAP carries every field the shelves read', () => {
    const m = r.buildReleaseMap(
      { title: ' Abyss ', artist: 'V3XV0ID', genre: 'Electronic', description: '', ai: true },
      [{ origin: `${tx(1)}_0`, title: 'One', contentType: 'audio/mpeg' }],
    );
    expect(m).toMatchObject({
      app: 'bwallet-media',
      type: 'release',
      name: 'Abyss',
      artist: 'V3XV0ID',
      genre: 'Electronic',
      ai: 'true',
      cover: 'self',
    });
    expect(JSON.parse(m.tracks)).toEqual([{ o: `${tx(1)}_0`, t: 'One', k: 'audio/mpeg' }]);
    expect(m.description).toBeUndefined();
  });
  test('ai defaults to false in the tag', () => {
    const m = r.buildReleaseMap({ title: 'A', artist: 'B', genre: '', description: '', ai: false }, []);
    expect(m.ai).toBe('false');
    expect(m.genre).toBeUndefined();
  });
  test('track MAP', () => {
    expect(r.buildTrackMap({ title: 'One', artist: 'X' })).toEqual({
      app: 'bwallet-media',
      type: 'track',
      name: 'One',
      artist: 'X',
    });
  });
  test('validation', () => {
    const f = { title: 'A', artist: 'B', genre: '', description: '', ai: false };
    expect(r.validateRelease(f, 1, false)).toBe('Choose a square cover.');
    expect(r.validateRelease(f, 0, true)).toContain('audio or video');
    expect(r.validateRelease({ ...f, artist: ' ' }, 1, true)).toBe('Add the artist.');
    expect(r.validateRelease(f, 1, true)).toBeNull();
  });
});

describe('release feed', () => {
  test('feed URL searches the bwallet-media release tag', () => {
    const q = decodeURIComponent(r.feedUrl(0).split('q=')[1].split('&')[0]);
    expect(JSON.parse(atob(q))).toEqual({ map: { app: 'bwallet-media', type: 'release' } });
  });
  test('parses tagged releases with raster covers and safe tracks', () => {
    const out = r.parseFeed([row(1, { ai: 'true' })]);
    expect(out).toHaveLength(1);
    expect(out[0].ai).toBe(true);
    expect(out[0].tracks[0].kind).toBe('music');
    expect(out[0].coverUrl).toContain(`${tx(1)}_0`);
  });
  test('drops SVG/HTML covers, other apps, and releases with no safe track', () => {
    expect(r.parseFeed([row(1, { cover: 'image/svg+xml' })])).toEqual([]);
    expect(r.parseFeed([row(2, { cover: 'text/html' })])).toEqual([]);
    expect(r.parseFeed([row(3, { app: 'bpics' })])).toEqual([]);
    expect(r.parseFeed([row(4, { tracks: tracks('text/html') })])).toEqual([]);
    expect(r.parseFeed([row(5, { tracks: 'not json' })])).toEqual([]);
    expect(r.parseFeed('nope')).toEqual([]);
  });
  test('video tracks are video', () => {
    expect(r.parseFeed([row(1, { tracks: tracks('video/mp4') })])[0].tracks[0].kind).toBe('video');
  });
  test('newest first, unmined on top, no duplicates', () => {
    const list = r.parseFeed([
      row(1, { height: 100 }),
      row(2, { height: 0 }),
      row(3, { height: 200 }),
      row(1, { height: 100 }),
    ]);
    expect(r.visibleReleases(list).map((x) => x.title)).toEqual(['Album 2', 'Album 3', 'Album 1']);
  });
  test('moveItem reorders and ignores out-of-range moves', () => {
    expect(r.moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(r.moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });
});

describe('repeat guard for a release', () => {
  test('the same track inscription is refused a second time', async () => {
    const g = new RepeatGuard();
    const args = {
      outputs: [{ lockingScript: '0063036f7264' + 'ab'.repeat(50), satoshis: 1, outputDescription: 'x' }],
    };
    const fp = await requestFingerprint(args);
    expect(g.check(fp)).toBeNull();
    g.record(fp, { txid: 't' });
    expect(g.check(fp)?.txid).toBe('t');
  });
});
