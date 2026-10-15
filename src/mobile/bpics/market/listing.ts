/**
 * bPics photographers' market (owner direction 15 Oct 2026) — the listing rules. PURE: no wallet, no network,
 * no React (listing.test.ts). The server side is bit-sign src/lib/bpics.ts; the MAP fields, limits, protocols
 * and the claim message must stay identical on both sides.
 *
 * A photo listing is one mint transaction:
 *   vout 0  the public preview: reduced (≤ PREVIEW_EDGE px) + watermarked JPEG, MAP app=bwalletx type=photo
 *           name, tags, licence, price (sats), pay (creator's address), paymail, idKey (creator's identity key),
 *           nonce (derives the content key, crypto.ts);
 *   vout 1  the full-resolution photo sealed with AES-256-GCM (iv | ciphertext+tag), MAP type=photo-sealed.
 * Buyers pay the creator directly and get the content key from bit-sign after it sees the payment (api.ts).
 */
import { fiatToUsd, type Fx } from '../../../utils/displayCurrency';
import { usdToSats } from '../../money/money';

export const BPICS_MARKET_APP = 'bwalletx';
export const PHOTO_TYPE = 'photo';
export const SEALED_TYPE = 'photo-sealed';
export const SEALED_CONTENT_TYPE = 'application/octet-stream';
export const LICENCES = ['personal', 'commercial'] as const;
export type Licence = (typeof LICENCES)[number];
export const LICENCE_TEXT: Record<Licence, string> = {
  personal: 'Personal use: prints, wallpaper, your own non-commercial posts. No resale, no ads.',
  commercial: 'Commercial use: ads, products, client work. No resale of the file itself.',
};

export const MIN_PRICE_SATS = 1_000;
export const MAX_PRICE_SATS = 100_000_000;
export const MAX_TAGS = 8;
export const TITLE_MAX = 100;
/** Longest side of the public preview, and the watermark text drawn on it. */
export const PREVIEW_EDGE = 1024;
export const PREVIEW_QUALITY = 0.72;
export const WATERMARK = 'bPics preview';
/** The full-resolution file sealed on chain: keep it a sane size to mint (~a few cents per MB). */
export const MAX_FULL_BYTES = 12 * 1024 * 1024;

export type PriceInput = { unit: 'fiat' | 'sats'; value: string };

/** A price field → whole sats. Fiat is the display currency (£ or $), converted at the BSV rate (USD/BSV). */
export function priceToSats(p: PriceInput, rateUsdPerBsv: number, fx: Fx): number | null {
  const t = p.value.trim().replace(/^[£$]/, '').replace(/,/g, '');
  if (!/^\d*(\.\d{0,8})?$/.test(t) || !/\d/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (p.unit === 'sats') return Number.isInteger(n) ? n : null;
  return usdToSats(fiatToUsd(n, fx), rateUsdPerBsv);
}

export function cleanTags(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(/[,\s#]+/)) {
    const c = t
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 24);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export type PhotoForm = {
  title: string;
  tags: string;
  licence: Licence;
  priceSats: number | null;
};

export function validatePhoto(f: PhotoForm, fullBytes: number): string | null {
  if (!f.title.trim()) return 'Give the photo a title.';
  if (f.title.trim().length > TITLE_MAX) return `Keep the title under ${TITLE_MAX} characters.`;
  if (!LICENCES.includes(f.licence)) return 'Choose a licence.';
  if (f.priceSats === null) return 'Set a price.';
  if (f.priceSats < MIN_PRICE_SATS) return `The lowest price is ${MIN_PRICE_SATS.toLocaleString('en-US')} sats.`;
  if (f.priceSats > MAX_PRICE_SATS) return 'The highest price is 1 BSV.';
  if (fullBytes > MAX_FULL_BYTES) return 'That photo is over 12 MB. Export a smaller JPEG and try again.';
  return null;
}

/** The preview inscription's MAP (vout 0). */
export function buildPhotoMap(
  f: PhotoForm,
  who: { pay: string; paymail: string; idKey: string },
  nonceHex: string,
): Record<string, string> {
  if (f.priceSats === null) throw new Error('Set a price.');
  return {
    app: BPICS_MARKET_APP,
    type: PHOTO_TYPE,
    name: f.title.trim().slice(0, TITLE_MAX),
    tags: cleanTags(f.tags).join(','),
    licence: f.licence,
    price: String(f.priceSats),
    pay: who.pay,
    paymail: who.paymail,
    idKey: who.idKey.toLowerCase(),
    nonce: nonceHex.toLowerCase(),
  };
}
export const SEALED_MAP: Record<string, string> = { app: BPICS_MARKET_APP, type: SEALED_TYPE };

/** OP_RETURN on a purchase: binds the payment to this photo and this buyer (bit-sign verifyPurchase). */
export const purchaseTag = (itemId: string, buyerKey: string) => ['bpics', 'buy', itemId, buyerKey.toLowerCase()];

/** sendBsv requests for one purchase: the full price to the photographer + the tag. No bCorp fee. */
export const purchaseRequests = (item: { id: string; pay_address: string; price_sats: number }, buyerKey: string) => [
  { address: item.pay_address, satoshis: item.price_sats },
  { data: purchaseTag(item.id, buyerKey), satoshis: 0 },
];

/** The exact text signed (BSM) with the posting address's key to claim existing chain photos. */
export const claimMessage = (address: string, identityKey: string, issuedAt: string) =>
  `bPics claim\naddress: ${address}\nidentity: ${identityKey.toLowerCase()}\nissued: ${issuedAt}`;

// ── Server items (bit-sign /api/bitsign/bpics/feed) ──

export type Status = 'pending' | 'needs_review' | 'escalated' | 'approved' | 'rejected' | 'removed';
export type MarketItem = {
  id: string;
  source: 'mint' | 'claim';
  creatorKey: string;
  payAddress: string | null;
  paymail: string | null;
  title: string;
  tags: string[];
  licence: Licence | null;
  priceSats: number | null;
  previewType: string;
  status: Status;
  paidSats: number;
  createdAt: number;
};

const OUTPOINT = /^[0-9a-f]{64}_\d{1,6}$/i;
const PUBKEY = /^0[23][0-9a-f]{64}$/i;
const SAFE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif)$/i;
const STATUSES: Status[] = ['pending', 'needs_review', 'escalated', 'approved', 'rejected', 'removed'];
const s = (v: unknown, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export function parseItem(r: unknown): MarketItem | null {
  const o = (r ?? {}) as Record<string, unknown>;
  const id = s(o.id, 80).toLowerCase();
  const creatorKey = s(o.creator_key, 66).toLowerCase();
  const previewType = s(o.preview_type, 40).toLowerCase();
  const status = s(o.status, 20) as Status;
  if (!OUTPOINT.test(id) || !PUBKEY.test(creatorKey) || !SAFE_IMAGE.test(previewType) || !STATUSES.includes(status))
    return null;
  const price = Number(o.price_sats);
  const licence = s(o.licence, 20) as Licence;
  return {
    id,
    source: o.source === 'claim' ? 'claim' : 'mint',
    creatorKey,
    payAddress: s(o.pay_address, 40) || null,
    paymail: s(o.paymail, 120) || null,
    title: s(o.title, TITLE_MAX) || 'Photo',
    tags: Array.isArray(o.tags)
      ? o.tags
          .map((t) => s(t, 24))
          .filter(Boolean)
          .slice(0, MAX_TAGS)
      : [],
    licence: LICENCES.includes(licence) ? licence : null,
    priceSats: Number.isInteger(price) && price >= MIN_PRICE_SATS ? price : null,
    previewType,
    status,
    paidSats: Math.max(0, Math.floor(Number(o.paid_sats) || 0)),
    createdAt: Date.parse(s(o.created_at, 40)) || 0,
  };
}

export const parseItems = (data: unknown): MarketItem[] => {
  const rows = (data as { items?: unknown } | null)?.items;
  return Array.isArray(rows) ? rows.map(parseItem).filter((x): x is MarketItem => !!x) : [];
};

/** Public feed: approved only (the server already filters; this is belt and braces), by total paid, then newest. */
export const rankedFeed = (items: MarketItem[]): MarketItem[] =>
  items.filter((i) => i.status === 'approved').sort((a, b) => b.paidSats - a.paidSats || b.createdAt - a.createdAt);

export const forSale = (i: MarketItem) => i.source === 'mint' && !!i.payAddress && !!i.priceSats;

export const STATUS_LABEL: Record<Status, string> = {
  pending: 'Checking',
  needs_review: 'In review',
  escalated: 'In review',
  approved: 'Live',
  rejected: 'Not accepted',
  removed: 'Removed',
};

export const REPORT_REASONS = [
  ['child_safety', 'A child may be at risk'],
  ['nudity', 'Nudity or sexual content'],
  ['violence', 'Violence or gore'],
  ['stolen', 'Not their photo'],
  ['spam', 'Spam'],
  ['other', 'Something else'],
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number][0];
