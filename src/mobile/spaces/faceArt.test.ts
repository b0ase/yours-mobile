import { describe, expect, test } from 'bun:test';
import { faceArtLocal, faceArtUrl } from './faceArt';

describe('Space participant default picture (gold bAvatar)', () => {
  test('network art resolves the handle on bChatX, cleaned', () => {
    expect(faceArtUrl('$B0asex')).toBe('https://www.bitcoinchat.online/api/bavatar/b0asex.svg');
  });
  test('local fallback is an SVG bAvatar, stable per handle, never a letter', () => {
    const a = faceArtLocal('b0asex');
    expect(a.startsWith('data:image/svg+xml')).toBe(true);
    expect(faceArtLocal('$B0ASEX')).toBe(a);
    expect(faceArtLocal('testy')).not.toBe(a);
  });
});
