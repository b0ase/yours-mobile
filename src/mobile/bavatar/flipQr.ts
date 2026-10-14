import * as qr from 'qrcode';

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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const INK = '#0b0a08',
  GOLD = '#F5B800';
export const QUIET = 3;

/** One path of unit squares (merged per row run) for the dark modules, in module units. */
export function qrModulesPath(payload: string): { n: number; d: string } {
  const m = qr.create(payload, { errorCorrectionLevel: 'M' }).modules;
  const n = m.size;
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!m.get(y, x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && m.get(y, x)) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  }
  return { n, d };
}

/**
 * The back as a round SVG (fits the avatar circle): black bezel, thin gold ring, a white disc, and the QR
 * with its quiet zone inscribed in the disc. Optional small caption under the code, inside the disc.
 * '' when the payload isn't public pay data.
 */
export function flipBackSvg(payload: string, opts: { size?: number; caption?: string } = {}): string {
  if (!isPublicPayload(payload)) return '';
  const S = opts.size ?? 512;
  const { n, d } = qrModulesPath(payload);
  const c = S / 2,
    bezel = S * 0.035,
    ring = S * 0.012;
  const r = c - bezel - ring; // white disc radius
  const caption = (opts.caption ?? '').slice(0, 40);
  // Square (code + quiet zone) inscribed in the disc; shrink a little when there is a caption under it.
  const side = r * Math.SQRT2 * (caption ? 0.9 : 1);
  const unit = side / (n + QUIET * 2);
  const ox = c - side / 2,
    oy = c - side / 2 - (caption ? r * 0.06 : 0);
  const f = (v: number) => +v.toFixed(2);
  const fs = f(S * 0.04);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Pay code">` +
    `<circle cx="${c}" cy="${c}" r="${c}" fill="${INK}"/>` +
    `<circle cx="${c}" cy="${c}" r="${f(c - bezel)}" fill="${GOLD}"/>` +
    `<circle cx="${c}" cy="${c}" r="${f(r)}" fill="#fff"/>` +
    `<path transform="translate(${f(ox + QUIET * unit)} ${f(oy + QUIET * unit)}) scale(${+unit.toFixed(4)})" fill="${INK}" shape-rendering="crispEdges" d="${d}"/>` +
    (caption
      ? `<text x="${c}" y="${f(oy + side + fs * 1.1)}" font-family="Helvetica,Arial,sans-serif" font-size="${fs}" font-weight="700" text-anchor="middle" fill="${INK}">${esc(caption)}</text>`
      : '') +
    `</svg>`
  );
}
