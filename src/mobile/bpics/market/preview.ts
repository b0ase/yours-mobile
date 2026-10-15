/**
 * The public preview of a photo for sale: at most PREVIEW_EDGE px on the long side, a tiled diagonal watermark,
 * JPEG. Browser only (canvas). The geometry is pure (previewSize, watermarkPositions) and unit-tested.
 */
import { PREVIEW_EDGE, PREVIEW_QUALITY, WATERMARK } from './listing';

export function previewSize(w: number, h: number, edge = PREVIEW_EDGE): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  const s = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Watermark anchor points: a staggered grid every `step` px, covering the whole image. */
export function watermarkPositions(w: number, h: number, step = 220): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = step / 2, row = 0; y < h + step; y += step, row++)
    for (let x = (row % 2 ? step / 2 : 0) - step / 2; x < w + step; x += step) out.push({ x, y });
  return out;
}

export async function makePreview(file: Blob): Promise<{ base64: string; w: number; h: number }> {
  const bmp = await createImageBitmap(file);
  const { w, h } = previewSize(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('This device cannot draw the preview.');
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  g.save();
  g.font = `600 ${Math.max(14, Math.round(w / 28))}px system-ui, sans-serif`;
  g.fillStyle = 'rgba(255,255,255,0.28)';
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = 1;
  g.textAlign = 'center';
  for (const p of watermarkPositions(w, h)) {
    g.save();
    g.translate(p.x, p.y);
    g.rotate(-Math.PI / 6);
    g.fillText(WATERMARK, 0, 0);
    g.strokeText(WATERMARK, 0, 0);
    g.restore();
  }
  g.restore();
  const url = canvas.toDataURL('image/jpeg', PREVIEW_QUALITY);
  return { base64: url.slice(url.indexOf(',') + 1), w, h };
}
