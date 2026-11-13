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
import { BWALLET_PAYMAIL_API } from '../names/config';
import type { Fetch } from '../names/names';
import { signRequest } from '../names/paymail';
import { storeMemo, type StorePayKind } from './storePay';
import type { NoSendAction, StoreWord } from '../../services/unsentExpiry';

/**
 * The Store's address for builds whose names/config has none: the extension's service worker is built without the
 * page's paymail defines (vite.config.background.ts sets this one only), so the background can still ask the Store.
 */
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
/** The Store's base URL in this build, or '' (then every answer is 'unclear'). */
export const storeApiBase = (): string =>
  BWALLET_PAYMAIL_API || clean(typeof __STORE_API__ === 'undefined' ? '' : __STORE_API__);

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
 * it holds no such payment; 'unclear' = no clear answer (never release on that).
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
  try {
    const signed = await signRequest(wallet, claimAction(memo.kind), {
      quote_id: memo.quoteId,
      txid,
      store: STORE_PROTOCOL,
    });
    const answer = (async () => {
      const r = await f(`${api}/api/theme-orders/${claimOp(memo.kind)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signed),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: unknown; unverified?: unknown };
      return { ok: r.ok, status: r.status, j };
    })();
    const r = await Promise.race([
      answer,
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

/**
 * services/unsentExpiry.ts storeAsk: 'not-store' unless the wallet's record makes it a Store payment; then the Store's
 * answer ('never-heard' only on a clear "no such payment").
 */
export const storeAskFor =
  (wallet: Signer, f: Fetch, o: { api?: string; timeoutMs?: number } = {}) =>
  async (a: NoSendAction): Promise<StoreWord> => {
    const memo = storePaymentOf(a);
    if (!memo) return 'not-store';
    const h = await askStoreHeardOf(wallet, f, memo, a.txid, o);
    return h === 'no' ? 'never-heard' : h === 'yes' ? 'heard' : 'unclear';
  };
