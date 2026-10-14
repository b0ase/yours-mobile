import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { bavatarQrSvg, bitcoinUri, BAVATAR_QR_STYLES } from './bavatarQr';

const K = '02' + 'ab'.repeat(32);
const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

describe('scannable bAvatar (bavatarQr)', () => {
  test('bitcoinUri adds the scheme once', () => {
    expect(bitcoinUri(ADDR)).toBe('bitcoin:' + ADDR);
    expect(bitcoinUri('bitcoin:' + ADDR)).toBe('bitcoin:' + ADDR);
  });
  test('deterministic per key/address/style; styles differ', () => {
    expect(bavatarQrSvg(K, ADDR)).toBe(bavatarQrSvg(K, ADDR));
    expect(bavatarQrSvg(K, ADDR, { style: 'dots' })).not.toBe(bavatarQrSvg(K, ADDR, { style: 'seal' }));
    expect(bavatarQrSvg(K, ADDR)).not.toBe(bavatarQrSvg('03' + 'cd'.repeat(32), ADDR));
  });
  test('valid SVG at the requested size, circle clip optional', () => {
    const s = bavatarQrSvg(K, ADDR, { size: 300, circle: true });
    expect(s.startsWith('<svg')).toBe(true);
    expect(s).toContain('width="300"');
    expect(s).toContain('clip-path=');
    expect(bavatarQrSvg(K, ADDR)).not.toContain('clip-path=');
  });
  for (const style of BAVATAR_QR_STYLES)
    test(`${style}: circle-cropped 512px PNG decodes to bitcoin:<address>`, async () => {
      const svg = bavatarQrSvg(K, ADDR, { style, size: 512, circle: true });
      const { data, info } = await sharp(Buffer.from(svg))
        .flatten({ background: '#1a1a1a' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe('bitcoin:' + ADDR);
    });
});
