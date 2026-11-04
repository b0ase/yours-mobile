import { buildOrdinalCustomInstructions, ORDINALS_BASKET, P1SAT_PROTOCOL, type OneSatContext } from '@1sat/actions';
import { buildInscriptionScript } from '@1sat/templates';
import { guardedPay, scriptAddress, type Shown } from '../../services/guardedPay';
import type { WalletInterface } from '@bsv/sdk';
import { P2PKH, PublicKey, Random, Utils } from '@bsv/sdk';
import { storeReceiptMap, storeReceiptSvg, STORE_RECEIPT_TYPE, type StoreReceipt } from '../storeReceipt/receipt';
import { BWALLET_PAYMAIL_API } from '../names/config';
import type { Fetch } from '../names/names';
import { signRequest } from '../names/paymail';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { chainHasSeen, chainLookups, sendThroughWallet, type UnsentWallet } from '../../services/unsentGuard';
import type { MyOrder, OrderForm } from './form';
import {
  localOutbox,
  pruneOutbox,
  sendStorePayment,
  signStorePayment,
  StorePayError,
  type BackupAnswer,
  type OutboxEntry,
  type StorePayDeps,
} from './storePay';

/**
 * Client for the theme order server (site/api/theme-orders.js). Every call is signed by the identity key
 * (same BRC-43 scheme as the paymail writes). Payment (P0, 3 Nov 2026; storePay.ts): the server's quote → ONE approval
 * sheet → the wallet signs the payment and stores it unsent → its rows are backed up → the WALLET broadcasts it →
 * claim (the server checks outputs + memo, records the txid, and answers paid only once the network has it, else
 * 202 pending). Nothing is ever aborted once signed; a payment that couldn't go out is kept and finished later.
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
  already_owned: 'You already own this theme.',
  payment_pending: 'Your payment for this theme is still on its way to the network. It unlocks when it arrives.',
  pack_not_for_sale: "This theme isn't for sale.",
};

/** The wallet's backup push (background STORE_BACKUP_BEFORE_SEND, services/deviceSync.ts). Fails closed. */
export const backupThroughWallet = async (): Promise<BackupAnswer> => {
  try {
    const r = await sendMessageAsync<{ success?: boolean; error?: string } | undefined>({
      action: 'STORE_BACKUP_BEFORE_SEND',
    });
    return r?.success ? { ok: true } : { ok: false, error: r?.error ?? 'No answer from the wallet' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/** The app's Store payment deps: the background backup push and this device's outbox for this identity. */
export const defaultStorePayDeps = async (wallet: Pick<WalletInterface, 'getPublicKey'>): Promise<StorePayDeps> => {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  return { backup: backupThroughWallet, outbox: localOutbox(publicKey) };
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

/** A $1 store theme; nothing near this is a real price. Editions ($99 a year) get a larger ceiling. */
export const MAX_THEME_BUY_SATS = 20_000_000;
export const MAX_EDITION_SATS = 1_000_000_000;

/** What the Pay sheet shows for a quote: each output as address + sats (refuses a non-P2PKH payment). */
export const quoteShown = (q: Quote): Shown[] =>
  q.outputs.filter((o) => o.satoshis > 1).map((o) => ({ address: scriptAddress(o.script), sats: o.satoshis }));

/** The quote's outputs + the memo as createAction outputs. Pure. */
export const quoteOutputs = (q: Quote) => [
  ...q.outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis, outputDescription: 'Theme edition' })),
  { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Theme order reference' },
];

/** A paid edition the network hasn't shown yet: not paid until it does (the server rechecks on `mine`). */
export type PaidOrder = MyOrder & { pending?: boolean };

/**
 * Call only after the user pressed Pay on the approval sheet. Returns the order the server recorded (`pending` while
 * the network hasn't shown the payment). The payment is signed, backed up, then broadcast by the wallet (storePay.ts).
 */
export const payQuote = async (
  ctx: OneSatContext,
  f: Fetch,
  q: Quote,
  opts: { deps?: StorePayDeps } = {},
): Promise<PaidOrder> => {
  const deps = opts.deps ?? (await defaultStorePayDeps(ctx.wallet));
  // The same quote already signed (its backup failed) or sent: finish that payment, never sign a second one.
  const kept = pruneOutbox(deps.outbox, now(deps)).find((e) => e.kind === 'order' && e.key === q.quote_id);
  if (kept) return finishOrder(ctx, f, kept, deps);
  if (Date.parse(q.expires_at) < Date.now()) throw new ThemeOrderError(MESSAGES.quote_expired, 'quote_expired', 410);
  const outputs = quoteOutputs(q);
  const signed = await guardedPay(
    { outputs, shown: quoteShown(q), trust: { kind: 'pinned' }, maxSats: MAX_EDITION_SATS },
    () => signStorePayment(ctx.wallet as never, { description: 'bWalletX theme edition', outputs }),
  );
  const entry: OutboxEntry = {
    kind: 'order',
    quoteId: q.quote_id,
    txid: signed.txid,
    beefHex: signed.beefHex,
    key: q.quote_id,
    label: 'theme edition',
    state: 'signed',
    at: now(deps),
  };
  deps.outbox.put(entry);
  return finishOrder(ctx, f, entry, deps);
};

const now = (deps: StorePayDeps) => (deps.now ?? Date.now)();

/**
 * Send (if not sent yet) and claim one Store payment. `claimOp` posts the claim; its answer has `pending` on a 202.
 * Returns the server's body, with `pending: true` when not confirmed yet. Throws StorePayError before anything was
 * paid (backup failed, refused), a ThemeOrderError with sent=true when the Store won't take a payment that went out.
 */
async function sendAndClaim<T extends { pending?: boolean }>(
  ctx: OneSatContext,
  entry: OutboxEntry,
  deps: StorePayDeps,
  claimOp: () => Promise<T>,
): Promise<T | { pending: true; unconfirmed: true }> {
  if (entry.state === 'signed' || entry.state === 'sending')
    await sendStorePayment(ctx.wallet as unknown as UnsentWallet, entry, deps);
  const sentEntry: OutboxEntry = { ...entry, state: 'sent' };
  try {
    const claimed = await claimOp();
    if (claimed.pending) deps.outbox.put({ ...sentEntry, state: 'pending', claimedAt: now(deps) });
    else deps.outbox.drop(entry.txid);
    return claimed;
  } catch (e) {
    // The money has left the wallet: keep it, claim again later (Store open), and never say "nothing was paid".
    deps.outbox.put({ ...sentEntry, claimedAt: now(deps) });
    const status = (e as { status?: number }).status;
    if (e instanceof ThemeOrderError && status && status >= 400 && status < 500) {
      const err = new ThemeOrderError(
        `Your payment was sent (${entry.txid.slice(0, 10)}…), but the Store couldn't match it to your order (${e.code}). It's recorded; please contact support with this reference.`,
        e.code,
        status,
      );
      (err as ThemeOrderError & { sent?: boolean }).sent = true;
      throw err;
    }
    return { pending: true, unconfirmed: true };
  }
}

async function finishOrder(ctx: OneSatContext, f: Fetch, entry: OutboxEntry, deps: StorePayDeps): Promise<PaidOrder> {
  const r = await sendAndClaim(ctx, entry, deps, async () => {
    const signed = await signRequest(ctx.wallet, 'theme-orders-claim', { quote_id: entry.quoteId, txid: entry.txid });
    return post<{ order: MyOrder; pending?: boolean }>(f, 'claim', { ...signed, rawtx: entry.beefHex });
  });
  if ('order' in r && r.order) return { ...r.order, ...(r.pending ? { pending: true } : {}) };
  return {
    id: entry.quoteId,
    slug: '',
    name: null,
    status: 'paid',
    renews: null,
    expires_at: null,
    txid: entry.txid,
    created_at: null,
    pending: true,
  };
}

export const myOrders = async (f: Fetch, wallet: Signer) =>
  post<{ orders: MyOrder[]; configured: boolean }>(f, 'mine', await signRequest(wallet, 'theme-orders-mine', {}));

/** Store theme purchases ($1 each, site/lib/themeBuys.js): the same quote → one approval → claim flow. */
export interface BuyQuote extends Quote {
  pack: string;
  /** The Store's receipt for this order (site/lib/storeReceipt.js), signed when the Store key is set. */
  receipt?: StoreReceipt;
}
export const getBuyQuote = async (f: Fetch, wallet: Signer, pack: string) =>
  post<BuyQuote>(f, 'buy-quote', await signRequest(wallet, 'theme-buy-quote', { pack }));

export type BuyResult = {
  pack: string;
  txid: string;
  receipt?: StoreReceipt;
  receiptSvg?: string;
  /** Sent, but the network (or the Store) hasn't confirmed it yet: not owned until it does (Store › owned rechecks). */
  pending?: boolean;
};

/**
 * The receipt inscription (storeReceipt/receipt.ts): a 1-sat SVG card to a fresh key of the wallet's own ordinals,
 * as lock receipts and @1sat/actions inscribe do, so it shows in Collectibles. `art` is the shop's picture.
 */
async function receiptOutput(ctx: OneSatContext, r: StoreReceipt, art: string | null) {
  const keyID = `inscribe-${Utils.toHex(Random(8))}`;
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID,
    counterparty: 'self',
    forSelf: true,
  });
  const dest = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress());
  const svg = storeReceiptSvg(r, art);
  const tags = ['type:image/svg+xml', 'origin', STORE_RECEIPT_TYPE];
  const name = `bWalletX receipt · ${r.item.label}`;
  return {
    svg,
    output: {
      lockingScript: buildInscriptionScript(
        dest,
        new TextEncoder().encode(svg),
        'image/svg+xml',
        storeReceiptMap(r),
      ).toHex(),
      satoshis: 1,
      outputDescription: 'Store receipt',
      basket: ORDINALS_BASKET,
      tags,
      customInstructions: buildOrdinalCustomInstructions({ protocolID: P1SAT_PROTOCOL, keyID, tags, name }),
    },
  };
}

/**
 * Call only after the user pressed Pay on the approval sheet. The receipt rides in the same transaction. The payment
 * is signed, backed up, then broadcast by the wallet, then claimed (storePay.ts).
 */
export const payBuyQuote = async (
  ctx: OneSatContext,
  f: Fetch,
  q: BuyQuote,
  opts: { label?: string; art?: string | null; deps?: StorePayDeps } = {},
): Promise<BuyResult> => {
  const deps = opts.deps ?? (await defaultStorePayDeps(ctx.wallet));
  // This pack already has a payment signed (its backup failed) or sent: finish that one, never sign a second.
  const kept = pruneOutbox(deps.outbox, now(deps)).find((e) => e.kind === 'buy' && e.key === q.pack);
  if (kept) return finishBuy(ctx, f, kept, deps);
  if (Date.parse(q.expires_at) < Date.now()) throw new ThemeOrderError(MESSAGES.quote_expired, 'quote_expired', 410);
  const receipt =
    q.receipt && q.receipt.order === q.quote_id ? await receiptOutput(ctx, q.receipt, opts.art ?? null) : null;
  const outputs = [
    ...q.outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis, outputDescription: 'Theme' })),
    { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Theme purchase reference' },
    ...(receipt ? [receipt.output] : []),
  ];
  const label = opts.label ?? q.receipt?.item.label ?? q.pack;
  const signed = await guardedPay(
    { outputs, shown: quoteShown(q), trust: { kind: 'pinned' }, maxSats: MAX_THEME_BUY_SATS },
    // "Theme purchase · NPG": the history labels it (wallet/txHistory.ts).
    () => signStorePayment(ctx.wallet as never, { description: `Theme purchase · ${label}`, outputs }),
  );
  const entry: OutboxEntry = {
    kind: 'buy',
    quoteId: q.quote_id,
    txid: signed.txid,
    beefHex: signed.beefHex,
    key: q.pack,
    label,
    state: 'signed',
    at: now(deps),
  };
  deps.outbox.put(entry);
  const res = await finishBuy(ctx, f, entry, deps);
  return { ...res, ...(receipt && q.receipt ? { receipt: q.receipt, receiptSvg: receipt.svg } : {}) };
};

async function finishBuy(ctx: OneSatContext, f: Fetch, entry: OutboxEntry, deps: StorePayDeps): Promise<BuyResult> {
  const r = await sendAndClaim(ctx, entry, deps, async () => {
    const signed = await signRequest(ctx.wallet, 'theme-buy-claim', { quote_id: entry.quoteId, txid: entry.txid });
    return post<{ pack: string; pending?: boolean }>(f, 'buy-claim', { ...signed, rawtx: entry.beefHex });
  });
  return { pack: entry.key, txid: entry.txid, ...(r.pending ? { pending: true } : {}) };
}

export const ownedThemes = async (f: Fetch, wallet: Signer) =>
  post<{ packs: string[]; configured: boolean }>(f, 'owned', await signRequest(wallet, 'theme-buy-owned', {}));

/** The descriptions payQuote / payBuyQuote give their payments (wallet/txHistory.ts labels them by these). */
export const STORE_PAYMENT_DESC = /^(Theme purchase · |bWalletX theme edition$)/;
const TXID_RE = /^[0-9a-f]{64}$/i;
/** A pending claim is asked again at most this often. */
export const RECLAIM_EVERY_MS = 10 * 60 * 1000;

type ActionsWallet = UnsentWallet & {
  listActions: (a: { labels: string[]; limit?: number; offset?: number }) => Promise<{
    totalActions: number;
    actions: { txid?: string; status: string; description?: string }[];
  }>;
};

let settling: Promise<SettleReport> | null = null;
export type SettleReport = { finished: string[]; pending: string[]; kept: string[]; settledOld: string[] };

/**
 * Finish the Store payments this device started, and settle older ones (P0, 3 Nov 2026). Runs when the Store opens.
 *  - Signed but not sent (its backup failed, or the app closed): back up, send through the wallet, claim.
 *  - Sent but not confirmed (claim failed, or 202 pending): claim again, at most every RECLAIM_EVERY_MS; the server
 *    re-posts it and rechecks the network.
 *  - Store payments signed BEFORE this fix that the wallet still holds as 'nosend' while the network has them
 *    (WhatsOnChain or ARC; never 1Sat's BEEF store): handed to the wallet's send path. That re-sends the exact
 *    transaction, nothing new is signed or spent, and its change becomes spendable.
 * Never aborts anything. One run at a time.
 */
export function settleStorePayments(
  ctx: OneSatContext,
  f: Fetch,
  opts: { deps?: StorePayDeps; log?: (m: string) => void } = {},
): Promise<SettleReport> {
  if (!settling)
    settling = settleOnce(ctx, f, opts).finally(() => {
      settling = null;
    });
  return settling;
}

async function settleOnce(
  ctx: OneSatContext,
  f: Fetch,
  opts: { deps?: StorePayDeps; log?: (m: string) => void },
): Promise<SettleReport> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const deps = { log, ...(opts.deps ?? (await defaultStorePayDeps(ctx.wallet))) };
  const report: SettleReport = { finished: [], pending: [], kept: [], settledOld: [] };
  const t = now(deps);
  for (const e of pruneOutbox(deps.outbox, t)) {
    if (e.state === 'pending' && e.claimedAt && t - e.claimedAt < RECLAIM_EVERY_MS) {
      report.pending.push(e.txid);
      continue;
    }
    try {
      const r = e.kind === 'buy' ? await finishBuy(ctx, f, e, deps) : await finishOrder(ctx, f, e, deps);
      (r.pending ? report.pending : report.finished).push(e.txid);
    } catch (err) {
      report.kept.push(e.txid);
      log(`[bwx-store] ${e.txid}: not finished yet (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const known = new Set(deps.outbox.all().map((e) => e.txid));
  try {
    const w = ctx.wallet as unknown as ActionsWallet;
    const RECENT = 100;
    const head = await w.listActions({ labels: [], limit: 1 });
    const offset = Math.max(0, head.totalActions - RECENT);
    const { actions } = await w.listActions({ labels: [], limit: RECENT, offset });
    const lookups = deps.lookups ?? chainLookups();
    for (const a of actions) {
      const txid = a.txid ?? '';
      if (a.status !== 'nosend' || !TXID_RE.test(txid) || known.has(txid)) continue;
      if (!STORE_PAYMENT_DESC.test(a.description ?? '')) continue;
      if (!(await chainHasSeen(txid, lookups))) continue;
      const h = await sendThroughWallet(w, txid, { log });
      if (h === 'sent' || h === 'pending') report.settledOld.push(txid);
    }
  } catch (err) {
    log(`[bwx-store] older Store payments not checked (${err instanceof Error ? err.message : String(err)})`);
  }
  return report;
}

/** For tests: a StorePayError means nothing left the wallet unless `sent`. */
export const isStorePayError = (e: unknown): e is StorePayError => e instanceof StorePayError;
