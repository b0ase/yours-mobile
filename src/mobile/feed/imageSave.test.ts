import { describe, expect, test } from 'bun:test';
import { imageFileName } from './imageSave';

describe('feed image file names', () => {
  test('on-chain images are named by outpoint', () => {
    expect(imageFileName('https://ordfs.network/abc_0', 'image/png', 'abc_0')).toBe('bwallet-abc_0.png');
  });
  test('web images use the last path part without its extension', () => {
    expect(imageFileName('https://x.com/media/My%20Pic.jpeg?x=1', 'image/jpeg', null)).toBe('bwallet-My-Pic.jpg');
  });
  test('unknown types and data URLs still get a safe name', () => {
    expect(imageFileName('data:image/webp;base64,AAA', 'application/octet-stream', null)).toBe('bwallet-image.jpg');
    expect(imageFileName('https://x.com/', 'image/webp; q=1', null)).toBe('bwallet-image.webp');
  });
});
