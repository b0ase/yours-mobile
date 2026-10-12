import { describe, expect, mock, test } from 'bun:test';

mock.module('./vexvoid-echoes-in-the-abyss.mp3', () => ({ default: '/assets/echoes.mp3' }));
mock.module('./vexvoid-cover.jpg', () => ({ default: '/assets/cover.jpg' }));
const { FEATURED_TRACKS, featuredQueue } = await import('./featured');

describe('featured tracks', () => {
  test('one free VexVoid track, kept apart from wallet items', () => {
    expect(FEATURED_TRACKS).toHaveLength(1);
    expect(FEATURED_TRACKS[0].id.startsWith('free:')).toBe(true);
  });
  test('its queue is just that track, titled with the artist', () => {
    const q = featuredQueue(FEATURED_TRACKS[0]);
    expect(q).toHaveLength(1);
    expect(q[0].title).toBe('Echoes in the Abyss · V3XV0ID');
    expect(q[0].url).toBe('/assets/echoes.mp3');
  });
});

describe('the album', () => {
  test('one album led by the free headline track, with the VexVoid cover', async () => {
    const { HEADLINE_ALBUM } = await import('./featured');
    expect(HEADLINE_ALBUM.title).toBe('Echoes in the Abyss');
    expect(HEADLINE_ALBUM.headline).toBe(FEATURED_TRACKS[0]);
    expect(HEADLINE_ALBUM.cover).toBe('/assets/cover.jpg');
  });
});
