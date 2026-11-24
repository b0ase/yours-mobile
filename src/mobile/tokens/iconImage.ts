import type { OneSatContext } from '@1sat/actions';
import { inscribeIcon } from '../tickets/mintTicket';
import { STORE_BUILD, STORE_NAME_NOTE } from '../storeBuild';
import { deployToken, type MintedToken } from './mintToken';
import { cleanToken, type TokenForm } from './token';

/**
 * The icon of a token made with Mint a token. The person's own image is inscribed as its own 1Sat ordinal, and the
 * token's `icon` is that inscription's outpoint (`<txid>_<vout>`, the BSV-21 convention). When the person skips there
 * is no icon field at all on chain; the default gold coin is shown at display time, and the sheet says so.
 *
 * Every picked image (PNG, JPEG, WebP, HEIC if the browser can decode it, SVG) is drawn onto a canvas and re-encoded
 * as PNG or WebP of at most 512 × 512 and 100 KB. Only that raster is ever inscribed: an SVG is never inscribed or
 * parsed by us, it is only drawn by the browser's image decoder (which runs no script and loads nothing outside it).
 */

export const ICON_MAX_BYTES = 100 * 1024;
export const ICON_MAX_EDGE = 512;
/** Input caps, checked before the image is decoded (file size) and before it is drawn (width × height). */
export const ICON_INPUT_MAX_BYTES = 12 * 1024 * 1024;
export const ICON_INPUT_MAX_PIXELS = 40_000_000;
export const ICON_TYPE_MESSAGE = 'Pick a PNG, JPEG, WebP or SVG image for the icon.';
export const ICON_TOO_BIG_MESSAGE =
  'That image is still over 100 KB after shrinking it. Pick a simpler or smaller one.';
export const ICON_INPUT_TOO_BIG_MESSAGE = 'That image is too big to open. Pick one under 12 MB.';
export const ICON_UNREADABLE_MESSAGE = 'Could not read this image';
export const ICON_SAVED_MESSAGE = 'Your icon is saved; try the token again';
export const DEFAULT_ICON_NOTE = 'No image: uses the default coin';

export type IconKind = 'png' | 'webp' | 'jpeg' | 'heic' | 'svg';
export type OutputKind = 'png' | 'webp';
const OUT_TYPE: Record<OutputKind, 'image/png' | 'image/webp'> = { png: 'image/png', webp: 'image/webp' };

/** What the picked file's type says it is (input only). Output is only ever PNG or WebP. */
export const iconKind = (type: string): IconKind | null => {
  const t = type.toLowerCase().split(';')[0].trim();
  if (t === 'image/png') return 'png';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/jpeg' || t === 'image/jpg') return 'jpeg';
  if (t === 'image/heic' || t === 'image/heif') return 'heic';
  if (t === 'image/svg+xml') return 'svg';
  return null;
};

export type RasterEncoder = (
  file: File,
  edge: number,
  type: 'image/png' | 'image/webp',
  quality?: number,
) => Promise<File>;

type Source = { source: CanvasImageSource; width: number; height: number; close: () => void };

/** Decode with the browser's own decoder. SVG goes through an <img>, which runs no script and fetches nothing. */
const decode = async (file: File): Promise<Source> => {
  if (iconKind(file.type) !== 'svg') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close?.() };
    } catch {
      // fall through to the <img> decoder (some browsers decode HEIC or odd JPEGs only there)
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // An SVG with no size of its own reports 0: draw it at the full edge.
    const w = img.naturalWidth || ICON_MAX_EDGE;
    const h = img.naturalHeight || ICON_MAX_EDGE;
    return { source: img, width: w, height: h, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
};

/**
 * The browser encoder: centre-crop to a square, scale to `edge` (never up) and encode. WebKit's canvas can't make
 * WebP and hands back a PNG instead; that is fine, the type of what came out is what is returned.
 */
export const canvasEncoder: RasterEncoder = async (file, edge, type, quality) => {
  const src = await decode(file);
  try {
    if (!(src.width > 0 && src.height > 0) || src.width * src.height > ICON_INPUT_MAX_PIXELS)
      throw new Error(ICON_INPUT_TOO_BIG_MESSAGE);
    const side = Math.min(src.width, src.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.min(edge, side);
    canvas
      .getContext('2d')!
      .drawImage(
        src.source,
        (src.width - side) / 2,
        (src.height - side) / 2,
        side,
        side,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
    const got = blob && (blob.type === 'image/png' || blob.type === 'image/webp') ? blob.type : null;
    if (!blob || !got) throw new Error(ICON_UNREADABLE_MESSAGE);
    return new File([blob], got === 'image/png' ? 'icon.png' : 'icon.webp', { type: got });
  } finally {
    src.close();
  }
};

/** Re-encode steps, tried in order until one is within the limit. A step that fails is skipped. */
const STEPS: { edge: number; type: 'image/png' | 'image/webp'; quality?: number }[] = [
  { edge: ICON_MAX_EDGE, type: 'image/png' },
  { edge: ICON_MAX_EDGE, type: 'image/webp', quality: 0.9 },
  { edge: 384, type: 'image/webp', quality: 0.8 },
  { edge: 256, type: 'image/webp', quality: 0.8 },
  { edge: 128, type: 'image/webp', quality: 0.8 },
  { edge: 384, type: 'image/png' },
  { edge: 256, type: 'image/png' },
  { edge: 128, type: 'image/png' },
];

export type PreparedIcon = { file: File; kind: OutputKind };

/** True only when the bytes really are a PNG or a WebP, whatever the file claims to be. */
const rasterKind = async (f: File): Promise<OutputKind | null> => {
  const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b[0] === 0x89 && at(1, 'PNG') && b[4] === 0x0d) return 'png';
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  return null;
};

/**
 * Validate and prepare a picked image. Throws an Error whose message is shown to the person as it stands.
 * Every image, SVG included, is re-encoded to a PNG or WebP of at most 512 × 512 and 100 KB, and only that raster is
 * returned. The output's own bytes are checked to be a raster before it is accepted.
 */
export const prepareIcon = async (file: File, encode: RasterEncoder = canvasEncoder): Promise<PreparedIcon> => {
  if (!iconKind(file.type)) throw new Error(ICON_TYPE_MESSAGE);
  if (file.size <= 0) throw new Error('That file is empty.');
  if (file.size > ICON_INPUT_MAX_BYTES) throw new Error(ICON_INPUT_TOO_BIG_MESSAGE);
  let tooBig = false;
  let lastError: unknown = null;
  for (const s of STEPS) {
    let out: File;
    try {
      out = await encode(file, s.edge, s.type, s.quality);
    } catch (e) {
      lastError = e;
      continue;
    }
    const kind = await rasterKind(out);
    if (!kind || out.type !== OUT_TYPE[kind]) {
      lastError = new Error(ICON_UNREADABLE_MESSAGE);
      continue;
    }
    if (out.size > 0 && out.size <= ICON_MAX_BYTES) return { file: out, kind };
    tooBig = true;
  }
  if (tooBig) throw new Error(ICON_TOO_BIG_MESSAGE);
  throw new Error(lastError instanceof Error ? lastError.message : ICON_UNREADABLE_MESSAGE);
};

/** What the confirm sheet shows for the icon row, and the line under the picker. */
export const iconSummary = (icon: { file: File } | null, formatBytes: (n: number) => string) =>
  icon
    ? { row: formatBytes(icon.file.size), note: `${formatBytes(icon.file.size)} · inscribed with the token` }
    : { row: 'Default coin', note: DEFAULT_ICON_NOTE };

export interface MintSteps {
  inscribe: typeof inscribeIcon;
  deploy: typeof deployToken;
}

/** An icon that is already on chain for the picked file, kept by the caller so a retry never inscribes it twice. */
export interface SavedIcon {
  file: File;
  outpoint: string;
}

export interface MintExtras {
  /** The icon already inscribed for this very file (compared by identity). */
  saved?: SavedIcon | null;
  /** Called the moment the inscription is confirmed on chain, before the deploy. */
  onInscribed?: (saved: SavedIcon) => void;
  /** A store build never mints a token (storeBuild.ts); checked before anything is inscribed. */
  store?: boolean;
}

/**
 * The mint, in order: inscribe the picked image (to the person's own key), then deploy with `icon` = the
 * inscription's outpoint. A store build is refused before anything is inscribed. If the inscription fails the error
 * is thrown before the deploy is called, so nothing is minted. If the inscription is on chain and the deploy then
 * fails, the caller already holds the outpoint (`onInscribed`) and passes it back as `saved` on retry, so the image
 * is not inscribed twice; the error says the icon is saved. Skipping the image deploys with no icon field.
 */
export async function mintWithIcon(
  ctx: OneSatContext,
  form: TokenForm,
  icon: File | null,
  opts: Omit<Parameters<typeof deployToken>[2], 'icon'>,
  steps: MintSteps = { inscribe: inscribeIcon, deploy: deployToken },
  extras: MintExtras = {},
): Promise<MintedToken> {
  if (extras.store ?? STORE_BUILD) throw new Error(STORE_NAME_NOTE);
  if (!icon) return steps.deploy(ctx, form, { ...opts, icon: null });
  let outpoint: string;
  if (extras.saved && extras.saved.file === icon) outpoint = extras.saved.outpoint;
  else {
    outpoint = await steps.inscribe(ctx, icon, cleanToken(form).ticker, 'token', 'token-icon');
    extras.onInscribed?.({ file: icon, outpoint });
  }
  try {
    return await steps.deploy(ctx, form, { ...opts, icon: outpoint });
  } catch (e) {
    throw new Error(ICON_SAVED_MESSAGE, { cause: e });
  }
}
