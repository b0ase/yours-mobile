import { describe, expect, test } from 'bun:test';
import { albumView } from './album';

const t = (n: number, title: string) => ({ n, trackId: `t${n}`, title, segments: 10, durations: [], seconds: 10 });
const fb = { title: 'Echoes in the Abyss', artist: 'VexVoid', cover: '/c.jpg', headlineTitle: 'Echoes in the Abyss' };

describe('albumView', () => {
  test('placeholder FIRST 12 title and no cover fall back to the album', () => {
    const v = albumView({ title: 'FIRST 12', tracks: [t(1, 'A'), t(2, 'B')] }, fb);
    expect(v.title).toBe('Echoes in the Abyss');
    expect(v.cover).toBe('/c.jpg');
    expect(v.paid.map((p) => p.index)).toEqual([0, 1]);
  });
  test('the headline is not listed twice; indices still point into the manifest', () => {
    const v = albumView({ title: 'FIRST 12', tracks: [t(1, 'A'), t(2, 'echoes in the abyss '), t(3, 'C')] }, fb);
    expect(v.paid.map((p) => p.track.title)).toEqual(['A', 'C']);
    expect(v.paid.map((p) => p.index)).toEqual([0, 2]);
  });
  test('manifest title, artist and relative cover win; headline trackId is not listed twice', () => {
    const v = albumView(
      { title: 'Deep Water', artist: 'V', cover: 'cover.jpg', headline: 't1', tracks: [t(1, 'Other'), t(2, 'B')] },
      fb,
      'https://x.test/streams/a/manifest.json',
    );
    expect(v.title).toBe('Deep Water');
    expect(v.artist).toBe('V');
    expect(v.cover).toBe('https://x.test/streams/a/cover.jpg');
    expect(v.paid.map((p) => p.index)).toEqual([1]);
  });
});
