/**
 * Receipt art (owner 17 Oct 2026): a receipt carries the shop's graphics, so an NPG purchase prints NPG art.
 * A shop's `receiptArt` wins, then its logo; a theme's shop is the one that sells that pack (shops.ts). Sellers set
 * theirs in the sell flow (bstore.ts Draft.receiptArt, checked by artOk). The picture is shrunk to a small inline
 * data URI (artOk: PNG/JPEG/WebP, at most 60 KB) so the 1-sat inscription stays small; anything that fails falls back
 * to the plain gold card.
 */
import { SHOPS } from '../themeStore/shops';
import { ART_MAX_BYTES, artOk } from './receipt';

/** The picture URL for a theme pack's receipt: its shop's receipt art or logo. */
export const receiptArtUrl = (packId: string): string | null => {
  const shop = SHOPS.find((s) => s.themes.includes(packId));
  return shop ? (shop.receiptArt ?? shop.logo) : null;
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });

/** Shrink a picture to a square data URI within ART_MAX_BYTES (smaller sizes / JPEG until it fits), or null. */
export async function artDataUri(src: string | null, maxBytes = ART_MAX_BYTES): Promise<string | null> {
  if (!src || typeof document === 'undefined') return null;
  try {
    const img = await loadImage(src);
    for (const size of [192, 160, 128, 96]) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      if (!g) return null;
      const k = Math.min(size / img.naturalWidth, size / img.naturalHeight);
      const w = img.naturalWidth * k;
      const h = img.naturalHeight * k;
      g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      for (const uri of [c.toDataURL('image/png'), c.toDataURL('image/jpeg', 0.85), c.toDataURL('image/jpeg', 0.7)])
        if (artOk(uri) && Math.floor(((uri.length - uri.indexOf(',') - 1) * 3) / 4) <= maxBytes) return uri;
    }
    return null;
  } catch {
    return null;
  }
}

/** A seller's uploaded receipt picture → a valid inline data URI, or an error to show. */
export async function readReceiptArt(file: File): Promise<{ art?: string; error?: string }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return { error: 'Receipt art: a PNG, JPEG or WebP picture.' };
  if (file.size > 5_000_000) return { error: 'Receipt art: up to 5 MB (it is shrunk for the receipt).' };
  const url = URL.createObjectURL(file);
  try {
    const art = await artDataUri(url);
    return art ? { art } : { error: 'That picture could not be used. Try a simpler square image.' };
  } finally {
    URL.revokeObjectURL(url);
  }
}
