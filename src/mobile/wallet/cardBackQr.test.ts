import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import * as qr from 'qrcode';
import sharp from 'sharp';
import { cardArtQrSvg, cardPaymail, svgDataUri } from './cardBackQr';

/**
 * The back of the wallet card shows the account's bAvatar art QR (owner, 11 Oct 2026). It has to scan.
 * Two checks on the rendered pixels:
 *  1. every module's centre reads light or dark exactly as the QR says (scanners sample centres), and
 *  2. ZXing (the decoder behind most Android scanners) reads it back at several sizes, down to the
 *     pixels the card gives it on a phone. The card uses CARD_QR (bigger dots, paler wash, no gold pip):
 *     with the bChatX defaults ZXing read 0 of 48; with these, 48 of 48.
 */

const NAMES = [
  'vexvoid',
  'testy',
  'b0asex',
  'b0asey',
  'a-longer_name.x',
  'nova',
  'sam',
  'kai',
  'mira',
  'otto',
  'jun',
  'alice',
];
/** A valid-looking compressed key per name (the art only needs 33 bytes of hex to seed from). */
const keyFor = (name: string) => '02' + createHash('sha256').update(name).digest('hex');

async function zxingDecode(svg: string, px: number): Promise<string | null> {
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(px, px)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const lum = new Uint8ClampedArray(info.width * info.height);
  for (let i = 0; i < lum.length; i++)
    lum[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
  try {
    return new QRCodeReader()
      .decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, info.width, info.height))))
      .getText();
  } catch {
    return null;
  }
}

/**
 * Luminance at each data module's centre of a 512px render, against the QR's own matrix. The three
 * finder squares are drawn as solid rounded shapes with a small gold pip (decoders find them by their
 * ring ratios, not by module sampling), so they're left out here and covered by the decode below.
 */
async function moduleMismatches(svg: string, text: string): Promise<number> {
  const S = 512;
  const m = qr.create(text, { errorCorrectionLevel: 'H' }).modules;
  const n = m.size,
    cell = S / (n + 6),
    off = 3 * cell;
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(S, S)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const finder = (x: number, y: number) => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
  let bad = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (finder(x, y)) continue;
      const px = Math.floor(off + (x + 0.5) * cell),
        py = Math.floor(off + (y + 0.5) * cell);
      const i = (py * info.width + px) * 4;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (lum < 128 !== !!m.get(y, x)) bad++;
    }
  return bad;
}

describe('card back art QR', () => {
  test('paymail is normalised; bad input gives no art QR', () => {
    expect(cardPaymail('VexVoid')).toBe('vexvoid@bwalletx.com');
    expect(cardPaymail('$testy')).toBe('testy@bwalletx.com');
    expect(cardPaymail('b0asex@bchatx.com')).toBe('b0asex@bchatx.com');
    expect(cardPaymail('')).toBe('');
    expect(cardPaymail('no spaces@x')).toBe('');
    expect(cardArtQrSvg('not-a-key', 'testy')).toBe('');
    expect(cardArtQrSvg(keyFor('testy'), '')).toBe('');
    expect(svgDataUri('')).toBe('');
  });

  for (const name of NAMES) {
    test(`${name}: every module reads right, and ZXing reads its paymail at 512, 324, 240 and 180px`, async () => {
      const svg = cardArtQrSvg(keyFor(name), name, 512);
      expect(svg.startsWith('<svg')).toBe(true);
      expect(await moduleMismatches(svg, cardPaymail(name))).toBe(0);
      for (const px of [512, 324, 240, 180]) expect(await zxingDecode(svg, px)).toBe(cardPaymail(name));
    });
  }

  test('the art QR is the same every time for the same key (no randomness)', () => {
    expect(cardArtQrSvg(keyFor('testy'), 'testy')).toBe(cardArtQrSvg(keyFor('testy'), 'testy'));
  });

  test('the card uses the art QR and keeps the plain receive QR as the fallback', () => {
    const src = readFileSync(new URL('./WalletCard.tsx', import.meta.url), 'utf8');
    expect(src).toContain('cardArtQrSvg(account?.pubKeys?.identityPubKey, names.paymail');
    expect(src).toContain('if (!flipped || !receiveAddress || artQr) return;');
    expect(src).toContain("bw-wcard-qr${artQr ? ' is-art' : ''}");
  });
});
