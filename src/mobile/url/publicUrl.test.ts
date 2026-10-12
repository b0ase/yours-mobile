import { describe, expect, test } from 'bun:test';
import { toPublic, toRouter } from './publicUrl';

describe('toPublic', () => {
  test('spaces and a permanent space', () => {
    expect(toPublic('/m/spaces', '')).toBe('/spaces');
    expect(toPublic('/m/spaces', '?space=bwallet-lounge')).toBe('/spaces/bwallet-lounge');
  });
  test('other tab pages lose the /m prefix, top routes stay', () => {
    expect(toPublic('/m/chat', '')).toBe('/chat');
    expect(toPublic('/m/lock/verify', '?tx=ab')).toBe('/lock/verify?tx=ab');
    expect(toPublic('/bsv-wallet', '')).toBe('/wallet');
    expect(toPublic('/settings', '')).toBe('/settings');
  });
  test('a bad slug is not put in the path', () => {
    expect(toPublic('/m/spaces', '?space=../x')).toBe('/spaces?space=..%2Fx');
  });
});

describe('toRouter', () => {
  test('round trips', () => {
    expect(toRouter('/spaces', '')).toBe('/m/spaces');
    expect(toRouter('/spaces/bwallet-lounge', '')).toBe('/m/spaces?space=bwallet-lounge');
    expect(toRouter('/chat/', '')).toBe('/m/chat');
    expect(toRouter('/settings', '')).toBe('/settings');
    expect(toRouter('/wallet', '')).toBe('/bsv-wallet');
    expect(toRouter('/bsv-wallet', '')).toBe('/bsv-wallet');
  });
  test('root and files keep the app start', () => {
    expect(toRouter('/', '')).toBeNull();
    expect(toRouter('/desktop.html', '')).toBeNull();
  });
  test('restore and set-up screens never reopen from the URL (reload loop)', () => {
    expect(toRouter('/restore-wallet', '')).toBeNull();
    expect(toRouter('/master-restore', '')).toBeNull();
    expect(toPublic('/restore-wallet', '')).toBe('/');
  });
});

describe('shareable album and artist paths', () => {
  test('album round trip', () => {
    expect(toRouter('/bmusic/artist/vexvoid/album/echoes-in-the-abyss', '')).toBe('/m/media/album/first-12');
    expect(toPublic('/m/media/album/first-12', '')).toBe('/bmusic/artist/vexvoid/album/echoes-in-the-abyss');
  });
  test('the old album path still opens', () => {
    expect(toRouter('/media/album/first-12', '')).toBe('/m/media/album/first-12');
    expect(toPublic('/m/media/album/other', '')).toBe('/bmusic/album/other');
  });
  test('artist page round trip', () => {
    expect(toRouter('/bmusic/artists/vexvoid', '')).toBe('/m/media/browse?artist=VexVoid');
    expect(toPublic('/m/media/browse', '?artist=VexVoid')).toBe('/bmusic/artists/vexvoid');
  });
  test('the store is /bmusic; old /media links still open it', () => {
    expect(toPublic('/m/media', '')).toBe('/bmusic');
    expect(toRouter('/bmusic', '')).toBe('/m/media');
    expect(toRouter('/media', '')).toBe('/m/media');
    expect(toRouter('/bmusic/artist/vexvoid', '')).toBe('/m/media/browse?artist=VexVoid');
    expect(toRouter('/bmusic/artists', '')).toBe('/m/media/browse');
    expect(toRouter('/media/artist/vexvoid/album/echoes-in-the-abyss', '')).toBe('/m/media/album/first-12');
  });
  test('unknown album falls back to Media', () => {
    expect(toRouter('/bmusic/artist/vexvoid/album/nope', '')).toBe('/m/media');
  });
});
