import { describe, expect, test } from 'bun:test';
import type { BavatarMine } from '../chat/api';
import {
  BAVATAR_FEE_SATS,
  MAX_BAVATAR_BYTES,
  bavatarArt,
  loadPendingBavatar,
  mintBavatar,
  recoverPendingBavatar,
  savePendingBavatar,
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

  test("offer: free only for a founder's FIRST mint; paid after #1,000 and for every replacement", () => {
    const minted = { txid: 'a'.repeat(64), outpoint: 'x_0' };
    expect(mintOffer(mine({ minted }))).toEqual({ kind: 'current' });
    expect(mintOffer(mine({ minted: { ...minted, variant: 3 } }), 3)).toEqual({ kind: 'current' });
    expect(mintOffer(mine())).toEqual({ kind: 'free' });
    expect(mintOffer(mine(), 5)).toEqual({ kind: 'free' }); // first mint of any design
    expect(mintOffer(mine({ number: 1001, founding: false }))).toEqual({ kind: 'paid', sats: BAVATAR_FEE_SATS });
    // A founder replacing their bAvatar pays: the sponsor covers one mint per account.
    expect(mintOffer(mine({ minted }), 1)).toEqual({ kind: 'paid', sats: BAVATAR_FEE_SATS });
    expect(mintOffer(mine({ minted: null, mints: 1 }), 1)).toEqual({ kind: 'paid', sats: BAVATAR_FEE_SATS });
  });

  test('the design number is in the card for #n, and #0 keeps the card unchanged', () => {
    expect(bavatarMintSvg(KEY, 'alice', 7, 0)).toBe(bavatarMintSvg(KEY, 'alice', 7));
    expect(bavatarMintSvg(KEY, 'alice', 7)).not.toContain('data-bavatar-design');
    const v = bavatarMintSvg(KEY, 'alice', 7, 4);
    expect(v).toContain('data-bavatar-design="4"');
    expect(v).not.toBe(bavatarMintSvg(KEY, 'alice', 7));
    expect(bavatarMintSvg(KEY, 'alice', 7, -1)).toBe('');
  });

  test('save before commit: a spent mint is saved, recovered by re-recording, never re-minted', async () => {
    const m = new Map<string, string>();
    const kv = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
    const txid = 'b'.repeat(64);
    savePendingBavatar({ identityKey: KEY, txid, variant: 2, at: 1 }, kv);
    expect(loadPendingBavatar(KEY, kv)?.variant).toBe(2);
    const calls: unknown[][] = [];
    // Server down: the record stays saved.
    await expect(
      recoverPendingBavatar(
        {
          recordBavatarMint: async () => {
            throw new Error('offline');
          },
        },
        KEY,
        kv,
      ),
    ).rejects.toThrow('offline');
    expect(loadPendingBavatar(KEY, kv)).not.toBeNull();
    const client = {
      recordBavatarMint: async (...a: unknown[]) => {
        calls.push(a);
        return { ok: true };
      },
    };
    expect(await recoverPendingBavatar(client, KEY, kv)).toBe(txid);
    expect(calls).toEqual([[txid, 2, bavatarArt(KEY, 2)]]);
    expect(loadPendingBavatar(KEY, kv)).toBeNull();
    expect(await recoverPendingBavatar(client, KEY, kv)).toBeNull();

    // While a record is waiting, mintBavatar records it and refuses to spend again.
    savePendingBavatar({ identityKey: KEY, txid, variant: 2, at: 1 }, kv);
    const ctx = {} as Parameters<typeof mintBavatar>[0];
    await expect(
      mintBavatar(ctx, { identityKey: KEY, payAddress: '', mine: mine(), variant: 3, client: client as never, kv }),
    ).rejects.toThrow(/recorded/);
    expect(calls.length).toBe(2);
    expect(loadPendingBavatar(KEY, kv)).toBeNull();
  });

  test('minting the design you already have spends nothing', async () => {
    const ctx = {} as Parameters<typeof mintBavatar>[0];
    const minted = { txid: 'c'.repeat(64), outpoint: 'x_0', variant: 6 };
    expect(await mintBavatar(ctx, { identityKey: KEY, payAddress: '', mine: mine({ minted }), variant: 6 })).toBe(
      minted.txid,
    );
  });

  test('sponsor only an unsponsored founder that ran out of funds', () => {
    expect(shouldSponsor(mine(), 'Insufficient funds')).toBe(true);
    expect(shouldSponsor(mine(), undefined)).toBe(false);
    expect(shouldSponsor(mine({ sponsored: true }), 'Insufficient funds')).toBe(false);
    expect(shouldSponsor(mine({ number: 1001, founding: false }), 'Insufficient funds')).toBe(false);
    // Never for a replacement, even if the earlier mint was never sponsored.
    expect(shouldSponsor(mine({ minted: { txid: 'a'.repeat(64), outpoint: 'x_0' } }), 'Insufficient funds')).toBe(
      false,
    );
    expect(shouldSponsor(mine({ mints: 2 }), 'Insufficient funds')).toBe(false);
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
