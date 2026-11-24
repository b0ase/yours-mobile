import type { OneSatContext } from '@1sat/actions';
import { inscribeIcon } from '../tickets/mintTicket';
import { BWALLET_MARK_ICON } from '../names/personalToken';
import { deployToken, type MintedToken } from './mintToken';
import type { TokenForm } from './token';

/**
 * The icon of a token made with Mint a token. The person's own image is inscribed as its own 1Sat ordinal, and the
 * token's `icon` is that inscription's outpoint (`<txid>_<vout>`, the BSV-21 convention). The default gold coin is
 * used only when the person skips, and the sheet says so before they confirm.
 *
 * Accepted: PNG and WebP (re-encoded to at most 512 × 512 and 100 KB by the wallet) and SVG after it passes
 * `checkSvg`. Anything else is refused with a plain message.
 */

export const ICON_MAX_BYTES = 100 * 1024;
export const ICON_MAX_EDGE = 512;
export const ICON_TYPE_MESSAGE = 'Pick a PNG, WebP or SVG image for the icon.';
export const ICON_TOO_BIG_MESSAGE =
  'That image is still over 100 KB after shrinking it. Pick a simpler or smaller one.';
export const DEFAULT_ICON_NOTE = 'No image: uses the default coin';

export type IconKind = 'png' | 'webp' | 'svg';

export const iconKind = (type: string): IconKind | null => {
  const t = type.toLowerCase().split(';')[0].trim();
  if (t === 'image/png') return 'png';
  if (t === 'image/webp') return 'webp';
  if (t === 'image/svg+xml') return 'svg';
  return null;
};

export type SvgCheck = { ok: true; svg: string } | { ok: false; message: string };

const SVG_BAD = (why: string): SvgCheck => ({ ok: false, message: `That SVG can't be used: it ${why}.` });

/**
 * Checks an SVG for the things that must never be inscribed as an icon. It refuses rather than rewrites, so what is
 * inscribed is exactly what was checked: scripts, event handlers (onload=…), foreignObject, embedded pages
 * (iframe, object, embed), DOCTYPE/ENTITY, `javascript:` and any link or `url()` that isn't a `#fragment` inside the file.
 */
export const checkSvg = (text: string): SvgCheck => {
  const svg = text.replace(/^﻿/, '').trim();
  if (!/<svg[\s>]/i.test(svg)) return SVG_BAD('is not an SVG image');
  if (/<script/i.test(svg)) return SVG_BAD('contains a script');
  if (/<foreignObject/i.test(svg)) return SVG_BAD('contains a foreignObject');
  if (/<(iframe|object|embed|audio|video|link|meta|base)[\s>/]/i.test(svg)) return SVG_BAD('embeds other content');
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(svg)) return SVG_BAD('declares entities or stylesheets');
  if (/[\s"'/]on[a-z]+\s*=/i.test(svg)) return SVG_BAD('has an event handler');
  if (/javascript:|vbscript:/i.test(svg)) return SVG_BAD('has a script link');
  // Every link must point inside the file ("#id"). http(s):, data:, // and relative paths are all external.
  for (const m of svg.matchAll(/(?:^|[\s"'/])(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!v.startsWith('#')) return SVG_BAD('links to something outside the image');
  }
  if (/attributeName\s*=\s*["']?(?:xlink:)?href/i.test(svg)) return SVG_BAD('animates a link');
  if (/\bsrc\s*=/i.test(svg)) return SVG_BAD('links to something outside the image');
  for (const m of svg.matchAll(/url\(\s*(["']?)([^)]*)\1\s*\)/gi))
    if (!m[2].trim().startsWith('#')) return SVG_BAD('links to something outside the image');
  if (/@import/i.test(svg)) return SVG_BAD('imports a stylesheet');
  if (/expression\s*\(/i.test(svg)) return SVG_BAD('has a style expression');
  return { ok: true, svg };
};

export type RasterEncoder = (
  file: File,
  edge: number,
  type: 'image/png' | 'image/webp',
  quality?: number,
) => Promise<File>;

/** The browser encoder: centre-crop to a square, scale to `edge` (never up) and encode. */
export const canvasEncoder: RasterEncoder = async (file, edge, type, quality) => {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(edge, side);
  canvas
    .getContext('2d')!
    .drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, quality));
  if (!blob || blob.type !== type) throw new Error('Could not read this image');
  return new File([blob], type === 'image/png' ? 'icon.png' : 'icon.webp', { type });
};

/** Re-encode steps, tried in order until one is within the limit. */
const STEPS: { edge: number; type: 'image/png' | 'image/webp'; quality?: number }[] = [
  { edge: ICON_MAX_EDGE, type: 'image/png' },
  { edge: ICON_MAX_EDGE, type: 'image/webp', quality: 0.9 },
  { edge: 384, type: 'image/webp', quality: 0.8 },
  { edge: 256, type: 'image/webp', quality: 0.8 },
  { edge: 128, type: 'image/webp', quality: 0.8 },
];

export type PreparedIcon = { file: File; kind: IconKind };

/**
 * Validate and prepare a picked image. Throws an Error whose message is shown to the person as it stands.
 * SVG is checked and kept as is; PNG/WebP are squared and re-encoded to fit 512 × 512 and 100 KB.
 */
export const prepareIcon = async (file: File, encode: RasterEncoder = canvasEncoder): Promise<PreparedIcon> => {
  const kind = iconKind(file.type);
  if (!kind) throw new Error(ICON_TYPE_MESSAGE);
  if (file.size <= 0) throw new Error('That file is empty.');
  if (kind === 'svg') {
    if (file.size > ICON_MAX_BYTES) throw new Error(ICON_TOO_BIG_MESSAGE);
    const res = checkSvg(await file.text());
    if (!res.ok) throw new Error(res.message);
    return { file: new File([res.svg], 'icon.svg', { type: 'image/svg+xml' }), kind };
  }
  for (const s of STEPS) {
    const out = await encode(file, s.edge, s.type, s.quality);
    if (out.size > 0 && out.size <= ICON_MAX_BYTES) return { file: out, kind: iconKind(out.type) ?? kind };
  }
  throw new Error(ICON_TOO_BIG_MESSAGE);
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

/**
 * The mint, in order: inscribe the picked image (to the person's own key), then deploy with `icon` = the
 * inscription's outpoint. If the inscription fails the error is thrown before the deploy is called, so nothing is
 * minted. Skipping the image deploys with the default coin.
 */
export async function mintWithIcon(
  ctx: OneSatContext,
  form: TokenForm,
  icon: File | null,
  opts: Omit<Parameters<typeof deployToken>[2], 'icon'>,
  steps: MintSteps = { inscribe: inscribeIcon, deploy: deployToken },
): Promise<MintedToken> {
  const outpoint = icon ? await steps.inscribe(ctx, icon, form.ticker.trim(), 'token') : null;
  return steps.deploy(ctx, form, { ...opts, icon: outpoint ?? BWALLET_MARK_ICON });
}
