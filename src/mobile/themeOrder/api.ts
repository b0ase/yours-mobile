import { buildOrdinalCustomInstructions, ORDINALS_BASKET, P1SAT_PROTOCOL, type OneSatContext } from '@1sat/actions';
import { buildInscriptionScript } from '@1sat/templates';
import { GuardedPayError, guardedPay, scriptAddress, type Shown } from '../../services/guardedPay';
import type { WalletInterface } from '@bsv/sdk';
import { P2PKH, PublicKey, Random, Utils } from '@bsv/sdk';
import { storeReceiptMap, storeReceiptSvg, STORE_RECEIPT_TYPE, type StoreReceipt } from '../storeReceipt/receipt';
import { BWALLET_PAYMAIL_API } from '../names/config';
import type { Fetch } from '../names/names';
import { signRequest } from '../names/paymail';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { markMayBeOut } from '../../services/refusalRecheck';
import {
  chainHasSeen,
  chainLookups,
  chainSaysUnknown,
  defaultLookups,
  releaseAfterHandoff,
  sendThroughWallet,
  type UnsentWallet,
} from '../../services/unsentGuard';
import type { MyOrder, OrderForm } from './form';
import {
  localOutbox,
  pruneOutbox,
  recordNewPayment,
  releaseNeverSent,
  sendStorePayment,
  signStorePayment,
  softPut,
  storeMemo,
  StorePayError,
  type BackupAnswer,
  type IntentAnswer,
  type OutboxEntry,
  type StorePayDeps,
  INTENT_TIMEOUT_MS,
  UNSENT_RELEASE_MIN_AGE_MS,
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
/** 409 payment_pending: a payment for this theme is already on its way (site/lib/themeBuys.js quote). */
export const isPaymentPending = (e: unknown) => e instanceof ThemeOrderError && e.code === 'payment_pending';

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
  store_unavailable:
    "The Store couldn't check your earlier payments just now. Nothing was paid; try again in a minute.",
  update_required: 'Please update bWalletX to buy from the Store.',
};

/**
 * The Store protocol this client speaks (review 4 Nov 2026, F12): the wallet broadcasts, after a backup and a claim
 * intent. Sent in every signed quote and claim; the server answers 426 update_required to clients without it.
 */
export const STORE_PROTOCOL = '2';

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

type ActionsWallet = UnsentWallet & {
  listActions: (a: {
    labels: string[];
    limit?: number;
    offset?: number;
    includeOutputs?: boolean;
    includeOutputLockingScripts?: boolean;
  }) => Promise<{
    totalActions: number;
    actions: {
      txid?: string;
      status: string;
      description?: string;
      outputs?: { lockingScript?: string }[];
    }[];
  }>;
};

/** The most recent actions (newest last), up to `n`. */
async function recentActions(w: ActionsWallet, n: number, withOutputs = false) {
  const head = await w.listActions({ labels: [], limit: 1 });
  const offset = Math.max(0, head.totalActions - n);
  const { actions } = await w.listActions({
    labels: [],
    limit: n,
    offset,
    ...(withOutputs ? { includeOutputs: true, includeOutputLockingScripts: true } : {}),
  });
  return actions;
}

/** How many recent actions the fallback status read covers. */
export const ACTION_STATUS_WINDOW = 300;

/**
 * The wallet's status for a txid, read BY TXID (background STORE_ACTION_STATUS: services/actionStatusByTxid.ts).
 * undefined = the store holds no live action with that txid. When the background can't answer, falls back to the
 * last ACTION_STATUS_WINDOW actions (listActions, which leaves 'failed' out); a txid not among them is then
 * 'unknown' unless every action was read, so an older payment is never mistaken for a released one.
 */
export async function actionStatusOf(wallet: ActionsWallet, txid: string): Promise<string | undefined> {
  try {
    const r = await sendMessageAsync<{ success?: boolean; data?: { status?: string | null } } | undefined>({
      action: 'STORE_ACTION_STATUS',
      txid,
    });
    if (r?.success && r.data && 'status' in r.data) return r.data.status ?? undefined;
  } catch {
    /* no background here (tests, a wallet in the page): read the action list */
  }
  const head = await wallet.listActions({ labels: [], limit: 1 });
  const found = (await recentActions(wallet, ACTION_STATUS_WINDOW)).find((a) => a.txid === txid);
  if (found) return found.status;
  return head.totalActions <= ACTION_STATUS_WINDOW ? undefined : 'unknown';
}

const claimAction = (kind: OutboxEntry['kind']) => (kind === 'buy' ? 'theme-buy-claim' : 'theme-orders-claim');
const claimOp = (kind: OutboxEntry['kind']) => (kind === 'buy' ? 'buy-claim' : 'claim');

/**
 * Fill the parts of the Store deps that need the wallet and the Store (review 4 Nov 2026):
 *  - intent: the claim with `intent: '1'`, BEFORE the broadcast: the server checks the payment and records its txid
 *    without posting it, so the claim no longer depends on this device's outbox (F2). 4xx = refused (never send it);
 *    anything else = unreachable (keep it, try later);
 *  - releaseUnsent: a payment the Store refused before any broadcast (or that couldn't be saved) is released once the
 *    chain confirms it never went out (unsentGuard releaseAfterHandoff: ~30 s of clean 404s), in the background;
 *  - actionStatus: the wallet's status for a txid, read by txid; undefined when storage has no such action (F3),
 *    'unknown' when it can't tell (actionStatusOf).
 */
export function withStoreDeps(ctx: OneSatContext, f: Fetch, deps: StorePayDeps): StorePayDeps {
  const wallet = ctx.wallet as unknown as ActionsWallet;
  return {
    ...deps,
    intent:
      deps.intent ??
      (async (e): Promise<IntentAnswer> => {
        try {
          const signed = await signRequest(ctx.wallet, claimAction(e.kind), {
            quote_id: e.quoteId,
            txid: e.txid,
            store: STORE_PROTOCOL,
            intent: '1',
          });
          // Aborted at the same deadline sendStorePayment gives up at, so a hung request doesn't linger either.
          await post(
            f,
            claimOp(e.kind),
            { ...signed, rawtx: e.beefHex },
            {
              timeoutMs: deps.intentTimeoutMs ?? INTENT_TIMEOUT_MS,
            },
          );
          return { ok: true };
        } catch (err) {
          const status = (err as { status?: number }).status;
          const refused = err instanceof ThemeOrderError && !!status && status >= 400 && status < 500;
          return {
            ok: false,
            refused,
            error: err instanceof Error ? err.message : String(err),
            code: err instanceof ThemeOrderError ? err.code : undefined,
          };
        }
      }),
    releaseUnsent:
      deps.releaseUnsent ??
      (async (txid) => {
        void releaseAfterHandoff(wallet, txid, {
          notBroadcast: true,
          lookups: deps.releaseLookups,
          delaysMs: deps.recheckDelaysMs,
          sleep: deps.sleep,
          log: deps.log,
        });
      }),
    markMayBeOut:
      deps.markMayBeOut ??
      (async (txid) => {
        // Same context (tests, a wallet that runs in the page) and the background's broadcaster wrapper.
        await markMayBeOut(txid);
        await sendMessageAsync({ action: 'STORE_MAY_BE_OUT', txid }).catch(() => undefined);
      }),
    actionStatus: deps.actionStatus ?? ((txid) => actionStatusOf(wallet, txid)),
    storeHeardOf: deps.storeHeardOf ?? ((e) => storeHeardOf(ctx, f, { kind: e.kind, quoteId: e.quoteId }, e.txid)),
  };
}

const post = async <T>(f: Fetch, op: string, body: unknown, o: { timeoutMs?: number } = {}): Promise<T> => {
  if (!BWALLET_PAYMAIL_API) throw new ThemeOrderError('Orders open soon', 'not_configured', 503);
  // With a deadline: aborted (AbortController, as names/paymailDomains.ts probes), and given up on even if the fetch
  // ignores the signal. A timeout is a plain Error, never a ThemeOrderError: callers read it as "unreachable".
  const ctl = o.timeoutMs && typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = f(`${BWALLET_PAYMAIL_API}/api/theme-orders/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(ctl ? { signal: ctl.signal } : {}),
  });
  const r = o.timeoutMs
    ? await Promise.race([
        request,
        new Promise<never>((_, bad) => {
          timer = setTimeout(() => {
            ctl?.abort();
            bad(new Error(`the Store did not answer within ${o.timeoutMs! / 1000} s`));
          }, o.timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer))
    : await request;
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
  post<Quote>(f, 'quote', await signRequest(wallet, 'theme-orders-quote', { ...fields, store: STORE_PROTOCOL }));

/** Renew an edition for another year: a new quote for the same slug. */
export const getRenewQuote = (f: Fetch, wallet: Signer, slug: string) => getQuote(f, wallet, { slug, renew: slug });

/** A $1 store theme; nothing near this is a real price. Editions ($99 a year) get a larger ceiling. */
export const MAX_THEME_BUY_SATS = 20_000_000;
export const MAX_EDITION_SATS = 1_000_000_000;

/**
 * What the Pay sheet shows for a quote: each output as address + sats (refuses a non-P2PKH payment). The sheet prints
 * `q.sats`, so the outputs must add up to exactly that: the wallet never signs a different total than the one shown.
 */
export const quoteShown = (q: Quote): Shown[] => {
  const total = q.outputs.reduce((n, o) => n + o.satoshis, 0);
  if (!Number.isSafeInteger(total) || total !== q.sats)
    throw new GuardedPayError('the payment does not match the price you were shown');
  return q.outputs.filter((o) => o.satoshis > 1).map((o) => ({ address: scriptAddress(o.script), sats: o.satoshis }));
};

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
  const deps = withStoreDeps(ctx, f, opts.deps ?? (await defaultStorePayDeps(ctx.wallet)));
  // The same quote already signed (its backup failed) or sent: finish that payment, never sign a second one. A kept
  // payment found dead (never sent, gone from the wallet, not on chain) is cleared and a new one made (F3).
  const kept = pruneOutbox(deps.outbox, now(deps)).find((e) => e.kind === 'order' && e.key === q.quote_id);
  if (kept) {
    const done = await finishOrder(ctx, f, kept, deps).catch((e: unknown) => {
      if (e instanceof StorePayError && (e.code === 'cleared' || e.code === 'refused_cleared')) return null;
      throw e;
    });
    if (done) return done;
  }
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
    intentAt: null,
  };
  await recordNewPayment(entry, deps);
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
  if (entry.state === 'signed' || entry.state === 'sending' || entry.state === 'refused')
    await sendStorePayment(ctx.wallet as unknown as UnsentWallet, entry, deps);
  const sentEntry: OutboxEntry = { ...entry, state: 'sent' };
  try {
    const claimed = await claimOp();
    if (claimed.pending) softPut(deps.outbox, { ...sentEntry, state: 'pending', claimedAt: now(deps) }, deps.log);
    else deps.outbox.drop(entry.txid);
    return claimed;
  } catch (e) {
    // The money has left the wallet: keep it, claim again later (Store open), and never say "nothing was paid".
    softPut(deps.outbox, { ...sentEntry, claimedAt: now(deps) }, deps.log);
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
    const signed = await signRequest(ctx.wallet, 'theme-orders-claim', {
      quote_id: entry.quoteId,
      txid: entry.txid,
      store: STORE_PROTOCOL,
    });
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
  post<BuyQuote>(f, 'buy-quote', await signRequest(wallet, 'theme-buy-quote', { pack, store: STORE_PROTOCOL }));

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
  const deps = withStoreDeps(ctx, f, opts.deps ?? (await defaultStorePayDeps(ctx.wallet)));
  // This pack already has a payment signed (its backup failed), sent, or refused so far: finish or re-check that one,
  // never sign a second. One found dead (never sent, gone from the wallet, not on chain) is cleared (F3).
  const kept = pruneOutbox(deps.outbox, now(deps)).find((e) => e.kind === 'buy' && e.key === q.pack);
  if (kept) {
    const done = await finishBuy(ctx, f, kept, deps).catch((e: unknown) => {
      if (e instanceof StorePayError && (e.code === 'cleared' || e.code === 'refused_cleared')) return null;
      throw e;
    });
    if (done) return done;
  }
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
    intentAt: null,
  };
  await recordNewPayment(entry, deps);
  const res = await finishBuy(ctx, f, entry, deps);
  return { ...res, ...(receipt && q.receipt ? { receipt: q.receipt, receiptSvg: receipt.svg } : {}) };
};

async function finishBuy(ctx: OneSatContext, f: Fetch, entry: OutboxEntry, deps: StorePayDeps): Promise<BuyResult> {
  const r = await sendAndClaim(ctx, entry, deps, async () => {
    const signed = await signRequest(ctx.wallet, 'theme-buy-claim', {
      quote_id: entry.quoteId,
      txid: entry.txid,
      store: STORE_PROTOCOL,
    });
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

let settling: Promise<SettleReport> | null = null;
export type SettleReport = {
  finished: string[];
  pending: string[];
  kept: string[];
  settledOld: string[];
  /** Sent Store payments found in the wallet with no outbox entry, claimed from their memo (F2). */
  reclaimed: string[];
  /**
   * Unsent Store payments released: ones that never reached the outbox, the Store or the network (06c M2), and outbox
   * entries never sent and never told to the Store (backup failed; 10 Nov 2026).
   */
  released: string[];
};

/**
 * Has the Store heard of this txid for this quote? Asked with a claim that carries no rawtx: the server records nothing
 * it can't see. 'yes' = paid, or recorded as pending (an intent or a claim); 'no' = it holds no such payment; 'unclear'
 * = no clear answer (never release on that).
 */
async function storeHeardOf(
  ctx: OneSatContext,
  f: Fetch,
  memo: { kind: OutboxEntry['kind']; quoteId: string },
  txid: string,
): Promise<'yes' | 'no' | 'unclear'> {
  try {
    const signed = await signRequest(ctx.wallet, claimAction(memo.kind), {
      quote_id: memo.quoteId,
      txid,
      store: STORE_PROTOCOL,
    });
    const r = await post<{ pending?: boolean; unverified?: boolean }>(f, claimOp(memo.kind), signed);
    return r.unverified ? 'no' : 'yes';
  } catch (e) {
    if (!(e instanceof ThemeOrderError)) return 'unclear';
    if (e.code === 'tx_used') return 'yes'; // the txid is recorded (on another row)
    if (['rawtx', 'quote_not_found', 'payment_pending', 'quote_used'].includes(e.code)) return 'no';
    return 'unclear';
  }
}

/** Txids the Store has confirmed paid (so the scan doesn't ask again). Small, per identity, best effort. */
export type ClaimedSet = { has: (txid: string) => boolean; add: (txid: string) => void };
export const memoryClaimed = (): ClaimedSet => {
  const s = new Set<string>();
  return { has: (t) => s.has(t), add: (t) => void s.add(t) };
};
export const localClaimed = (identityKey: string): ClaimedSet => {
  const key = `bwx-store-claimed:${identityKey}`;
  const read = (): string[] => {
    try {
      const v = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return {
    has: (t) => read().includes(t),
    add: (t) => {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify([...read().filter((x) => x !== t), t].slice(-300)));
      } catch {
        /* best effort: the next scan asks the Store again, which is harmless */
      }
    },
  };
};

/**
 * Finish the Store payments this device started, and settle older ones (P0, 3 Nov 2026; review 4 Nov 2026). Runs when
 * the Store opens.
 *  - Signed, never sent and never told to the Store (its backup failed, or the app closed first): released, never sent
 *    (releaseNeverSent: wallet 'nosend', the chain has no copy over ~30 s, the Store never heard of it). The buyer was
 *    told nothing was paid; a new Pay makes a new payment (10 Nov 2026).
 *  - Signed and told to the Store but not sent (the Store was unreachable): back up, tell the Store, send, claim.
 *  - Refused so far: re-checked against the chain; claimed if the network has it; cleared only after a day, when the
 *    wallet holds no live action for it and the chain still doesn't have it after ~30 s of retries.
 *  - Sent but not confirmed (claim failed, or 202 pending): claim again, at most every RECLAIM_EVERY_MS.
 *  - Sent Store payments the wallet holds (unproven / completed / sending) with no outbox entry (the outbox was lost:
 *    storage cleared, reinstalled, restored elsewhere): claimed again from the quote id in their memo output (F2).
 *  - Store payments signed BEFORE this fix that the wallet still holds as 'nosend' while the network has them
 *    (WhatsOnChain or ARC; never 1Sat's BEEF store): handed to the wallet's send path. That re-sends the exact
 *    transaction, nothing new is signed or spent, and its change becomes spendable.
 * Never aborts anything that may have gone out. One run at a time.
 */
export function settleStorePayments(
  ctx: OneSatContext,
  f: Fetch,
  opts: { deps?: StorePayDeps; log?: (m: string) => void; claimed?: ClaimedSet } = {},
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
  opts: { deps?: StorePayDeps; log?: (m: string) => void; claimed?: ClaimedSet },
): Promise<SettleReport> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const base = opts.deps ?? (await defaultStorePayDeps(ctx.wallet));
  const deps = withStoreDeps(ctx, f, { log, ...base });
  const claimed = opts.claimed ?? localClaimed((await ctx.wallet.getPublicKey({ identityKey: true })).publicKey);
  const report: SettleReport = { finished: [], pending: [], kept: [], settledOld: [], reclaimed: [], released: [] };
  const t = now(deps);
  /** Everything the outbox held at the start of this run: the scan below never claims those a second time. */
  const handled = new Set<string>();
  for (const e of pruneOutbox(deps.outbox, t)) {
    handled.add(e.txid);
    // Never sent and never told to the Store (its backup failed, or the app closed first): the buyer was told
    // "nothing was paid", so it is released, never sent without a new Pay (owner, 10 Nov 2026). A young one may be
    // a Pay still backing it up: left to that Pay.
    // Nothing is parked for good: an entry kept here (the chain or the Store gave no clear answer) is asked again on
    // every Store open, until it is released, finished, or pruned after OUTBOX_KEEP_MS (unsentExpiry still frees its
    // coins then). Written before intentAt existed and the Store HAS heard of it (the old store_unreachable case): it
    // was told, so it is finished as before.
    if (e.state === 'signed' && (e.intentAt === null || e.intentAt === undefined)) {
      if (t - e.at < UNSENT_RELEASE_MIN_AGE_MS) {
        report.kept.push(e.txid);
        continue;
      }
      const heard =
        e.intentAt === undefined ? await deps.storeHeardOf!(e).catch(() => 'unclear' as const) : ('no' as const);
      if (heard === 'unclear') {
        log(`[bwx-store] ${e.txid}: the Store gave no clear answer about it; asked again next time`);
        report.kept.push(e.txid);
        continue;
      }
      if (heard === 'no') {
        const r = await releaseNeverSent(ctx.wallet as unknown as UnsentWallet, e, deps, {
          retryWindow: true,
          storeHeard: 'no',
        });
        (r === 'kept' ? report.kept : report.released).push(e.txid);
        continue;
      }
      // heard === 'yes': told before intentAt existed; finished below like any told payment.
    }
    if (e.state === 'pending' && e.claimedAt && t - e.claimedAt < RECLAIM_EVERY_MS) {
      report.pending.push(e.txid);
      continue;
    }
    try {
      const r = e.kind === 'buy' ? await finishBuy(ctx, f, e, deps) : await finishOrder(ctx, f, e, deps);
      (r.pending ? report.pending : report.finished).push(e.txid);
      if (!r.pending) claimed.add(e.txid);
    } catch (err) {
      report.kept.push(e.txid);
      log(`[bwx-store] ${e.txid}: not finished yet (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const known = new Set([...handled, ...deps.outbox.all().map((e) => e.txid)]);
  const w = ctx.wallet as unknown as ActionsWallet;
  let actions: Awaited<ReturnType<typeof recentActions>> = [];
  try {
    actions = await recentActions(w, 100, true);
  } catch (err) {
    log(`[bwx-store] wallet actions not read (${err instanceof Error ? err.message : String(err)})`);
  }
  // Sent Store payments with no outbox entry: claim them from their memo (no rawtx: the server reads the tx itself).
  for (const a of actions) {
    const txid = a.txid ?? '';
    if (!['unproven', 'completed', 'sending'].includes(a.status) || !TXID_RE.test(txid)) continue;
    if (known.has(txid) || claimed.has(txid) || !STORE_PAYMENT_DESC.test(a.description ?? '')) continue;
    const memo = (a.outputs ?? []).map((o) => storeMemo(o.lockingScript ?? '')).find(Boolean);
    if (!memo) continue;
    try {
      const signed = await signRequest(ctx.wallet, claimAction(memo.kind), {
        quote_id: memo.quoteId,
        txid,
        store: STORE_PROTOCOL,
      });
      const r = await post<{ pending?: boolean }>(f, claimOp(memo.kind), signed);
      report.reclaimed.push(txid);
      if (!r.pending) claimed.add(txid);
    } catch (err) {
      log(
        `[bwx-store] ${txid}: sent Store payment not claimed yet (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  // Store payments still 'nosend' with no outbox entry.
  const lookups = deps.lookups ?? chainLookups();
  const inOutbox = (txid: string) => deps.outbox.all().some((e) => e.txid === txid);
  for (const a of actions) {
    const txid = a.txid ?? '';
    if (a.status !== 'nosend' || !TXID_RE.test(txid) || known.has(txid)) continue;
    if (!STORE_PAYMENT_DESC.test(a.description ?? '')) continue;
    // Signed before this fix, and the network has it: hand it to the wallet's send path.
    if (await chainHasSeen(txid, lookups)) {
      const h = await sendThroughWallet(w, txid, { log });
      if (h === 'sent' || h === 'pending') report.settledOld.push(txid);
      continue;
    }
    // 06c M2: an orphan. The app (or the extension popup) died between signing and the outbox write, so it never
    // reached the Store or the network (both come after that write), yet its nosend row holds the coin for 24 h and
    // every send fails ("my balance became unspendable"). Release it only when the Store has never heard of it, the
    // chain shows nothing over ~30 s of retries, and, just before, it is still not in the outbox (a Pay in progress)
    // and the Store still hasn't heard of it.
    const memo = (a.outputs ?? []).map((o) => storeMemo(o.lockingScript ?? '')).find(Boolean);
    if (!memo || inOutbox(txid)) continue;
    if ((await storeHeardOf(ctx, f, memo, txid)) !== 'no') continue;
    const gone = await chainSaysUnknown(txid, {
      lookups: deps.releaseLookups ? [...deps.releaseLookups] : defaultLookups(),
      delaysMs: deps.recheckDelaysMs,
      sleep: deps.sleep,
    });
    if (!gone || inOutbox(txid) || (await storeHeardOf(ctx, f, memo, txid)) !== 'no') continue;
    try {
      await w.abortAction({ reference: txid });
      report.released.push(txid);
      log(`[bwx-store] ${txid}: an unsent Store payment that never reached the Store or the network; released`);
    } catch (err) {
      log(`[bwx-store] ${txid}: release refused (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return report;
}

/** For tests: a StorePayError means nothing left the wallet unless `sent`. */
export const isStorePayError = (e: unknown): e is StorePayError => e instanceof StorePayError;
