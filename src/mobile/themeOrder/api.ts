import type { OneSatContext } from '@1sat/actions';
import type { WalletInterface } from '@bsv/sdk';
import { Utils } from '@bsv/sdk';
import { BWALLET_PAYMAIL_API } from '../names/config';
import type { Fetch } from '../names/names';
import { signRequest } from '../names/paymail';
import { NO_SEND, releasePayment } from '../chat/roomSpend';
import type { MyOrder, OrderForm } from './form';

/**
 * Client for the theme order server (site/api/theme-orders.js). Every call is signed by the identity key
 * (same BRC-43 scheme as the paymail writes). Payment: the server's quote → ONE approval sheet → the wallet
 * builds the tx without sending it → claim (the server checks outputs + memo, then broadcasts). If the claim
 * fails the unsent tx is dropped, so no money moves.
 */

type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

export class ThemeOrderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Orders are closed until the owner sets THEME_ORDER_PAY_ADDRESS on the server. */
export const isNotConfigured = (e: unknown) => e instanceof ThemeOrderError && e.code === 'not_configured';

const MESSAGES: Record<string, string> = {
  not_configured: 'Orders open soon',
  slug_taken: 'That web address is taken. Try another.',
  slug_reserved: 'That web address is reserved.',
  price_unavailable: "Couldn't get the BSV price. Try again in a minute.",
  quote_expired: 'That price ran out. Start again for a new one.',
  broadcast_failed: "The network didn't take the payment. Nothing was paid; try again.",
  underpaid: 'The payment was less than the price. Nothing was paid.',
  memo_missing: "The payment didn't carry the order reference. Nothing was paid.",
};

const post = async <T>(f: Fetch, op: string, body: unknown): Promise<T> => {
  if (!BWALLET_PAYMAIL_API) throw new ThemeOrderError('Orders open soon', 'not_configured', 503);
  const r = await f(`${BWALLET_PAYMAIL_API}/api/theme-orders/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = String(j?.error || `http_${r.status}`);
    throw new ThemeOrderError(MESSAGES[code] ?? code, code, r.status);
  }
  return j as T;
};

const sha256Hex = async (bytes: ArrayBuffer) =>
  Utils.toHex(Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))));

export type UploadedFile = { path: string; type: string; size: number };

export const uploadFile = async (f: Fetch, wallet: Signer, file: File): Promise<UploadedFile> => {
  const buf = await file.arrayBuffer();
  const signed = await signRequest(wallet, 'theme-orders-upload', { type: file.type, sha256: await sha256Hex(buf) });
  return post<UploadedFile>(f, 'upload', { ...signed, data: Utils.toBase64(Array.from(new Uint8Array(buf))) });
};

export interface Quote {
  quote_id: string;
  outputs: { script: string; satoshis: number }[];
  memo_hex: string;
  usd: number;
  sats: number;
  expires_at: string;
}

/** The signed fields for a new order (strings only, as signedMessage needs). */
export const quoteFields = (form: OrderForm, files: UploadedFile[]): Record<string, string> => ({
  slug: form.slug,
  name: form.name.trim(),
  brand: form.brand.trim(),
  isBrand: form.isBrand ? '1' : '0',
  link: form.link.trim(),
  colours: JSON.stringify(form.colours.map((c) => c.toLowerCase())),
  files: JSON.stringify(files),
  note: form.note.trim(),
  ...(form.proof ? { proof: JSON.stringify({ kind: 'paymail', value: form.proof }) } : {}),
});

export const getQuote = async (f: Fetch, wallet: Signer, fields: Record<string, string>) =>
  post<Quote>(f, 'quote', await signRequest(wallet, 'theme-orders-quote', fields));

/** Renew an edition for another year: a new quote for the same slug. */
export const getRenewQuote = (f: Fetch, wallet: Signer, slug: string) => getQuote(f, wallet, { slug, renew: slug });

/** The quote's outputs + the memo as createAction outputs. Pure. */
export const quoteOutputs = (q: Quote) => [
  ...q.outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis, outputDescription: 'Theme edition' })),
  { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Theme order reference' },
];

/** Call only after the user pressed Pay on the approval sheet. Returns the order the server recorded. */
export const payQuote = async (ctx: OneSatContext, f: Fetch, q: Quote): Promise<MyOrder> => {
  if (Date.parse(q.expires_at) < Date.now()) throw new ThemeOrderError(MESSAGES.quote_expired, 'quote_expired', 410);
  const r = await ctx.wallet.createAction({
    description: 'bWalletX theme edition',
    outputs: quoteOutputs(q),
    options: NO_SEND,
  });
  if (!r.tx || !r.txid) throw new Error('The wallet did not return the payment');
  try {
    const signed = await signRequest(ctx.wallet, 'theme-orders-claim', { quote_id: q.quote_id, txid: r.txid });
    const { order } = await post<{ order: MyOrder }>(f, 'claim', { ...signed, rawtx: Utils.toHex(r.tx) });
    return order;
  } catch (e) {
    // Drop the unsent tx only when the server surely did not broadcast it (a refusal before broadcast). On a
    // network error or 5xx it may be out: keep it, and claiming again with the same quote is safe.
    if (e instanceof ThemeOrderError && (e.status < 500 || e.code === 'broadcast_failed'))
      await releasePayment(ctx, r.txid);
    throw e;
  }
};

export const myOrders = async (f: Fetch, wallet: Signer) =>
  post<{ orders: MyOrder[]; configured: boolean }>(f, 'mine', await signRequest(wallet, 'theme-orders-mine', {}));
