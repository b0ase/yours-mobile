/**
 * Personal-token curve sales, wallet side. Design (owner-approved 13 Oct 2026, see
 * docs/EXCHANGE-CATEGORIES.md "People" and bit-sign docs/PERSONAL-TOKEN-SALES.md):
 *
 *  - SELLER: the person's OWN wallet locks a tranche of their supply in OrdLock v2 listings
 *    (`pack` tokens each) at the current price and registers the outpoints with bit-sign. The OrdLock
 *    pays them when someone buys, so they don't need to be online. When their wallet is open it refills
 *    sold slots and re-prices when the holder count has moved. bit-sign never holds their keys.
 *  - BUYER: "Buy & chat" asks bit-sign for a quote (refuses own token / already joined), buys one curve
 *    listing with buyBsv21, reports the txid (bit-sign verifies it on chain and gives Supporter #n), then
 *    opens the room.
 *
 * Copy rule: "join their room" — never profit, price-going-up or investment wording.
 * Pure apart from the small fetch client at the bottom.
 */
import { loadSession } from '../chat/api';

export const BITSIGN = 'https://www.bit-sign.online';

export type SalesMode = 'curve' | 'flat' | 'off';

export type CurveSales = {
  open: boolean;
  tranche: number;
  pack: number;
  listings: string[];
  priced_at_holders: number;
};

export type SalesSettings = {
  token_id: string;
  pricing: {
    mode: SalesMode;
    usd_cents?: number;
    start_usd_cents?: number;
    step_holders?: number;
    max_per_buyer?: number;
  };
  sales: CurveSales;
  holders: number;
  price_usd_cents: number | null;
  supporters: { handle: string; supporter: number | null; amount: number; at: string }[];
};

export type Quote =
  | {
      ok: true;
      price_usd_cents: number;
      price_sats: number | null;
      supporter: number | null;
      pack: number;
      listings: string[];
    }
  | { ok: false; reason: string; message: string };

export const normOutpoint = (o: string) => o.trim().toLowerCase().replace('.', '_');

/** "1¢", "0.5¢", "$1.20". */
export const centsLabel = (c: number) => (c < 100 ? `${Number(c.toFixed(2))}¢` : `$${(c / 100).toFixed(2)}`);

/** The one approval sheet's title: "Join $kim's room — 1¢ (Supporter #3)". */
export const joinSheetTitle = (handle: string, cents: number, supporter: number | null) =>
  `Join $${handle}'s room — ${centsLabel(cents)}${supporter ? ` (Supporter #${supporter})` : ''}`;

/** "#3" badge text, or null after the first 100. */
export const supporterBadge = (n: number | null | undefined) => (n && n > 0 ? `Supporter #${n}` : null);

/** Words for a refused quote. Own token → hide the button; already joined → just open the room. */
export const quoteAction = (q: Quote): 'buy' | 'open-room' | 'hide' | 'resale' =>
  q.ok ? 'buy' : q.reason === 'own_token' ? 'hide' : q.reason === 'already_bought' ? 'open-room' : 'resale';

/** The curve listing to buy: one the quote lists that the market can still sell, cheapest first. */
export const pickCurveListing = <L extends { outpoint: string; priceSats: number; buyable: boolean }>(
  quoteListings: readonly string[],
  market: readonly L[],
): L | null => {
  const reg = new Set(quoteListings.map(normOutpoint));
  return (
    [...market]
      .filter((l) => l.buyable && reg.has(normOutpoint(l.outpoint)))
      .sort((a, b) => a.priceSats - b.priceSats)[0] ?? null
  );
};

/** US cents per listing → sats (rounded up; at least 1). */
export const listingPriceSats = (centsEach: number, pack: number, usdPerBsv: number) =>
  centsEach > 0 && pack > 0 && usdPerBsv > 0 ? Math.max(1, Math.ceil(((centsEach * pack) / 100 / usdPerBsv) * 1e8)) : 0;

/**
 * What the seller's wallet should do now. `live` = the registered listings still unspent.
 *  - closed → cancel every live listing
 *  - open   → re-price everything when the holder count moved past what they were priced at
 *             (the curve has moved ≥ ~0.7%, i.e. ≥ 10 holders on the default step); else list the gap.
 */
export type RefillPlan = { cancel: string[]; list: number };
export const refillPlan = (
  sales: CurveSales,
  live: readonly string[],
  holders: number,
  mode: SalesMode,
): RefillPlan => {
  if (!sales.open || mode === 'off') return { cancel: [...live], list: 0 };
  const stale = mode === 'curve' && holders - sales.priced_at_holders >= 10;
  if (stale) return { cancel: [...live], list: sales.tranche };
  return { cancel: [], list: Math.max(0, sales.tranche - live.length) };
};

/** Settings form validation (flat price in dollars, e.g. "0.25"). */
export const flatCents = (input: string): number | null => {
  const t = input.trim().replace(/^\$/, '');
  if (!/^\d*(\.\d{0,2})?$/.test(t) || !/\d/.test(t)) return null;
  const c = Math.round(Number(t) * 100);
  return c >= 1 && c <= 100_000 ? c : null;
};

// ── bit-sign client ─────────────────────────────────────────────────────────

type F = typeof fetch;
const auth = (): Record<string, string> => {
  const t = loadSession()?.token;
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const json = async <T>(r: Response): Promise<T> => {
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok && !(body as { ok?: boolean }).ok && (body as { reason?: string }).reason === undefined) {
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return body;
};

export const fetchQuote = (tokenId: string, f: F = fetch) =>
  f(`${BITSIGN}/api/bitsign/people-tokens/quote?token_id=${encodeURIComponent(tokenId)}`, {
    headers: auth(),
    credentials: 'omit',
  }).then((r) => json<Quote>(r));

export const fetchSettings = (tokenId: string, f: F = fetch) =>
  f(`${BITSIGN}/api/bitsign/people-tokens/settings?token_id=${encodeURIComponent(tokenId)}`, {
    headers: auth(),
    credentials: 'omit',
  }).then((r) => json<SalesSettings>(r));

export const saveSettings = (body: Record<string, unknown> & { token_id: string }, f: F = fetch) =>
  f(`${BITSIGN}/api/bitsign/people-tokens/settings`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify(body),
  }).then((r) => json<SalesSettings>(r));

export type PurchaseResult = { ok: boolean; supporter?: number | null; reason?: string; message?: string };

/** Report a curve buy. The tx can take a moment to reach WhatsOnChain: retry "not on chain yet". */
export const recordPurchase = async (
  tokenId: string,
  txid: string,
  f: F = fetch,
  tries = 6,
  waitMs = 2500,
): Promise<PurchaseResult> => {
  for (let i = 0; ; i++) {
    const r = await f(`${BITSIGN}/api/bitsign/people-tokens/purchase`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ token_id: tokenId, txid }),
    }).catch(() => null);
    const body = ((await r?.json().catch(() => null)) ?? { ok: false, reason: 'network' }) as PurchaseResult;
    if (body.ok || (body.reason !== 'not_found' && body.reason !== 'network') || i >= tries - 1) return body;
    await new Promise((res) => setTimeout(res, waitMs));
  }
};
