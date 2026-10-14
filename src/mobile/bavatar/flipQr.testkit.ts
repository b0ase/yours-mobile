// Test-only helpers: rasterise an SVG with sharp and decode the QR with ZXing (most Android scanners) and jsQR.
import sharp from 'sharp';
import jsQR from 'jsqr';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';

export async function rasterise(svg: string, px: number) {
  const { data, info } = await sharp(Buffer.from(svg))
    .resize(px, px)
    .flatten({ background: '#ffffff' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

export function zxing(img: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  const lum = new Uint8ClampedArray(img.width * img.height);
  for (let i = 0; i < lum.length; i++)
    lum[i] = (img.data[i * 4] * 0.299 + img.data[i * 4 + 1] * 0.587 + img.data[i * 4 + 2] * 0.114) | 0;
  try {
    return new QRCodeReader()
      .decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, img.width, img.height))))
      .getText();
  } catch {
    return null;
  }
}

/**
 * jsQR must read it at `px`; ZXing, when it reads it at all (at `px` or a few pixels either side), must agree.
 * ZXing-js alone throws "Dimensions could be not found" on some matrices whatever the framing, stock `qrcode`
 * output included (~5% of random addresses; zbar and jsQR read those fine), so it is a cross-check here and
 * its overall hit rate is asserted separately in the tests.
 */
export async function decodeSvg(svg: string, px: number): Promise<string | null> {
  const img = await rasterise(svg, px);
  const b = jsQR(img.data, img.width, img.height)?.data ?? null;
  if (b === null) return null;
  for (const d of [0, 3, -3, 7]) {
    const a = zxing(d ? await rasterise(svg, px + d) : img);
    if (a !== null) return a === b ? a : null;
  }
  return b;
}

/** ZXing alone at `px` or a few pixels either side. */
export async function zxingSvg(svg: string, px: number): Promise<string | null> {
  for (const d of [0, 3, -3, 7]) {
    const a = zxing(await rasterise(svg, px + d));
    if (a !== null) return a;
  }
  return null;
}
