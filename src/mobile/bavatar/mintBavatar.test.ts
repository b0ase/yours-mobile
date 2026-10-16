import { describe, expect, test } from 'bun:test';
import type { BavatarMine } from '../chat/api';
import {
  MAX_BAVATAR_BYTES,
  bavatarLabel,
  bavatarMintSvg,
  bavatarNumber,
  mintOffer,
  shouldSponsor,
} from './mintBavatar';

const KEY = '02' + 'ab'.repeat(32);
const mine = (o: Partial<BavatarMine> = {}): BavatarMine => ({
  handle: 'alice',
  number: 7,
  founding: true,
  edition: 1000,
  minted: null,
  sponsored: false,
  ...o,
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

  test('svg carries the art, the pay QR, handle, number and the founding line', () => {
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
    expect(mintOffer(mine({ minted: { txid: 'a'.repeat(64), outpoint: 'x_0' } }))).toEqual({
      kind: 'minted',
      txid: 'a'.repeat(64),
    });
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

// The minted card is two-sided: a static render shows the pure art front; the back Art QR decodes.
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { jsqr, rasterise, zbar, zxing } from './flipQr.testkit';

/** The back side as the animation shows it (scales swapped, animation removed). */
const backSide = (svg: string) =>
  svg
    .replace('<g class="bv-f"><g>', '<g class="bv-f"><g transform="scale(0 1)">')
    .replace('<g class="bv-b"><g transform="scale(0 1)">', '<g class="bv-b"><g>')
    .replace(/<animateTransform[^>]*\/>/g, '');
const square = async (svg: string) =>
  (await sharp(Buffer.from(svg)).extract({ left: 0, top: 0, width: 512, height: 512 }).png().toBuffer()).toString(
    'base64',
  );

describe('two-sided mint', () => {
  // One test per name: four renders + decodes in one test sat near the 5s default and timed out under load.
  for (const name of ['b0asex', 'vexvoid', 'a-longer_name.x', 'nova']) {
    test(`front art by default, back Art QR of the paymail, public data only, under the cap: ${name}`, async () => {
      const key = '02' + createHash('sha256').update(name).digest('hex');
      const svg = bavatarMintSvg(key, name, 12);
      expect(new TextEncoder().encode(svg).length).toBeLessThan(MAX_BAVATAR_BYTES);
      expect(svg).toContain('aria-label="Pay code"');
      expect(svg).toContain('animateTransform');
      expect(svg).not.toContain(key);
      expect(/[xt]prv|[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/.test(svg)).toBe(false);
      const pm = `${name}@bwalletx.com`;
      const back = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><image href="data:image/png;base64,${await square(backSide(svg))}" width="512" height="512"/></svg>`;
      for (const px of [512, 240]) {
        const img = await rasterise(back, px);
        expect(zxing(img) ?? jsqr(img)).toBe(pm);
        const z = await zbar(back, px);
        if (z !== undefined) expect(z).toBe(pm);
      }
    });
  }
});
