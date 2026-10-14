import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { bavatarArtCodeSvg, ART_CODE_VARIANTS } from './bavatarArtCode';

const K = '02' + 'ab'.repeat(32);
const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const MAX_BAVATAR_BYTES = 40_000; // mintBavatar.ts (not imported: it pulls the wallet stack in)

describe('bAvatar art code (round 2)', () => {
  test('deterministic; variants and keys differ', () => {
    expect(bavatarArtCodeSvg(K, ADDR)).toBe(bavatarArtCodeSvg(K, ADDR));
    expect(bavatarArtCodeSvg(K, ADDR, { variant: 'bold' })).not.toBe(bavatarArtCodeSvg(K, ADDR, { variant: 'safe' }));
    expect(bavatarArtCodeSvg(K, ADDR)).not.toBe(bavatarArtCodeSvg('03' + 'cd'.repeat(32), ADDR));
  });
  for (const variant of ART_CODE_VARIANTS) {
    test(`${variant}: under MAX_BAVATAR_BYTES`, () => {
      const svg = bavatarArtCodeSvg(K, ADDR, { variant, size: 1024, logo: true, circle: true });
      expect(new TextEncoder().encode(svg).length).toBeLessThan(MAX_BAVATAR_BYTES);
    });
    test(`${variant}: circle-cropped 512px PNG decodes to bitcoin:<address>`, async () => {
      const svg = bavatarArtCodeSvg(K, ADDR, { variant, size: 512, circle: true, logo: true });
      const { data, info } = await sharp(Buffer.from(svg))
        .flatten({ background: '#1a1a1a' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: 'dontInvert' })?.data).toBe(
        'bitcoin:' + ADDR,
      );
    });
  }
});
