import * as qr from 'qrcode';
import { bavatarArtQrSvg } from '../bavatar/bavatar';

/**
 * The QR on the back of the wallet card (owner, 11 Oct 2026): the account's bAvatar art QR, the same
 * blend as its avatar seen through a real QR grid, encoding its paymail. Any phone camera reads it as
 * `name@bwalletx.com`. Built here from the identity key, no network.
 *
 * An account with no paymail yet keeps the plain receive QR (BIP21), so the back always has something
 * that pays this wallet.
 */

/** Tuned 11 Oct 2026: 48/48 ZXing decodes over 12 names × 4 sizes (0.62/0.18 with the pip: 0/48). */
export const CARD_QR = { dot: 0.78, lift: 0.5, pip: false } as const;

const KEY_RE = /^0[23][0-9a-f]{64}$/;
const ALIAS_RE = /^[a-z0-9]([a-z0-9_.-]{0,30}[a-z0-9])?$/;

/** `vexvoid`, `$vexvoid` or `vexvoid@bwalletx.com` → `vexvoid@bwalletx.com`; anything else → ''. */
export function cardPaymail(paymail: string | null | undefined): string {
  let p = String(paymail ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\$/, '');
  if (!p) return '';
  if (!p.includes('@')) p = `${p}@bwalletx.com`;
  const [alias, domain] = p.split('@');
  if (!alias || !domain || !ALIAS_RE.test(alias) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return '';
  return `${alias}@${domain}`;
}

/** The art QR as an SVG string, or '' when this account can't have one (no paymail or no identity key). */
export function cardArtQrSvg(
  identityPubKey: string | null | undefined,
  paymail: string | null | undefined,
  size = 512,
): string {
  const key = String(identityPubKey ?? '').toLowerCase();
  const pm = cardPaymail(paymail);
  if (!KEY_RE.test(key) || !pm) return '';
  const matrix = qr.create(pm, { errorCorrectionLevel: 'H' }).modules;
  // Bigger dots, a paler wash and no gold pip in the finders: every decoder we test (ZXing, jsQR at
  // camera sizes, zbar) reads it, not only phone cameras. The bChatX art QR keeps the lighter look.
  return bavatarArtQrSvg(key, pm, matrix, { size, ...CARD_QR });
}

export const svgDataUri = (svg: string) => (svg ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) : '');
