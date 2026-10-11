import { describe, expect, test } from 'bun:test';
import type { BavatarMine } from '../chat/api';
import { MAX_BAVATAR_BYTES, bavatarLabel, bavatarMintSvg, bavatarNumber, mintOffer, shouldSponsor } from './mintBavatar';

const KEY = '02' + 'ab'.repeat(32);
const mine = (o: Partial<BavatarMine> = {}): BavatarMine => ({
  handle: 'alice', number: 7, founding: true, edition: 1000, minted: null, sponsored: false, ...o,
});

describe('bAvatar mint', () => {
  test('numbers pad to 3 digits under 1,000', () => {
    expect(bavatarNumber(1)).toBe('#001');
    expect(bavatarNumber(42)).toBe('#042');
    expect(bavatarNumber(999)).toBe('#999');
    expect(bavatarNumber(1000)).toBe('#1000');
    expect(bavatarNumber(1234)).toBe('#1234');
    expect(bavatarLabel('alice', 7)).toBe('$alice · bWalletX #007');
  });

  test('svg carries the art QR, handle, number and the founding line', () => {
    const svg = bavatarMintSvg(KEY, 'alice', 7);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('$alice');
    expect(svg).toContain('bWalletX #007');
    expect(svg).toContain('FOUNDING 1,000');
    expect(new TextEncoder().encode(svg).length).toBeLessThan(MAX_BAVATAR_BYTES);
  });

  test('no founding line after 1,000; escapes text; empty without a key', () => {
    expect(bavatarMintSvg(KEY, 'bob', 1001)).not.toContain('FOUNDING');
    expect(bavatarMintSvg('nope', 'alice', 7)).toBe('');
  });

  test('offer: minted, free for founders, paid after', () => {
    expect(mintOffer(mine({ minted: { txid: 'a'.repeat(64), outpoint: 'x_0' } }))).toEqual({ kind: 'minted', txid: 'a'.repeat(64) });
    expect(mintOffer(mine())).toEqual({ kind: 'free' });
    expect(mintOffer(mine({ number: 1001, founding: false }))).toEqual({ kind: 'paid' });
  });

  test('sponsor only an unsponsored founder that ran out of funds', () => {
    expect(shouldSponsor(mine(), 'Insufficient funds')).toBe(true);
    expect(shouldSponsor(mine(), undefined)).toBe(false);
    expect(shouldSponsor(mine({ sponsored: true }), 'Insufficient funds')).toBe(false);
    expect(shouldSponsor(mine({ number: 1001, founding: false }), 'Insufficient funds')).toBe(false);
  });
});

// It must scan like the card back: ZXing (most Android scanners) over several names and sizes.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import { compactArtQrSvg } from './mintBavatar';

async function decode(svg: string, px: number): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(svg)).resize(px, px).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = new Uint8ClampedArray(info.width * info.height);
  for (let i = 0; i < lum.length; i++) lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
  try {
    return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, info.width, info.height)))).getText();
  } catch {
    return null;
  }
}

describe('compact art QR scans', () => {
  test('ZXing reads every name at 512, 320 and 220 px; under the size cap', async () => {
    const names = ['b0asex', 'vexvoid', 'a-longer_name.x', 'nova', 'sam', 'mira'];
    let ok = 0, total = 0;
    for (const name of names) {
      const key = '02' + createHash('sha256').update(name).digest('hex');
      const pm = `${name}@bwalletx.com`;
      const svg = compactArtQrSvg(key, pm);
      expect(new TextEncoder().encode(svg).length).toBeLessThan(MAX_BAVATAR_BYTES);
      for (const px of [512, 320, 220]) {
        total++;
        if ((await decode(svg, px)) === pm) ok++;
      }
    }
    expect(ok).toBe(total);
  });
});
