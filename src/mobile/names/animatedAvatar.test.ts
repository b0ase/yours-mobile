import { describe, expect, it } from 'bun:test';
import {
  ANIMATED_AVATAR_MAX_BYTES,
  bitsignStillUrl,
  checkAnimatedAvatar,
  dataUrlMime,
  mayBeAnimated,
  shouldAnimate,
  sniffImage,
} from './animatedAvatar';
import { preUploadCheck, uploadErrorMessage, AVATAR_UPLOADS_COMING } from './avatarUpload';

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

// Minimal GIF: header, 2×2 screen, no global table, then N image descriptors with an empty LZW stream.
const gif = (frames: number) =>
  bytes(
    'GIF89a',
    [2, 0, 2, 0, 0, 0, 0],
    ...Array.from({ length: frames }, () => [0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, 2, 1, 0, 0]),
    [0x3b],
  );
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, len = 0) => [
  ...be32(len),
  ...[...type].map((c) => c.charCodeAt(0)),
  ...new Array(len + 4).fill(0),
];
const png = (animated: boolean) =>
  Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...[...'IHDR'].map((c) => c.charCodeAt(0)),
    ...be32(300),
    ...be32(200),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...(animated ? chunk('acTL', 8) : []),
    ...chunk('IDAT', 1),
  ]);
const webpX = (animated: boolean, w = 64, h = 32) =>
  bytes(
    'RIFF',
    [0, 0, 0, 0],
    'WEBP',
    'VP8X',
    [10, 0, 0, 0],
    [animated ? 0x02 : 0, 0, 0, 0],
    [(w - 1) & 255, ((w - 1) >> 8) & 255, 0, (h - 1) & 255, ((h - 1) >> 8) & 255, 0],
  );

describe('sniffImage', () => {
  it('tells a moving GIF from a still one', () => {
    expect(sniffImage(gif(1))).toMatchObject({ kind: 'gif', animated: false, width: 2, height: 2 });
    expect(sniffImage(gif(3))).toMatchObject({ kind: 'gif', mime: 'image/gif', animated: true });
  });
  it('spots APNG by acTL before IDAT', () => {
    expect(sniffImage(png(false))).toMatchObject({ kind: 'png', animated: false, width: 300, height: 200 });
    expect(sniffImage(png(true))).toMatchObject({ kind: 'png', animated: true });
  });
  it('reads animated WebP from VP8X', () => {
    expect(sniffImage(webpX(true))).toMatchObject({ kind: 'webp', animated: true, width: 64, height: 32 });
    expect(sniffImage(webpX(false))).toMatchObject({ animated: false });
  });
  it('JPEG and junk never animate', () => {
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0], 'xxxxxxxxxx'))).toMatchObject({ kind: 'jpeg', animated: false });
    expect(sniffImage(bytes('hello world!!'))).toMatchObject({ kind: 'unknown', animated: false });
  });
});

describe('checkAnimatedAvatar', () => {
  it('keeps small ones', () => {
    expect(checkAnimatedAvatar({ mime: 'image/gif', width: 512, height: 300 }, 1000)).toEqual({
      ok: true,
      mime: 'image/gif',
    });
  });
  it('refuses over 2 MB or over 512 px with a message', () => {
    const big = checkAnimatedAvatar({ mime: 'image/gif', width: 100, height: 100 }, ANIMATED_AVATAR_MAX_BYTES + 1);
    expect(big.ok).toBe(false);
    expect(!big.ok && big.reason).toMatch(/up to 2 MB/);
    const wide = checkAnimatedAvatar({ mime: 'image/webp', width: 513, height: 10 }, 10);
    expect(!wide.ok && wide.reason).toMatch(/512×512/);
  });
});

describe('playback policy', () => {
  it('reduced motion is always still', () => {
    expect(shouldAnimate('full', true)).toBe(false);
    expect(shouldAnimate('list', true, true)).toBe(false);
  });
  it('full places animate; lists only while active', () => {
    expect(shouldAnimate('full', false)).toBe(true);
    expect(shouldAnimate('list', false)).toBe(false);
    expect(shouldAnimate('list', false, true)).toBe(true);
  });
  it('only possibly-moving pictures get a poster', () => {
    expect(mayBeAnimated('data:image/gif;base64,AAA')).toBe(true);
    expect(mayBeAnimated('data:image/jpeg;base64,AAA')).toBe(false);
    expect(mayBeAnimated('data:image/svg+xml;charset=utf-8,x')).toBe(false);
    expect(mayBeAnimated('https://x.com/a.gif?x=1')).toBe(true);
    expect(mayBeAnimated('https://x.com/a.jpg')).toBe(false);
    expect(mayBeAnimated(`https://ordfs.network/content/${'a'.repeat(64)}_0`)).toBe(true);
    expect(mayBeAnimated('')).toBe(false);
  });
  it('dataUrlMime', () => {
    expect(dataUrlMime('data:image/GIF;base64,xx')).toBe('image/gif');
    expect(dataUrlMime('https://x')).toBe('');
  });
});

describe('avatar upload helpers', () => {
  const toDataUrl = (b: Uint8Array, mime: string) => `data:${mime};base64,${btoa(String.fromCharCode(...b))}`;
  it('checks type and size on the device first', () => {
    expect(preUploadCheck(toDataUrl(gif(2), 'image/gif'))).toBe('');
    expect(preUploadCheck(toDataUrl(bytes('hello world!!'), 'image/gif'))).toMatch(/isn’t supported/);
    expect(preUploadCheck(toDataUrl(webpX(true, 600, 10), 'image/webp'))).toMatch(/512×512/);
  });
  it('503 means not available yet; otherwise the server text', () => {
    expect(uploadErrorMessage(503, 'x')).toEqual({ unavailable: true, message: AVATAR_UPLOADS_COMING });
    expect(uploadErrorMessage(400, 'Too large')).toEqual({ unavailable: false, message: 'Too large' });
    expect(uploadErrorMessage(404, 'Set up your identity first.').message).toBe('Set up your identity first.');
  });
});

describe('bitsignStillUrl', () => {
  it('bit-sign avatars and covers get ?still=1', () => {
    expect(bitsignStillUrl('https://www.bchatx.com/api/public/avatar/abc.gif')).toBe(
      'https://www.bchatx.com/api/public/avatar/abc.gif?still=1',
    );
    expect(bitsignStillUrl('https://bit-sign.online/api/public/cover/x?v=2')).toBe(
      'https://bit-sign.online/api/public/cover/x?v=2&still=1',
    );
    expect(mayBeAnimated('https://www.bchatx.com/api/public/avatar/abc')).toBe(true);
  });
  it('other hosts and paths keep the canvas path', () => {
    expect(bitsignStillUrl('https://example.com/api/public/avatar/abc.gif')).toBeNull();
    expect(bitsignStillUrl('http://www.bitcoinchat.online/api/public/avatar/a.gif')).toBeNull();
    expect(bitsignStillUrl('https://www.bchatx.com/api/public/profile/alice')).toBeNull();
    expect(bitsignStillUrl('data:image/gif;base64,AAAA')).toBeNull();
    expect(bitsignStillUrl(null)).toBeNull();
  });
});
