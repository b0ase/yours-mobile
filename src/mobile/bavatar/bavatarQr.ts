/**
 * Scannable bAvatar: one round picture that is both bAvatar art and a payment QR.
 *
 * Layout (S × S, meant for a circular crop): the QR square, quiet zone included, is inscribed in the
 * circle (its corners touch the rim), and the identity's bAvatar blend fills the four segments outside
 * the square. Inside the square the art still shows, washed towards pale gold so every light module
 * reads light; dark modules are near-black shapes in one of four motifs. Finder patterns keep their
 * 1:1:3:1:1 ring structure (rounded is fine), the quiet zone stays plain pale gold, error correction
 * is H, and the optional centre b mark covers well under the H budget.
 *
 * Pure: no DOM, no network. `qrcode` builds the matrix (already a wallet dependency).
 * Not wired into minting yet: see the report on branch bavatar/scannable.
 */
import * as qr from 'qrcode';
import { bavatarSvg } from './bavatar';

export type BavatarQrStyle = 'dots' | 'rounded' | 'gilded' | 'seal';
export const BAVATAR_QR_STYLES: BavatarQrStyle[] = ['dots', 'rounded', 'gilded', 'seal'];

export interface BavatarQrOptions {
  size?: number;
  style?: BavatarQrStyle;
  /** Clip the whole picture to a circle (for previews/PNG); avatars are usually cropped by CSS. */
  circle?: boolean;
  /** Small gold b in the centre. Defaults on for 'seal', off otherwise. */
  logo?: boolean;
}

const PALE = '#fff3cf',
  INK = '#0b0a08',
  GOLD = '#d9a21a';
const QUIET = 4;

/** `bitcoin:<address>` (BIP21). Anything that already has a scheme passes through. */
export function bitcoinUri(address: string): string {
  const a = String(address).trim();
  return /^bitcoin:/i.test(a) ? a : 'bitcoin:' + a;
}

const f = (v: number) => String(+v.toFixed(3));

/** Strip the XML prologue and place an SVG document at x,y with width w (square). */
function nest(svg: string, x: number, y: number, w: number): string {
  return svg
    .replace(/^<\?xml[^>]*>\s*/, '')
    .replace(/^<svg\b[^>]*?>/, (tag) => tag.replace(/\s(width|height|x|y)="[^"]*"/g, ''))
    .replace(/^<svg\b/, `<svg x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(w)}"`);
}

export function bavatarQrSvg(identityKeyOrName: string, address: string, opts: BavatarQrOptions = {}): string {
  const S = opts.size ?? 512,
    style = opts.style ?? 'dots',
    logo = opts.logo ?? style === 'seal';
  const text = bitcoinUri(address);
  const m = qr.create(text, { errorCorrectionLevel: 'H' }).modules;
  const n = m.size,
    total = n + QUIET * 2;
  const side = S / Math.SQRT2, // square inscribed in the circle
    sq0 = (S - side) / 2,
    cell = side / total,
    off = sq0 + QUIET * cell;
  const id = 'bq' + Math.abs(hash(identityKeyOrName + '|' + text + '|' + style)).toString(36);

  const finder = (x: number, y: number) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  // Centre logo: a clear disc of ~ (n/5) modules, only modules wholly inside it are dropped.
  const lr = logo ? Math.max(3, Math.round(n / 6)) / 2 : 0,
    c = n / 2;
  const inLogo = (x: number, y: number) =>
    logo && Math.hypot(x + 0.5 - c, y + 0.5 - c) < lr + 0.2;

  const art = bavatarSvg(identityKeyOrName, { size: 512 });
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">`,
    `<defs><clipPath id="${id}c"><circle cx="${S / 2}" cy="${S / 2}" r="${S / 2}"/></clipPath></defs>`,
    opts.circle ? `<g clip-path="url(#${id}c)">` : '<g>',
    `<rect width="${S}" height="${S}" fill="${INK}"/>`,
    nest(art, 0, 0, S),
  );
  // Gold rim of the QR square, then the square itself: pale quiet zone, washed art in the data area.
  const wash = style === 'gilded' || style === 'seal' ? 0.8 : 0.84;
  parts.push(
    `<rect x="${f(sq0 - cell * 0.35)}" y="${f(sq0 - cell * 0.35)}" width="${f(side + cell * 0.7)}" height="${f(side + cell * 0.7)}" fill="${GOLD}"/>`,
    `<rect x="${f(sq0)}" y="${f(sq0)}" width="${f(side)}" height="${f(side)}" fill="${PALE}"/>`,
    `<svg x="${f(off)}" y="${f(off)}" width="${f(n * cell)}" height="${f(n * cell)}" viewBox="${f(off)} ${f(off)} ${f(n * cell)} ${f(n * cell)}" overflow="hidden">${nest(art, 0, 0, S)}</svg>`,
    `<rect x="${f(off)}" y="${f(off)}" width="${f(n * cell)}" height="${f(n * cell)}" fill="${PALE}" fill-opacity="${wash}"/>`,
  );

  // Modules, in module units.
  let dark = '',
    bars = '',
    fixed = '',
    fixedLight = '',
    light = '';
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (finder(x, y) || inLogo(x, y)) continue;
      const on = !!m.get(y, x);
      if (m.isReserved(y, x)) {
        // Function patterns (timing, alignment, format/version info) stay full square cells so
        // every decoder's alignment search finds them; only data modules carry the motif.
        if (on) fixed += `M${x} ${y}h1v1h-1z`;
        else fixedLight += `M${x} ${y}h1v1h-1z`;
      } else if (on) {
        dark += darkShape(style, x, y);
        // 'rounded': join each dark module to its right/down dark neighbour (own path, so the
        // winding of the bars never cancels the dots).
        if (style === 'rounded') {
          const r = 0.42,
            at = (cx: number, cy: number) => cx < n && cy < n && !finder(cx, cy) && !!m.get(cy, cx);
          if (at(x + 1, y)) bars += `M${x + 0.5} ${f(y + 0.5 - r)}h1v${2 * r}h-1z`;
          if (at(x, y + 1)) bars += `M${f(x + 0.5 - r)} ${y + 0.5}h${2 * r}v1h-${2 * r}z`;
        }
      }
      else if (style === 'gilded' || style === 'seal') light += `M${x + 0.5} ${y + 0.5}m-.42 0a.42 .42 0 1 0 .84 0a.42 .42 0 1 0 -.84 0`;
    }
  parts.push(`<g transform="translate(${f(off)} ${f(off)}) scale(${f(cell)})">`);
  if (light) parts.push(`<path d="${light}" fill="${PALE}"/>`);
  parts.push(`<path d="${dark}" fill="${INK}"/>`);
  if (bars) parts.push(`<path d="${bars}" fill="${INK}"/>`);
  parts.push(`<path d="${fixedLight}" fill="${PALE}"/>`, `<path d="${fixed}" fill="${INK}"/>`);
  for (const [fx, fy] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ]) {
    parts.push(
      `<rect x="${fx - 1}" y="${fy - 1}" width="9" height="9" fill="${PALE}"/>`,
      `<rect x="${fx}" y="${fy}" width="7" height="7" rx="${style === 'dots' ? 1.9 : 1.6}" fill="${INK}"/>`,
      `<rect x="${fx + 1}" y="${fy + 1}" width="5" height="5" rx="${style === 'dots' ? 1.6 : 1.1}" fill="${PALE}"/>`,
      style === 'dots' || style === 'seal'
        ? `<circle cx="${fx + 3.5}" cy="${fy + 3.5}" r="1.5" fill="${INK}"/>`
        : `<rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" rx=".8" fill="${INK}"/>`,
    );
  }
  if (logo) {
    parts.push(
      `<circle cx="${c}" cy="${c}" r="${lr}" fill="${INK}"/>`,
      `<circle cx="${c}" cy="${c}" r="${lr - 0.35}" fill="none" stroke="${GOLD}" stroke-width=".25"/>`,
      `<text x="${c}" y="${c + lr * 0.42}" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="${f(lr * 1.35)}" text-anchor="middle" fill="#ffd24d">b</text>`,
    );
  }
  parts.push('</g></g></svg>');
  return parts.join('');
}

function darkShape(style: BavatarQrStyle, x: number, y: number): string {
  const circle = (r: number) => `M${x + 0.5} ${y + 0.5}m-${r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0`;
  if (style === 'dots') return circle(0.46);
  if (style === 'rounded') return circle(0.42);
  if (style === 'gilded') return `M${x + 0.5} ${y}l.5 .48l-.5 .5l-.5 -.5z`; // diamonds
  const s = 0.8,
    i = (1 - s) / 2;
  return `M${f(x + i)} ${f(y + i)}h${s}v${s}h-${s}z`;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
