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
    expect(svg).toContain('alice@bwalletx.com');
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

// The minted card is two-sided: a static render shows the pure art front; the back QR is inside and decodes.
import { createHash } from 'node:crypto';
import { decodeSvg } from './flipQr.testkit';
import { flipBackSvg } from './flipQr';

describe('two-sided mint', () => {
  test('front art by default, back QR of the paymail, public data only, under the cap', async () => {
    for (const name of ['b0asex', 'vexvoid', 'a-longer_name.x', 'nova']) {
      const key = '02' + createHash('sha256').update(name).digest('hex');
      const svg = bavatarMintSvg(key, name, 12);
      expect(new TextEncoder().encode(svg).length).toBeLessThan(MAX_BAVATAR_BYTES);
      expect(svg).toContain('aria-label="bAvatar"');
      expect(svg).toContain('aria-label="Pay code"');
      expect(svg).toContain('animateTransform');
      // The identity key is public, but the art never embeds it verbatim; no other hex/secret either.
      expect(svg).not.toContain(key);
      const pm = `${name}@bwalletx.com`;
      expect(await decodeSvg(flipBackSvg(pm, { size: 512, caption: pm }), 320)).toBe(pm);
    }
  });
});
