/**
 * Animated avatars (owner, 15 Oct 2026): GIF, animated WebP and APNG work as profile pictures everywhere.
 *
 * Animation used to be lost on the way in: every picker resized the photo through a canvas and saved a JPEG
 * (names/avatar.ts resizeAvatar, hooks/useIdentity.ts resizeImage, chat/RoomSettingsSheet.tsx covers), which
 * keeps only the first frame. Animated files now skip the canvas and are kept byte for byte, under a cap
 * (≤ 2 MB, ≤ 512 px a side); over the cap they are refused with a clear message, never silently flattened.
 *
 * Playback: animated on your own profile, the card and an open chat header / profile sheet; in long lists
 * (chat list, contacts, feeds) a still first frame, animated while pressed or hovered. Reduced motion: always still.
 * Pure helpers here (tested); the browser-only poster cache sits at the bottom.
 */

export const ANIMATED_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const ANIMATED_AVATAR_MAX_PX = 512;

export type ImageKind = 'gif' | 'png' | 'webp' | 'jpeg' | 'unknown';
export type SniffedImage = { kind: ImageKind; mime: string; animated: boolean; width: number; height: number };

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** GIF: animated when it has more than one image (counted by walking the blocks). */
function gifFrames(b: Uint8Array): number {
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 0x07) + 1)); // global colour table
  let frames = 0;
  while (p < b.length) {
    const t = b[p];
    if (t === 0x3b) break; // trailer
    if (t === 0x21) {
      p += 2; // extension introducer + label, then sub-blocks
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p += 1;
    } else if (t === 0x2c) {
      frames += 1;
      if (frames > 1) return frames;
      const flags = b[p + 9];
      p += 10;
      if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1)); // local colour table
      p += 1; // LZW min code size
      while (p < b.length && b[p] !== 0) p += b[p] + 1;
      p += 1;
    } else break;
  }
  return frames;
}

/** PNG: APNG when an `acTL` chunk comes before the first `IDAT`. */
function pngAnimated(b: Uint8Array): boolean {
  let p = 8;
  while (p + 8 <= b.length) {
    const len = u32be(b, p);
    const type = ascii(b, p + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    p += 12 + len;
  }
  return false;
}

/** What an image file really is (from its bytes, not its name), whether it moves, and its size in px. */
export function sniffImage(b: Uint8Array): SniffedImage {
  const none: SniffedImage = { kind: 'unknown', mime: '', animated: false, width: 0, height: 0 };
  if (b.length < 12) return none;
  if (ascii(b, 0, 4) === 'GIF8')
    return { kind: 'gif', mime: 'image/gif', animated: gifFrames(b) > 1, width: u16le(b, 6), height: u16le(b, 8) };
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b.length >= 24)
    return { kind: 'png', mime: 'image/png', animated: pngAnimated(b), width: u32be(b, 16), height: u32be(b, 20) };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    const out: SniffedImage = { kind: 'webp', mime: 'image/webp', animated: false, width: 0, height: 0 };
    if (chunk === 'VP8X' && b.length >= 30) {
      out.animated = (b[20] & 0x02) !== 0;
      out.width = u24le(b, 24) + 1;
      out.height = u24le(b, 27) + 1;
    } else if (chunk === 'VP8 ' && b.length >= 30) {
      out.width = u16le(b, 26) & 0x3fff;
      out.height = u16le(b, 28) & 0x3fff;
    } else if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      out.width = (bits & 0x3fff) + 1;
      out.height = ((bits >> 14) & 0x3fff) + 1;
    }
    return out;
  }
  if (b[0] === 0xff && b[1] === 0xd8) return { ...none, kind: 'jpeg', mime: 'image/jpeg' };
  return none;
}

export type AnimatedCheck = { ok: true; mime: string } | { ok: false; reason: string };

/** Is this animated picture small enough to keep as it is? Over the cap gets a message, never a flattened copy. */
export function checkAnimatedAvatar(
  img: Pick<SniffedImage, 'mime' | 'width' | 'height'>,
  bytes: number,
  maxBytes = ANIMATED_AVATAR_MAX_BYTES,
  maxPx = ANIMATED_AVATAR_MAX_PX,
): AnimatedCheck {
  if (bytes > maxBytes)
    return {
      ok: false,
      reason: `That animated picture is ${(bytes / 1024 / 1024).toFixed(1)} MB. Animated pictures can be up to ${Math.round(maxBytes / 1024 / 1024)} MB; try a shorter or smaller one.`,
    };
  if (img.width > maxPx || img.height > maxPx)
    return {
      ok: false,
      reason: `That animated picture is ${img.width}×${img.height}. Animated pictures can be up to ${maxPx}×${maxPx}; try a smaller one.`,
    };
  return { ok: true, mime: img.mime };
}

/** Thrown by the pickers when an animated picture is over the cap; its message is shown as is. */
export class AvatarTooBigError extends Error {}

/** The MIME type inside a data URL (`data:image/gif;base64,…` → image/gif), else ''. */
export const dataUrlMime = (u: string) => /^data:([^;,]+)[;,]/i.exec(u || '')?.[1]?.toLowerCase() ?? '';

/**
 * An animated file kept as is: a data URL of its own bytes, or null when the file doesn't move (the caller then
 * resizes it as before). Throws AvatarTooBigError when it moves but is over the cap.
 */
export async function keepAnimated(
  file: Blob,
  limits?: { maxBytes?: number; maxPx?: number },
): Promise<{ dataUrl: string; base64: string; mime: string } | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const img = sniffImage(bytes);
  if (!img.animated) return null;
  const check = checkAnimatedAvatar(img, bytes.length, limits?.maxBytes, limits?.maxPx);
  if (!check.ok) throw new AvatarTooBigError(check.reason);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const base64 = btoa(bin);
  return { dataUrl: `data:${check.mime};base64,${base64}`, base64, mime: check.mime };
}

// ── playback policy ──

/** Where an avatar is shown: `full` = own profile, card, open chat header, profile sheet; `list` = long lists. */
export type AvatarPlace = 'full' | 'list';

/** Animate or not: never with reduced motion; always in `full` places; in lists only while pressed/hovered. */
export const shouldAnimate = (place: AvatarPlace, reducedMotion: boolean, active = false) =>
  !reducedMotion && (place === 'full' || active);

/** Could this picture move? Only these get a still poster in lists (JPEGs and SVGs never move). */
export function mayBeAnimated(src: string | null | undefined): boolean {
  const s = String(src || '');
  if (!s) return false;
  if (s.startsWith('data:')) return /^data:image\/(gif|webp|png|apng)[;,]/i.test(s);
  if (/\.(jpe?g|svg)(\?|#|$)/i.test(s)) return false;
  // .gif/.webp/.png/.apng links, and on-chain content (ORDFS) whose type the URL doesn't say.
  return /\.(gif|webp|a?png)(\?|#|$)/i.test(s) || /\/content\/[0-9a-f]{64}_\d+/i.test(s);
}

export const prefersReducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

// ── still first frame (browser only) ──

const posters = new Map<string, Promise<string>>();

/** A still first frame of the picture as a PNG data URL, cached per src; '' when it can't be drawn (CORS). */
export function stillFrame(src: string): Promise<string> {
  let p = posters.get(src);
  if (!p) {
    p = new Promise<string>((resolve) => {
      const img = new Image();
      if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        try {
          const max = 160;
          const k = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round((img.naturalWidth || max) * k));
          c.height = Math.max(1, Math.round((img.naturalHeight || max) * k));
          c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        } catch {
          resolve('');
        }
      };
      img.onerror = () => resolve('');
      img.src = src;
    });
    if (posters.size > 300) posters.delete(posters.keys().next().value as string);
    posters.set(src, p);
  }
  return p;
}
