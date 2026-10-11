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
export type CardArtLook = { brightness: number; x: number; y: number };

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
    filter: `brightness(${clamp(look.brightness, MIN_BRIGHTNESS, 1).toFixed(3)})`,
  };
}

/** A look kept within range: brightness MIN_BRIGHTNESS..1, placement PLACE_MIN..PLACE_MAX. */
export function clampLook(look: CardArtLook): CardArtLook {
  return {
    brightness: clamp(look.brightness, MIN_BRIGHTNESS, 1),
    x: clamp(look.x, PLACE_MIN, PLACE_MAX),
    y: clamp(look.y, PLACE_MIN, PLACE_MAX),
  };
}

const LOOK_KEY = (key: string) => 'bw-card-art:' + key.toLowerCase();

/** The account's saved adjustment, or null for the default. */
export function loadCardArtLook(identityPubKey: string | null | undefined): CardArtLook | null {
  if (!identityPubKey) return null;
  try {
    const v = JSON.parse(localStorage.getItem(LOOK_KEY(identityPubKey)) ?? 'null');
    if (!v || typeof v !== 'object') return null;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
    const look = { brightness: n(v.brightness), x: n(v.x), y: n(v.y) };
    if ([look.brightness, look.x, look.y].some(Number.isNaN)) return null;
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
