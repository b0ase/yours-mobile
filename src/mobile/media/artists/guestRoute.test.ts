import { describe, expect, test } from 'bun:test';
import { guestMusicRoute } from './guestRoute';

describe('guestMusicRoute', () => {
  test('artist and album pages are public', () => {
    expect(guestMusicRoute('/bmusic/artists')).toBe('/m/media/artists');
    expect(guestMusicRoute('/bmusic/artists/vexvoid')).toBe('/m/media/artists/vexvoid');
    expect(guestMusicRoute('/bmusic/artist/vexvoid/album/echoes-in-the-abyss')).toBe('/m/media/album/first-12');
  });
  test('nothing else is', () => {
    for (const p of [
      '/',
      '/wallet',
      '/bmusic',
      '/lock/subscriptions',
      '/settings',
      '/bmusic/artist/x/album/nope',
      '/m/media/artists/../../settings',
    ])
      expect(guestMusicRoute(p)).toBeNull();
  });
});
