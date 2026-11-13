/**
 * "Has the Store heard of this payment?", from the wallet's own record of it (13 Nov 2026).
 *
 * A Store payment is identified by what the wallet itself stores for the action, not by this device's outbox
 * (`bwx-store-outbox:<identityKey>` in one page's localStorage, which a reinstall, another browser profile or the
 * extension's service worker never sees): its description (payQuote / payBuyQuote: STORE_PAYMENT_DESC) and its memo
 * output (OP_RETURN "bwx-theme-buy" | "bwx-theme-order" <quote id>: storeMemo). The question goes to the Store as a
 * signed claim carrying no rawtx, which the server records nothing for.
 *
 * Shared by the Store screen (api.ts settleStorePayments) and the wallet's own unsent-payment pass (services/
 * unsentExpiry.ts 1b), which runs at every unlock and on a timer in the background. Any answer that isn't clear (the
 * Store unreachable, a timeout, a 429, a 5xx, a build with no Store address) is 'unclear': never a release, asked again
 * on the next run.
 */
import type { WalletInterface } from '@bsv/sdk';
import type { Fetch } from '../names/names';
import { signRequest } from '../names/signRequest';
import { storeMemo, type StorePayKind } from './storePay';
import type { NoSendAction, StoreKind, StoreWord } from '../../services/unsentExpiry';

/**
 * The Store's address. Read here, lazily, from the same build-time defines names/config.ts reads (not imported: that
 * module fixes its value when first loaded, and the wallet's background loads this one early). __STORE_API__ is for
 * the extension's service worker, built without the pages' paymail defines (vite.config.background.ts).
 */
declare const __PAYMAIL_API__: string;
declare const __PAYMAIL_DOMAIN__: string;
declare const __STORE_API__: string;

/**
 * The Store protocol this client speaks (review 4 Nov 2026, F12): the wallet broadcasts, after a backup and a claim
 * intent. Sent in every signed quote and claim; the server answers 426 update_required to clients without it.
 */
export const STORE_PROTOCOL = '2';
/** The descriptions payQuote / payBuyQuote give their payments (wallet/txHistory.ts labels them by these). */
export const STORE_PAYMENT_DESC = /^(Theme purchase · |bWalletX theme edition$)/;
/** A "heard of it?" question is answered within this, or it is 'unclear'. */
export const STORE_HEARD_TIMEOUT_MS = 15_000;

export const claimAction = (kind: StorePayKind) => (kind === 'buy' ? 'theme-buy-claim' : 'theme-orders-claim');
export const claimOp = (kind: StorePayKind) => (kind === 'buy' ? 'buy-claim' : 'claim');

const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\/$/, '') : '');
/** The Store's base URL in this build (names/config.ts BWALLET_PAYMAIL_API's rule, then __STORE_API__), or ''. */
export const storeApiBase = (): string => {
  const api = clean(typeof __PAYMAIL_API__ === 'undefined' ? '' : __PAYMAIL_API__);
  if (api) return api;
  const domain = clean(typeof __PAYMAIL_DOMAIN__ === 'undefined' ? '' : __PAYMAIL_DOMAIN__);
  if (domain) return `https://${domain}`;
  return clean(typeof __STORE_API__ === 'undefined' ? '' : __STORE_API__);
};

const TXID = /^[0-9a-f]{64}$/i;

/** The Store quote a wallet action pays, by the wallet's own record (description + memo output), or null. */
export function storePaymentOf(a: {
  description?: string;
  outputs?: { lockingScript?: string }[];
}): { kind: StorePayKind; quoteId: string } | null {
  if (!STORE_PAYMENT_DESC.test(a.description ?? '')) return null;
  for (const o of a.outputs ?? []) {
    const m = storeMemo(o.lockingScript ?? '');
    if (m) return m;
  }
  return null;
}

type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

/**
 * Has the Store heard of this txid for this quote? 'yes' = paid, or recorded as pending (an intent or a claim); 'no' =
 * it holds no such payment; 'unclear' = no clear answer (never release on that). Signing and the request together
 * have one deadline (a hung signature or request is 'unclear', never a stuck caller).
 */
export async function askStoreHeardOf(
  wallet: Signer,
  f: Fetch,
  memo: { kind: StorePayKind; quoteId: string },
  txid: string,
  o: { api?: string; timeoutMs?: number } = {},
): Promise<'yes' | 'no' | 'unclear'> {
  const api = o.api ?? storeApiBase();
  if (!api || !TXID.test(txid)) return 'unclear';
  const timeoutMs = o.timeoutMs ?? STORE_HEARD_TIMEOUT_MS;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const signed = await signRequest(wallet, claimAction(memo.kind), {
      quote_id: memo.quoteId,
      txid,
      store: STORE_PROTOCOL,
    });
    const r = await f(`${api}/api/theme-orders/${claimOp(memo.kind)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as { error?: unknown; unverified?: unknown };
    return { ok: r.ok, status: r.status, j };
  })().catch(() => null);
  try {
    const r = await Promise.race([
      work,
      new Promise<null>((ok) => {
        timer = setTimeout(() => {
          ctl?.abort();
          ok(null);
        }, timeoutMs);
      }),
    ]);
    if (!r) return 'unclear';
    if (r.ok) return r.j.unverified ? 'no' : 'yes';
    const code = String(r.j?.error || `http_${r.status}`);
    if (code === 'tx_used') return 'yes'; // the txid is recorded (on another row)
    if (['rawtx', 'quote_not_found', 'payment_pending', 'quote_used'].includes(code)) return 'no';
    return 'unclear';
  } catch {
    return 'unclear';
  } finally {
    clearTimeout(timer);
  }
}

// ── "made on this device" (services/unsentExpiry.ts 1b) ──

/** chrome.storage.local (shared by the extension's pages and worker; the mobile hub shares it too), else localStorage. */
type CreatedKV = {
  get: () => Promise<Record<string, CreatedEntry>>;
  set: (v: Record<string, CreatedEntry>) => Promise<void>;
};
type CreatedEntry = { quoteId: string; at: number };
/** Kept as long as the outbox keeps an entry (OUTBOX_KEEP_MS), a day more. */
export const CREATED_KEEP_MS = 15 * 24 * 60 * 60 * 1000;
const CREATED_MAX = 50;

export function createdHereKV(identityKey: string): CreatedKV {
  const key = `bwx.storeCreated.v1.${identityKey.slice(0, 16)}`;
  type Local = {
    get: (k: string) => Promise<Record<string, unknown>>;
    set: (i: Record<string, unknown>) => Promise<void>;
  };
  const local = (globalThis as { chrome?: { storage?: { local?: Local } } }).chrome?.storage?.local;
  return {
    get: async () => {
      const raw = local ? (await local.get(key))[key] : JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null');
      return raw && typeof raw === 'object' ? (raw as Record<string, CreatedEntry>) : {};
    },
    set: async (v) => {
      if (local) await local.set({ [key]: v });
      else globalThis.localStorage?.setItem(key, JSON.stringify(v));
    },
  };
}

/**
 * Record, on the device whose Store flow just signed a payment, that it made it (txid → quote id). Only this device's
 * Store flow writes it (a site can't reach the wallet's own storage), so only a payment the wallet itself made for a
 * Store quote gets the early release, and only here. Throws when it can't be saved (the caller logs and carries on:
 * the payment then simply waits for the longer deadline).
 */
export async function markStoreCreatedHere(kv: CreatedKV, txid: string, quoteId: string, now = Date.now()) {
  if (!TXID.test(txid)) throw new Error('not a txid');
  const all = await kv.get();
  const live = Object.entries(all)
    .filter(([, e]) => e && now - Number(e.at) < CREATED_KEEP_MS)
    .sort((a, b) => Number(a[1].at) - Number(b[1].at))
    .slice(-(CREATED_MAX - 1));
  await kv.set({ ...Object.fromEntries(live), [txid.toLowerCase()]: { quoteId, at: now } });
  const back = (await kv.get())[txid.toLowerCase()];
  if (!back || back.quoteId !== quoteId) throw new Error('the record did not stick');
}

/**
 * services/unsentExpiry.ts storeKind: 'not-store' unless the wallet's record makes it a Store payment; 'mine' only when
 * this device recorded making it for that same quote id; otherwise (synced from another device, made before this
 * record existed, or unreadable) 'other-device'.
 */
export const storeKindFor =
  (kv: CreatedKV) =>
  async (a: NoSendAction): Promise<StoreKind> => {
    const memo = storePaymentOf(a);
    if (!memo) return 'not-store';
    try {
      const mine = (await kv.get())[a.txid.toLowerCase()];
      return mine && mine.quoteId === memo.quoteId ? 'mine' : 'other-device';
    } catch {
      return 'other-device';
    }
  };

/** services/unsentExpiry.ts storeAsk (asked only for this device's own Store payments): the Store's answer. */
export const storeAskFor =
  (wallet: Signer, f: Fetch, o: { api?: string; timeoutMs?: number } = {}) =>
  async (a: NoSendAction): Promise<StoreWord> => {
    const memo = storePaymentOf(a);
    if (!memo) return 'unclear';
    const h = await askStoreHeardOf(wallet, f, memo, a.txid, o);
    return h === 'no' ? 'never-heard' : h === 'yes' ? 'heard' : 'unclear';
  };
