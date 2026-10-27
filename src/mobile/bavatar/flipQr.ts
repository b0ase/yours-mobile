import * as qr from 'qrcode';
import { bavatarArtQrSvg, bavatarSvg } from './bavatar';
import { CARD_QR } from '../wallet/cardBackQr';

/**
 * The back of the flip bAvatar (owner, 14 Oct 2026): the art stays pure art on the front, and the back is a
 * clean, plain QR that pays the account. Dark modules on white, a quiet zone, error correction M (ZXing-js misreads some Q matrices), and the
 * bWalletX black/gold framing only OUTSIDE the code, so every phone camera reads it.
 *
 * PUBLIC DATA ONLY (owner rule): the payload is a public receive address as `bitcoin:<address>` (what the
 * Receive screen shows) or a paymail. It is built on the device from data the app already shows; nothing is
 * fetched and nothing new is sent anywhere. `flipPayload` refuses anything else, and refuses key-like strings.
 */

const ADDRESS_RE = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const PAYMAIL_RE = /^[a-z0-9]([a-z0-9_.-]{0,30}[a-z0-9])?@[a-z0-9.-]+\.[a-z]{2,}$/;
/** What a pay code may look like: a BIP21 address URI, or a bare paymail. */
export const PAY_URI_RE = /^bitcoin:[13][a-km-zA-HJ-NP-Z1-9]{25,34}(\?.*)?$/;
/** Never in a pay code: WIF, 64-hex (private key / seed hash), extended private keys, 12+ word phrases. */
const SECRET_RES = [
  /[5KL][1-9A-HJ-NP-Za-km-z]{50,51}/,
  /[0-9a-fA-F]{64}/,
  /[xt]prv[1-9A-HJ-NP-Za-km-z]{20,}/,
  /(\b[a-z]{3,8}\b[\s+]+){11,}\b[a-z]{3,8}\b/,
];

export const isPayAddress = (a: string | null | undefined) => ADDRESS_RE.test(String(a ?? '').trim());

/** True only for public pay data that carries nothing secret. */
export function isPublicPayload(p: string): boolean {
  if (!p || SECRET_RES.some((re) => re.test(p))) return false;
  return PAY_URI_RE.test(p) || PAYMAIL_RE.test(p);
}

/** `bitcoin:<address>` for a public P2PKH address, '' otherwise. */
export function payUri(address: string | null | undefined): string {
  const a = String(address ?? '').trim();
  if (!ADDRESS_RE.test(a)) return '';
  const uri = `bitcoin:${a}`;
  return isPublicPayload(uri) ? uri : '';
}

/** A paymail (lowercased) as its own scan target, '' if it isn't one. */
export function paymailPayload(paymail: string | null | undefined): string {
  const p = String(paymail ?? '')
    .trim()
    .toLowerCase();
  return PAYMAIL_RE.test(p) && isPublicPayload(p) ? p : '';
}

/** The pay code for the flip: the receive address first (Receive screen), else the paymail. */
export const flipPayload = (address?: string | null, paymail?: string | null) =>
  payUri(address) || paymailPayload(paymail);

const PALE = '#fff3cf',
  INK = '#0b0a08';
const KEY_RE = /^0[23][0-9a-f]{64}$/;

/**
 * Scan tuning for the back (14 Oct 2026): the wallet card back's tuning (CARD_QR: bigger dots, paler wash, no
 * gold pip) plus an extra pale margin. The site's exact look (dot .62, wash .18, gold pip) reads in zbar but
 * not in ZXing or jsQR (the site's own b0asex PNG included); this reads 100% in zbar and ZXing over 24
 * names/addresses at 512/240/160 px, and ~83% in jsQR (the weakest; it misses pixel-sharp renders at 512).
 */
export const BACK_QR = CARD_QR;
/** Extra pale margin around the code, as a share of its side (the art QR's own quiet zone is 3 modules). */
export const BACK_MARGIN = 30 / 512;

const matrix = (payload: string) => qr.create(payload, { errorCorrectionLevel: 'H' }).modules;

/**
 * The live back: bavatarArtQrSvg (unchanged, shared with bit-sign) with the scan tuning, inside a pale
 * margin. Square, shown as a rounded card when flipped. '' without an art seed or a public payload.
 */
export function flipBackSvg(artSeed: string, payload: string, opts: { size?: number } = {}): string {
  // The art seed is the identity key (public) or, for someone without one here, a handle/address.
  const raw = String(artSeed ?? '').trim();
  const key = KEY_RE.test(raw.toLowerCase()) ? raw.toLowerCase() : raw;
  if (!key || !isPublicPayload(payload)) return '';
  const S = opts.size ?? 512,
    W = +(S * BACK_MARGIN).toFixed(2),
    inner = S - 2 * W;
  const art = bavatarArtQrSvg(key, payload, matrix(payload), { size: 512, ...BACK_QR })
    .replace(/^<\?xml[^>]*>\s*/, '')
    .replace(/^<svg\b[^>]*?>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, ''))
    .replace(/^<svg\b/, `<svg x="${W}" y="${W}" width="${inner}" height="${inner}"`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Pay code">` +
    `<rect width="${S}" height="${S}" fill="${PALE}"/>` +
    art +
    '</svg>'
  );
}

/**
 * The same Art QR drawn compactly for the inscription (≤ 40 KB): the art is a `<use>` of a symbol the card
 * already holds (`artId`), the modules are one path per colour of small squares with a round-joined stroke,
 * which draws the same rounded squares (corner .3 of the dot) at a fraction of the bytes. Module units.
 * Returns the group to place in a `size` square at (x, y). '' unless the payload is public.
 */
export function compactArtBackGroup(payload: string, artId: string, x: number, y: number, size: number): string {
  if (!isPublicPayload(payload)) return '';
  const m = matrix(payload),
    n = m.size,
    quiet = 3;
  const W = size * BACK_MARGIN,
    side = size - 2 * W,
    cell = side / (n + quiet * 2),
    off = quiet * cell;
  const f = (v: number) => String(+v.toFixed(3)).replace(/^0\./, '.').replace(/^-0\./, '-.');
  const finder = (cx: number, cy: number) => (cx < 8 && cy < 8) || (cx >= n - 8 && cy < 8) || (cx < 8 && cy >= n - 8);
  const d = BACK_QR.dot,
    w = d * 0.6, // stroke width = 2 × corner radius (.3 of the dot)
    core = d - w,
    i = (1 - core) / 2;
  const dots = (dark: boolean) => {
    let out = 'M0 0',
      px = 0,
      py = 0;
    for (let yy = 0; yy < n; yy++)
      for (let xx = 0; xx < n; xx++) {
        if (finder(xx, yy) || !!m.get(yy, xx) !== dark) continue;
        out += `m${f(xx + i - px)} ${f(yy + i - py)}h${f(core)}v${f(core)}h${f(-core)}z`;
        px = xx + i;
        py = yy + i;
      }
    return out;
  };
  let finders = '';
  for (const [fx, fy] of [
    [0, 0],
    [n - 7, 0],
    [0, n - 7],
  ])
    finders +=
      `<rect x="${fx - 1}" y="${fy - 1}" width="9" height="9" fill="${PALE}"/>` +
      `<rect x="${fx}" y="${fy}" width="7" height="7" rx="1.6" fill="${INK}"/>` +
      `<rect x="${fx + 1}" y="${fy + 1}" width="5" height="5" rx="1.1" fill="${PALE}"/>` +
      `<rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" rx=".8" fill="${INK}"/>`;
  const code = n * cell,
    ox = x + W + off,
    oy = y + W + off;
  const clip = `${artId}c`;
  return (
    `<g>` +
    `<rect x="${f(x)}" y="${f(y)}" width="${f(size)}" height="${f(size)}" fill="${PALE}"/>` +
    `<clipPath id="${clip}"><rect x="${f(ox)}" y="${f(oy)}" width="${f(code)}" height="${f(code)}"/></clipPath>` +
    `<g clip-path="url(#${clip})"><use href="#${artId}" x="${f(ox)}" y="${f(oy)}" width="${f(code)}" height="${f(code)}"/></g>` +
    `<g transform="translate(${f(ox)} ${f(oy)}) scale(${f(cell)})">` +
    `<rect width="${n}" height="${n}" fill="${PALE}" fill-opacity="${BACK_QR.lift}"/>` +
    `<path d="${dots(false)}" fill="${PALE}" stroke="${PALE}" stroke-width="${f(w)}" stroke-linejoin="round"/>` +
    `<path d="${dots(true)}" fill="${INK}" stroke="${INK}" stroke-width="${f(w)}" stroke-linejoin="round"/>` +
    finders +
    '</g></g>'
  );
}

/** The plain bAvatar art (design #`variant`, 0 = the original) as a `<symbol>` (for `<use>` on both sides of the minted card). */
export function artSymbol(identityKey: string, id: string, variant = 0): string {
  return bavatarSvg(String(identityKey).toLowerCase(), { size: 512, variant })
    .replace(/^<\?xml[^>]*>\s*/, '')
    .replace(/^<svg\b[^>]*?>/, `<symbol id="${id}" viewBox="0 0 512 512">`)
    .replace(/<\/svg>\s*$/, '</symbol>');
}
