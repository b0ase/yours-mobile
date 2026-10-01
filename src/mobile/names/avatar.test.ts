import { describe, expect, test } from 'bun:test';
import { dataUrlBytes, fitWithin, isDefaultAvatar, paymailAvatar, pickAvatar, resolveAvatarUrl } from './avatar';
import { BWALLET_MARK_ICON } from './personalToken';

const TX = 'c'.repeat(64);

describe('avatar', () => {
  test('defaults mean "no avatar" (gold b)', () => {
    expect(isDefaultAvatar('')).toBe(true);
    expect(isDefaultAvatar('https://i.ibb.co/zGcthBv/yours-org-light.png')).toBe(true);
    expect(isDefaultAvatar('/assets/bwallet-avatar.png')).toBe(true);
    expect(isDefaultAvatar(BWALLET_MARK_ICON)).toBe(true);
    expect(isDefaultAvatar('data:image/jpeg;base64,AAAA')).toBe(false);
  });
  test('pick order: local photo, BAP image, social avatar, account icon, else default', () => {
    expect(pickAvatar({ local: 'data:image/jpeg;base64,L', profileImage: 'https://p' })).toBe(
      'data:image/jpeg;base64,L',
    );
    expect(pickAvatar({ profileImage: '1sat://x', socialAvatar: 'https://s' })).toBe('1sat://x');
    expect(pickAvatar({ socialAvatar: 'https://i.ibb.co/zGcthBv/yours-org-light.png', accountIcon: 'https://a' })).toBe(
      'https://a',
    );
    expect(pickAvatar({})).toBe('');
  });
  test('1sat:// resolves to ORDFS content', () => {
    expect(resolveAvatarUrl(`1sat://${TX}.0`, 'https://ordfs.network/content/')).toBe(
      `https://ordfs.network/content/${TX}_0`,
    );
    expect(resolveAvatarUrl('https://x/y.png')).toBe('https://x/y.png');
  });
  test('paymail profile only serves public https URLs (≤512)', () => {
    expect(paymailAvatar('https://ordfs.network/content/abc_0')).toBe('https://ordfs.network/content/abc_0');
    expect(paymailAvatar('data:image/jpeg;base64,AAAA')).toBe('');
    expect(paymailAvatar(`https://x/${'a'.repeat(600)}`)).toBe('');
    expect(paymailAvatar(undefined)).toBe('');
  });
  test('resize fits within 256 without upscaling', () => {
    expect(fitWithin(1024, 512)).toEqual({ w: 256, h: 128 });
    expect(fitWithin(100, 50)).toEqual({ w: 100, h: 50 });
    expect(fitWithin(0, 10)).toEqual({ w: 0, h: 0 });
  });
  test('data URL byte size', () => {
    expect(dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('data:image/jpeg;base64,AA==')).toBe(1);
  });
});
