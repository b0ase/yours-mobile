import { inscribe, syncAddresses, type OneSatContext } from '@1sat/actions';
import { BchatClient, defaultHttp, loadSession, saveSession, type BavatarMine } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { isNative } from '../native';
import { MINT_APP } from '../mint/mint';
import * as qr from 'qrcode';
import { bavatarSvg } from './bavatar';
import { CARD_QR, cardPaymail } from '../wallet/cardBackQr';

/** Same test as names/claimPersonal.ts (not imported: that module pulls the token stack in). */
const isFundsError = (e: string | undefined) => !!e && /insufficient|not enough|no (utxos|funds)|funds/i.test(e);

/**
 * Minting a bAvatar (owner, 11 Oct 2026): the account's art QR (its paymail, scannable by any phone
 * camera) with "$handle · bWalletX #001" inscribed as a 1-sat ordinal in the account's own wallet.
 * The number is signup order (bChatX /api/bitsign/bavatar/mine). Accounts #1–#1,000 are the Founding
 * 1,000: bCorp pays their network fee (/api/bitsign/bavatar/sponsor, once per account), the same
 * gift-then-mint pattern as the personal token (names/claimPersonal.ts). One mint per account: the
 * server records it (/api/bitsign/bavatar/minted) and the sheet then shows "Minted".
 */

export const FOUNDING = 1000;
/** The card-back art QR is ~158 KB of SVG (one rounded path per module); this compact one is ~25 KB. */
export const MAX_BAVATAR_BYTES = 40_000;

/** #001 under 1,000, plain digits after: `bavatarNumber(7)` → `#007`, `bavatarNumber(1234)` → `#1234`. */
export const bavatarNumber = (n: number) => '#' + (n < FOUNDING ? String(n).padStart(3, '0') : String(n));

/** "$alice · bWalletX #007", the inscription's MAP name and the sheet's title line. */
export const bavatarLabel = (handle: string, n: number) => `$${handle} · bWalletX ${bavatarNumber(n)}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PALE = '#fff3cf',
  INK = '#0b0a08';
const KEY_RE = /^0[23][0-9a-f]{64}$/;

/**
 * A compact art QR for the inscription: the same blend and the same code as the card back (CARD_QR
 * dot size and wash), drawn in module units so it stays small. The plain bAvatar underneath, a pale
 * wash, light and dark modules as dots (one relative path per colour), solid finders.
 * Square dots instead of rounded ones: that is the only visual difference from the card back.
 */
export function compactArtQrSvg(identityKey: string, paymail: string, S = 512): string {
  const m = qr.create(paymail, { errorCorrectionLevel: 'H' }).modules;
  const n = m.size,
    quiet = 3,
    cell = S / (n + quiet * 2),
    off = quiet * cell;
  const art = bavatarSvg(identityKey, { size: 512 })
    .replace(/^<\?xml[^>]*>\s*/, '')
    .replace(/^<svg\b[^>]*?>/, (tag) => tag.replace(/\s(width|height)="[^"]*"/g, ''))
    .replace(
      /^<svg\b/,
      `<svg x="${off.toFixed(2)}" y="${off.toFixed(2)}" width="${(n * cell).toFixed(2)}" height="${(n * cell).toFixed(2)}"`,
    );
  const finder = (x: number, y: number) => (x < 8 && y < 8) || (x >= n - 8 && y < 8) || (x < 8 && y >= n - 8);
  const d = CARD_QR.dot,
    i = (1 - d) / 2;
  const f = (v: number) => String(+v.toFixed(3)).replace(/^0\./, '.').replace(/^-0\./, '-.');
  // Both colours as dots, one relative path each, so the art shows in the gaps (as on the card back).
  const dots = (dark: boolean) => {
    let out = 'M0 0',
      px = 0,
      py = 0;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (finder(x, y) || !!m.get(y, x) !== dark) continue;
        out += `m${f(x + i - px)} ${f(y + i - py)}h${f(d)}v${f(d)}h${f(-d)}z`;
        px = x + i;
        py = y + i;
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
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">` +
    `<rect width="${S}" height="${S}" fill="${PALE}"/>` +
    art +
    `<g transform="translate(${f(off)} ${f(off)}) scale(${f(cell)})">` +
    `<rect width="${n}" height="${n}" fill="${PALE}" fill-opacity="${CARD_QR.lift}"/>` +
    `<path d="${dots(false)}" fill="${PALE}"/>` +
    `<path d="${dots(true)}" fill="${INK}"/>` +
    finders +
    '</g></svg>'
  );
}

/**
 * The inscription: a 512×640 card. The art QR on top (encodes name@bwalletx.com), then the handle,
 * the number and, for #1–#1,000, FOUNDING 1,000. '' when the account has no identity key or paymail.
 */
export function bavatarMintSvg(identityKey: string, handle: string, number: number): string {
  const key = String(identityKey).toLowerCase();
  const pm = cardPaymail(handle);
  if (!KEY_RE.test(key) || !pm) return '';
  const inner = compactArtQrSvg(key, pm, 512).replace(/^<svg\b/, '<svg x="0" y="0"');
  const founding = number <= FOUNDING;
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 640" width="512" height="640">' +
    `<rect width="512" height="640" fill="${INK}"/>` +
    inner +
    '<g font-family="Helvetica,Arial,sans-serif" text-anchor="middle">' +
    `<text x="256" y="566" font-size="34" font-weight="700" fill="#ffd24d">$${esc(handle)}</text>` +
    `<text x="256" y="604" font-size="22" font-weight="600" fill="#f1ead9">bWalletX ${esc(bavatarNumber(number))}</text>` +
    (founding
      ? '<text x="256" y="630" font-size="13" font-weight="700" letter-spacing="3" fill="#c58b12">FOUNDING 1,000</text>'
      : '') +
    '</g></svg>'
  );
}

/** What the sheet offers. */
export type MintOffer =
  | { kind: 'minted'; txid: string }
  | { kind: 'free' } // Founding 1,000, fee paid by bWalletX
  | { kind: 'paid' }; // #1,001 on, the user pays the network fee

export function mintOffer(mine: BavatarMine): MintOffer {
  if (mine.minted) return { kind: 'minted', txid: mine.minted.txid };
  return mine.founding && mine.number <= FOUNDING ? { kind: 'free' } : { kind: 'paid' };
}

/** Ask for the sponsor gift only for an unsponsored founder whose wallet couldn't pay. */
export const shouldSponsor = (mine: BavatarMine, error: string | undefined) =>
  isFundsError(error) && mine.founding && mine.number <= FOUNDING && !mine.sponsored && !mine.minted;

export async function bavatarClient(ctx: OneSatContext): Promise<BchatClient> {
  const client = new BchatClient(defaultHttp(isNative), loadSession());
  if (!client.handle) saveSession(await client.signIn(walletSigner(ctx)));
  return client;
}

const SPONSOR_WAIT_MS = 2000;
const SPONSOR_TRIES = 6;

/** Base64 of an ASCII/UTF-8 string, without Buffer (runs in the extension and on phones). */
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** Inscribe this account's bAvatar. Returns the txid. Throws with a readable message on failure. */
export async function mintBavatar(
  ctx: OneSatContext,
  input: { identityKey: string; payAddress: string; mine: BavatarMine; client?: BchatClient },
): Promise<string> {
  const { mine } = input;
  if (mine.minted) return mine.minted.txid;
  const handle = cardPaymail(mine.handle).split('@')[0];
  const svg = bavatarMintSvg(input.identityKey, handle, mine.number);
  if (!svg) throw new Error('This account needs a $name before it can mint its bAvatar.');
  if (new TextEncoder().encode(svg).length > MAX_BAVATAR_BYTES) throw new Error('bAvatar image too large');

  const run = () =>
    inscribe.execute(ctx, {
      base64Content: b64(svg),
      contentType: 'image/svg+xml',
      map: {
        app: MINT_APP,
        type: 'bavatar',
        name: bavatarLabel(handle, mine.number),
        handle,
        number: String(mine.number),
        edition: mine.number <= FOUNDING && mine.founding ? 'Founding 1,000' : 'bWalletX',
      },
    });

  const client = input.client ?? (await bavatarClient(ctx));
  let res = await run();
  if (shouldSponsor(mine, res.error) && input.payAddress) {
    await client.sponsorBavatar(input.payAddress);
    for (let i = 0; i < SPONSOR_TRIES && isFundsError(res.error); i++) {
      await new Promise((ok) => setTimeout(ok, SPONSOR_WAIT_MS));
      await syncAddresses.execute(ctx, { count: 5 }).catch(() => undefined);
      res = await run();
    }
  }
  if (res.error || !res.txid) throw new Error(res.error || 'bAvatar mint failed');
  // The ordinal is in the wallet either way; recording only marks the number as minted.
  await client.recordBavatarMint(res.txid).catch(() => undefined);
  return res.txid;
}
