/**
 * Store receipts (owner 17 Oct 2026: "we promised receipts; I should have a signed, printed NFT receipt").
 *
 * The Store's quote carries a receipt it signed (site/lib/storeReceipt.js). The wallet inscribes it as a 1-sat SVG
 * card in the SAME transaction that pays (themeOrder/api.ts payBuyQuote), to the wallet's own ordinals, so it shows
 * in Collectibles. As with lock receipts (locks/receipt.ts) the JSON sits in a <metadata> element and in the MAP.
 *
 * A picture proves nothing on its own. checkStoreReceipt checks three things: the Store's signature over the
 * receipt (canonical JSON, ECDSA secp256k1 over sha256), that the signer is the key bwalletx.com publishes, and that
 * the transaction holding the receipt pays the seller at least the receipt's price with the order's reference.
 */
import { P2PKH, PublicKey, Script, Signature, Transaction, Utils } from '@bsv/sdk';
import { inscriptionOf } from '../locks/receipt';

export const STORE_RECEIPT_TYPE = 'store-receipt';

/** Is this wallet output a Store receipt (themeOrder/api.ts tags it)? */
export const isStoreReceipt = (tags: readonly string[] | undefined) => !!tags?.includes(STORE_RECEIPT_TYPE);
const MEMO_TAG = 'bwx-theme-buy';

export type StoreReceipt = {
  app: 'bwalletx';
  type: typeof STORE_RECEIPT_TYPE;
  v: 1;
  /** The Store's order reference (the quote id; also in the payment's OP_RETURN). */
  order: string;
  item: { kind: string; id: string; label: string };
  usd: number;
  sats: number;
  /** The address the Store is paid at. */
  seller: string;
  /** The buyer's identity key. */
  buyer: string;
  issuedAt: string;
  /** The Store's public key and its signature over everything else. Absent when the Store isn't signing yet. */
  signer?: string;
  sig?: string;
};

/** JSON with object keys sorted at every level (the exact bytes the Store signs; mirrors site/lib/storeReceipt.js). */
export const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

/** True when `sig` is a valid signature by `signer` over the rest of the receipt. */
export function signatureValid(r: StoreReceipt): boolean {
  if (typeof r.sig !== 'string' || typeof r.signer !== 'string') return false;
  try {
    const { sig, ...body } = r;
    return PublicKey.fromString(r.signer).verify(Utils.toArray(canonical(body), 'utf8'), Signature.fromDER(sig, 'hex'));
  } catch {
    return false;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }) + ' UTC';
};
const usdText = (n: number) => `$${n.toFixed(n % 1 ? 2 : 0)}`;
const short = (s: string, a = 10, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

/** Receipt art: a small inline picture (data URI, PNG/JPEG/WebP, at most ART_MAX_BYTES) so the inscription stays small. */
export const ART_MAX_BYTES = 60_000;
export const artOk = (art: string | null | undefined): art is string => {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(art ?? '');
  return !!m && Math.floor((m[2].length * 3) / 4) <= ART_MAX_BYTES;
};

/**
 * The printed card: what was bought, the price, when, the order, the buyer and the Store's signature. `art` is the
 * shop's picture (owner 17 Oct: an NPG purchase gets NPG art). It is presentation only: the signed JSON in the
 * <metadata> is identical with or without it, and without valid art the card is plain bWalletX gold.
 */
export function storeReceiptSvg(r: StoreReceipt, art?: string | null): string {
  const lines: [string, number, string][] = [];
  const add = (text: string, size = 17, color = '#F2F2F0') => lines.push([text, size, color]);
  add(`${r.item.label} theme`, 26, '#F2F2F0');
  add(`${r.sats.toLocaleString('en-US')} sats`, 17, '#98A2B3');
  add(fmtDate(r.issuedAt));
  add(`Order ${r.order}`, 14, '#98A2B3');
  add(`Paid to ${r.seller}`, 13, '#98A2B3');
  add(`Buyer ${short(r.buyer, 14, 8)}`, 13, '#98A2B3');
  add(
    r.sig ? `Signed by bWalletX Store · ${short(r.sig, 12, 8)}` : 'Not signed by the Store',
    15,
    r.sig ? '#F5B800' : '#98A2B3',
  );
  let y = 195;
  const body = lines
    .map(([t, size, color]) => {
      const out = `<text x="40" y="${y}" fill="${color}" font-size="${size}">${esc(t)}</text>`;
      y += size + 14;
      return out;
    })
    .join('');
  const h = y + 60;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${h}" viewBox="0 0 640 ${h}"><metadata id="store-receipt">${esc(JSON.stringify(r))}</metadata><rect width="640" height="${h}" rx="28" fill="#0b0b0c"/><rect x="10" y="10" width="620" height="${h - 20}" rx="22" fill="none" stroke="#F5B800" stroke-width="2"/><g font-family="Helvetica,Arial,sans-serif">${artOk(art) ? `<image x="456" y="36" width="148" height="148" preserveAspectRatio="xMidYMid meet" href="${art}"/>` : ''}<text x="40" y="70" fill="#F5B800" font-size="22" font-weight="700">bWalletX Store · Receipt</text><text x="40" y="140" fill="#F2F2F0" font-size="52" font-weight="800">${esc(usdText(r.usd))}</text>${body}<text x="40" y="${h - 32}" fill="#667085" font-size="13">Thank you. Check this receipt in bWalletX › Collectibles.</text></g></svg>`;
}

/** MAP fields for the inscription (MAP values are strings). */
export const storeReceiptMap = (r: StoreReceipt): Record<string, string> => ({
  app: 'bwalletx',
  type: STORE_RECEIPT_TYPE,
  name: `bWalletX receipt · ${r.item.label}`,
  receipt: JSON.stringify(r),
});

const isReceipt = (r: unknown): r is StoreReceipt => {
  const o = r as StoreReceipt;
  return !!o && o.type === STORE_RECEIPT_TYPE && typeof o.order === 'string' && !!o.item && typeof o.sats === 'number';
};

/** Read a receipt from SVG text (an inscription's content); null if it is not one of ours. */
export function parseStoreReceiptSvg(svg: string): StoreReceipt | null {
  const m = /<metadata id="store-receipt">([\s\S]*?)<\/metadata>/.exec(svg);
  if (!m) return null;
  try {
    const r = JSON.parse(m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))));
    return isReceipt(r) ? r : null;
  } catch {
    return null;
  }
}

/** Read a receipt from an inscription script. */
export function parseStoreReceipt(script: Script): StoreReceipt | null {
  const ins = inscriptionOf(script);
  if (!ins || !ins.contentType.startsWith('image/svg')) return null;
  return parseStoreReceiptSvg(Utils.toUTF8(ins.content));
}

const memoHex = (order: string) =>
  new Script()
    .writeOpCode(0) // OP_FALSE
    .writeOpCode(0x6a) // OP_RETURN
    .writeBin(Utils.toArray(MEMO_TAG, 'utf8'))
    .writeBin(Utils.toArray(order, 'utf8'))
    .toHex();

export type ReceiptCheck = {
  receipt: StoreReceipt | null;
  /** Signed, by the published Store key, and the transaction carries the payment it describes. */
  verified: boolean;
  /** Each check in words, for the detail view. */
  checks: { label: string; ok: boolean }[];
};

/**
 * Check a receipt against the transaction that holds it. `storeKey` is the Store's published public key
 * (null when unknown/unpublished: then the signature can't be trusted and the receipt is not "verified").
 */
export function checkStoreReceipt(tx: Transaction, storeKey: string | null): ReceiptCheck {
  const receipt = tx.outputs.map((o) => parseStoreReceipt(o.lockingScript)).find(Boolean) ?? null;
  if (!receipt) return { receipt: null, verified: false, checks: [] };
  const sellerScript = new P2PKH().lock(receipt.seller).toHex();
  const paid = tx.outputs
    .filter((o) => o.lockingScript.toHex() === sellerScript)
    .reduce((s, o) => s + Number(o.satoshis ?? 0), 0);
  const checks = [
    { label: 'Signed by the Store', ok: signatureValid(receipt) },
    { label: 'Signed with bWalletX Store’s published key', ok: !!storeKey && receipt.signer === storeKey },
    { label: `Pays the Store ${receipt.sats.toLocaleString('en-US')} sats`, ok: paid >= receipt.sats },
    {
      label: 'Carries the order reference',
      ok: tx.outputs.some((o) => o.lockingScript.toHex() === memoHex(receipt.order)),
    },
  ];
  return { receipt, verified: checks.every((c) => c.ok), checks };
}

/** The Store's published receipt key (GET /api/theme-orders/store-key); null when unpublished or unreachable. */
export async function fetchStoreKey(base: string, f: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await f(`${base}/api/theme-orders/store-key`);
    if (!r.ok) return null;
    const j = (await r.json()) as { signer?: unknown };
    return typeof j.signer === 'string' && /^0[23][0-9a-f]{64}$/i.test(j.signer) ? j.signer.toLowerCase() : null;
  } catch {
    return null;
  }
}
