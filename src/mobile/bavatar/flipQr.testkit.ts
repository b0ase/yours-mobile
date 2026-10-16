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

export const jsqr = (img: { data: Uint8ClampedArray; width: number; height: number }) =>
  jsQR(img.data, img.width, img.height)?.data ?? null;

/** Probed once per process: spawning `zbarimg --version` before every decode doubled the subprocess count. */
let hasZbar: boolean | undefined;

/** zbar (zbarimg) when installed, else undefined (CI without it skips that decoder). */
export async function zbar(svg: string, px: number): Promise<string | null | undefined> {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  if (hasZbar === undefined) {
    try {
      execFileSync('zbarimg', ['--version'], { stdio: 'ignore' });
      hasZbar = true;
    } catch {
      hasZbar = false;
    }
  }
  if (!hasZbar) return undefined;
  const dir = mkdtempSync(join(tmpdir(), 'bflip-'));
  try {
    const file = join(dir, 'q.png');
    await sharp(Buffer.from(svg)).resize(px, px).flatten({ background: '#ffffff' }).png().toFile(file);
    const out = execFileSync('zbarimg', ['-q', '--raw', file], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
