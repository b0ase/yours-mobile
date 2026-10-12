import { bavatarSvg } from '../bavatar/bavatar';

/**
 * The front of the wallet card (owner, 11 Oct 2026): the account's bAvatar art, the same blend bChatX
 * uses as a profile's default banner and the wallet uses as the default avatar. Seeded by the identity
 * key exactly as names/avatar.ts bavatarDataUri() and bChatX /api/bavatar, so all three match. Drawn
 * locally (no network) and cached per key, so the home screen draws it once per account.
 *
 * bWallet (store edition) keeps its yellow card: no art there. An account with its own uploaded picture
 * keeps that picture as its avatar; the card art is still its bAvatar.
 */
const KEY_RE = /^0[23][0-9a-f]{64}$/;
const cache = new Map<string, string>();

/** Data URI of the card-front art, or '' (yellow bWallet card, or no identity key yet). */
export function cardFrontArtUri(identityPubKey: string | null | undefined, yellowCard: boolean): string {
  if (yellowCard) return '';
  const key = String(identityPubKey ?? '')
    .trim()
    .toLowerCase();
  if (!KEY_RE.test(key)) return '';
  let uri = cache.get(key);
  if (!uri) {
    uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(key, { size: 512, label: '' }));
    cache.set(key, uri);
  }
  return uri;
}

/* ── Placement and brightness (owner, 11 Oct 2026) ─────────────────────────────────────────────────────────────
   Some accounts' art came out too bright and dead centre, glaring behind the balance and buttons; others (a dim,
   off-centre one) looked right. So by default the art is zoomed in and its bright core is moved toward the
   top-right (away from the $handle top-left and the balance bottom-left), and bright art is dimmed to the level
   of a calm one. Each account can then adjust its own card: brightness and where the art sits. */

/** How the art sits on the card: brightness is the CSS filter value (<= 1, so the shade's contrast always holds);
 *  x/y are where the art's centre lands on the card, in % of its width/height. */
export type CardArtLook = {
  brightness: number;
  x: number;
  y: number;
  /** Colour (owner, 12 Oct 2026): hue turn in degrees (-180..180) and saturation (0 = grey .. 2 = vivid; 1 = as drawn). */
  hue?: number;
  saturation?: number;
};
export const HUE_MIN = -180;
export const HUE_MAX = 180;
export const SAT_MIN = 0;
export const SAT_MAX = 2;

/** The art is drawn at this zoom; its centre can move within PLACE_MIN..PLACE_MAX % without showing an edge
 *  (scaled about origin o, the art spans v - 50Z .. v + 50Z, which must cover 0..100). */
export const ART_ZOOM = 1.4;
export const PLACE_MIN = 100 - 50 * ART_ZOOM;
export const PLACE_MAX = 100 - PLACE_MIN;
/** Mean luminance (0-1) the default aims for: that of a calm card the owner liked ($testy, ~0.27; art spans ~0.2-0.42). */
export const TARGET_LUMA = 0.26;
export const MIN_BRIGHTNESS = 0.3;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function seedOf(key: string, at: number): number {
  return parseInt(key.slice(at, at + 4), 16) / 0xffff || 0;
}

/** Default brightness for art of mean luminance `luma`: bright art is dimmed toward TARGET_LUMA, dim art is left. */
export function autoBrightness(luma: number | null): number {
  if (luma == null || !(luma > 0)) return 0.8;
  return clamp(TARGET_LUMA / luma, MIN_BRIGHTNESS, 1);
}

/** Default placement, seeded by the key: the art's centre sits somewhere in the top-right area of the card. */
export function defaultPlacement(identityPubKey: string): { x: number; y: number } {
  const key = String(identityPubKey ?? '').toLowerCase();
  return { x: Math.round(PLACE_MAX - seedOf(key, 2) * 6), y: Math.round(PLACE_MIN + seedOf(key, 6) * 6) };
}

/** CSS for the art image: zoom around the origin that puts the art's centre at (x%, y%) of the card. */
export function artStyle(look: CardArtLook): Record<string, string> {
  // Scaling by Z about origin o moves the centre (50%) to o + Z(50 - o); solve for o.
  const o = (v: number) => ((clamp(v, PLACE_MIN, PLACE_MAX) - ART_ZOOM * 50) / (1 - ART_ZOOM)).toFixed(2) + '%';
  return {
    transform: `scale(${ART_ZOOM})`,
    transformOrigin: `${o(look.x)} ${o(look.y)}`,
    filter: artFilter(look),
  };
}

/** CSS filter for the art: shade (brightness), then saturation, then hue. Same filter for bAvatar art and an
 *  uploaded picture. Unset colour = the art as drawn. */
export function artFilter(look: CardArtLook): string {
  const parts = [`brightness(${clamp(look.brightness, MIN_BRIGHTNESS, 1).toFixed(3)})`];
  const sat = clamp(look.saturation ?? 1, SAT_MIN, SAT_MAX);
  const hue = Math.round(clamp(look.hue ?? 0, HUE_MIN, HUE_MAX));
  if (sat !== 1) parts.push(`saturate(${sat.toFixed(2)})`);
  if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`);
  return parts.join(' ');
}

/** A look kept within range: brightness MIN_BRIGHTNESS..1, placement PLACE_MIN..PLACE_MAX, hue/saturation in range. */
export function clampLook(look: CardArtLook): CardArtLook {
  const out: CardArtLook = {
    brightness: clamp(look.brightness, MIN_BRIGHTNESS, 1),
    x: clamp(look.x, PLACE_MIN, PLACE_MAX),
    y: clamp(look.y, PLACE_MIN, PLACE_MAX),
  };
  if (typeof look.hue === 'number' && Number.isFinite(look.hue)) out.hue = clamp(look.hue, HUE_MIN, HUE_MAX);
  if (typeof look.saturation === 'number' && Number.isFinite(look.saturation))
    out.saturation = clamp(look.saturation, SAT_MIN, SAT_MAX);
  return out;
}

const LOOK_KEY = (key: string) => 'bw-card-art:' + key.toLowerCase();

/** The account's saved adjustment, or null for the default. */
export function loadCardArtLook(identityPubKey: string | null | undefined): CardArtLook | null {
  if (!identityPubKey) return null;
  try {
    const v = JSON.parse(localStorage.getItem(LOOK_KEY(identityPubKey)) ?? 'null');
    if (!v || typeof v !== 'object') return null;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
    const look: CardArtLook = { brightness: n(v.brightness), x: n(v.x), y: n(v.y) };
    if ([look.brightness, look.x, look.y].some(Number.isNaN)) return null;
    if (!Number.isNaN(n(v.hue))) look.hue = n(v.hue);
    if (!Number.isNaN(n(v.saturation))) look.saturation = n(v.saturation);
    return clampLook(look);
  } catch {
    return null;
  }
}

export function saveCardArtLook(identityPubKey: string | null | undefined, look: CardArtLook | null): void {
  if (!identityPubKey) return;
  try {
    if (look) localStorage.setItem(LOOK_KEY(identityPubKey), JSON.stringify(look));
    else localStorage.removeItem(LOOK_KEY(identityPubKey));
  } catch {
    /* private mode: the adjustment lasts this session only */
  }
}

/* ── Own picture (owner, 12 Oct 2026) ─────────────────────────────────────────────────────────────────────────
   An account may put its own picture on the card front instead of its bAvatar art. It is resized and compressed on
   this device and kept in this device's storage per account; it is never uploaded anywhere. */

const IMG_KEY = (key: string) => 'bw-card-img:' + key.toLowerCase();
/** Longest side of a stored card picture, in pixels; JPEG quality. ~100-200 KB per picture. */
export const CARD_IMG_MAX = 900;
/** Fired when a card picture is saved from elsewhere (e.g. bPics › Use on my card) so the card re-reads it. */
export const CARD_IMG_EVENT = 'bw-card-img-changed';
const CARD_IMG_QUALITY = 0.84;

export function loadCardImage(identityPubKey: string | null | undefined): string | null {
  if (!identityPubKey) return null;
  try {
    const v = localStorage.getItem(IMG_KEY(identityPubKey));
    return v && v.startsWith('data:image/') ? v : null;
  } catch {
    return null;
  }
}

/** Saves (or with null, removes) the account's card picture. False when the device has no room for it. */
export function saveCardImage(identityPubKey: string | null | undefined, uri: string | null): boolean {
  if (!identityPubKey) return false;
  try {
    if (uri) localStorage.setItem(IMG_KEY(identityPubKey), uri);
    else localStorage.removeItem(IMG_KEY(identityPubKey));
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(CARD_IMG_EVENT));
    return true;
  } catch {
    return false;
  }
}

/** Width/height that fit within `max` on the longest side, keeping the aspect ratio (never enlarges). */
export function fitWithin(w: number, h: number, max = CARD_IMG_MAX): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Reads a picture the user picked and returns a resized JPEG data URI, or throws a plain-English error. */
export async function prepareCardImage(file: Blob, max = CARD_IMG_MAX, quality = CARD_IMG_QUALITY): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file isn’t a picture.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That picture couldn’t be opened.'));
      i.src = url;
    });
    const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight, max);
    if (!w) throw new Error('That picture couldn’t be opened.');
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('This device can’t resize pictures.');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Image NFTs that can go on the card: raster pictures only (no SVG markup, video or HTML). */
export function isCardNftType(contentType: string | null | undefined): boolean {
  const t = (contentType ?? '').toLowerCase().split(';')[0].trim();
  return t.startsWith('image/') && t !== 'image/svg+xml';
}

/** Fetches an image NFT (ORDFS content URL) and resizes it like an uploaded picture. */
export async function prepareCardImageFromUrl(url: string): Promise<string> {
  let blob: Blob;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    blob = await r.blob();
  } catch {
    throw new Error('That NFT couldn’t be loaded. Check your connection and try again.');
  }
  if (!isCardNftType(blob.type)) throw new Error('Only picture NFTs can go on the card.');
  return prepareCardImage(blob);
}

const lumaCache = new Map<string, number>();

/** Mean luminance (0-1) of the art, measured once per key on a small canvas. Null where there is no canvas. */
export function measureArtLuma(uri: string): Promise<number | null> {
  const hit = lumaCache.get(uri);
  if (hit != null) return Promise.resolve(hit);
  if (typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const N = 32;
        const c = document.createElement('canvas');
        c.width = c.height = N;
        const ctx = c.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        const luma = sum / (N * N);
        lumaCache.set(uri, luma);
        resolve(luma);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = uri;
  });
}
