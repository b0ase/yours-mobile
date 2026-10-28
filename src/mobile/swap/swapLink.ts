/**
 * Prefilled swap links (bWalletX only, SWAP_ENABLED). A link opens Exchange › Swap with the coin, network and amount
 * filled in; the user still checks and confirms everything, nothing starts on its own. Forms:
 *   https://www.bwallet.space/swap?from=btc&network=btc&amount=0.01&then=bsvex:FOO   (iOS universal / Android app link)
 *   bwalletx://swap?from=…                                                            (app-scheme fallback)
 *   https://web.bwalletx.com/swap?from=…  or  /exchange/swap?from=…                  (web / Desktop, url/publicUrl.ts)
 *   chrome-extension://<id>/<page>.html#/swap?from=…                                  (extension, url/resume.ts)
 * Only from / network / amount / then are read; anything else is ignored. `then` is an optional next hop after the
 * swap lands: only `bsvex:<ticker or BSV-21 outpoint>`, shown as a button when BSVEX_HANDOFF_ON (storeBuild.ts).
 *
 * Pure (no Capacitor), unit-tested in swapLink.test.ts.
 */

export type SwapPrefill = { from: string; network: string; amount: number | null; then: string | null };

const LINK_HOSTS = new Set(['www.bwallet.space', 'bwallet.space']);
const CODE = /^[a-z0-9]{1,20}$/;
const TICKER = /^\$?[A-Za-z0-9]{1,20}$/;
const OUTPOINT = /^[0-9a-f]{64}_\d+$/;
export const SWAP_AMOUNT_MAX = 1_000_000;

/** A `then` value we accept (`bsvex:<ticker>` / `bsvex:<txid>_<vout>`), normalised; null for anything else. */
export const parseThen = (raw: string | null | undefined): string | null => {
  if (!raw || raw.length > 100) return null;
  const m = /^bsvex:(.+)$/.exec(raw.trim());
  if (!m) return null;
  const v = m[1];
  if (OUTPOINT.test(v)) return `bsvex:${v}`;
  if (TICKER.test(v)) return `bsvex:${v.replace(/^\$/, '').toUpperCase()}`;
  return null;
};

/** Amount clamped to (0, SWAP_AMOUNT_MAX] and 8 decimals; null when missing or not a positive number. */
export const clampAmount = (raw: string | null | undefined): number | null => {
  if (!raw || raw.length > 32) return null;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const c = Math.min(n, SWAP_AMOUNT_MAX);
  const r = Number(c.toFixed(8));
  return r > 0 ? r : null;
};

/** The prefill in a query string, or null when from / network are missing or malformed. */
export const prefillFromQuery = (search: string | URLSearchParams): SwapPrefill | null => {
  const q = typeof search === 'string' ? new URLSearchParams(search.replace(/^\?/, '')) : search;
  const from = (q.get('from') ?? '').trim().toLowerCase();
  const network = (q.get('network') ?? from).trim().toLowerCase();
  if (!CODE.test(from) || !CODE.test(network)) return null;
  return { from, network, amount: clampAmount(q.get('amount')), then: parseThen(q.get('then')) };
};

/** A full swap link (universal link or bwalletx://swap) → its prefill, or null for anything else. */
export const parseSwapLink = (link: string | null | undefined): SwapPrefill | null => {
  if (!link || link.length > 2048) return null;
  try {
    const u = new URL(link);
    const ours =
      (u.protocol === 'https:' && LINK_HOSTS.has(u.host) && u.pathname === '/swap') ||
      (u.protocol === 'bwalletx:' && (u.host === 'swap' || u.pathname.replace(/^\/+/, '') === 'swap'));
    return ours ? prefillFromQuery(u.searchParams) : null;
  } catch {
    return null;
  }
};

/** Extension form: an .html page with a #/swap?… hash → its prefill (null anywhere else). */
export const extensionSwapPrefill = (pathname: string, hash: string): SwapPrefill | null => {
  if (!/\.html$/i.test(pathname)) return null;
  const m = /^#\/swap(?:\?(.*))?$/.exec(hash);
  return m ? prefillFromQuery(m[1] ?? '') : null;
};

/** The router path that opens Exchange › Swap with a prefill (only the four known params, encoded). */
export const swapRoute = (p: SwapPrefill): string => {
  const q = new URLSearchParams({ from: p.from, network: p.network });
  if (p.amount !== null) q.set('amount', String(p.amount));
  if (p.then) q.set('then', p.then);
  return `/m/exchange/swap?${q.toString()}`;
};

/** Match a prefill against the coin list (ticker + network); null when it isn't a coin we offer. */
export const matchCoin = <T extends { ticker: string; network: string }>(
  p: Pick<SwapPrefill, 'from' | 'network'>,
  coins: readonly T[],
): T | null => coins.find((c) => c.ticker === p.from && c.network === p.network) ?? null;

/** The bsvex buy page for a landed swap: sats actually received, our source tag and the swap id, all encoded. */
export const bsvexUrl = (then: string, receivedBsv: number | null | undefined, swapId: string): string | null => {
  const t = parseThen(then);
  if (!t) return null;
  const target = t.slice('bsvex:'.length);
  const sats = receivedBsv && Number.isFinite(receivedBsv) && receivedBsv > 0 ? Math.round(receivedBsv * 1e8) : 0;
  const q = new URLSearchParams({ bsv: String(sats), src: 'bwallet-swap', ref: swapId });
  return `https://www.bsvex.com/t/${encodeURIComponent(target)}/buy?${q.toString()}`;
};

/** The "Continue to bsvex" hop to show for a swap, or null (flag off, not done yet, no `then`). */
export const handoffFor = (
  swap: { stage: string; then?: string | null; toAmount: number | null; id: string },
  flagOn: boolean,
): { label: string; url: string } | null => {
  if (!flagOn || swap.stage !== 'done' || !swap.then) return null;
  const url = bsvexUrl(swap.then, swap.toAmount, swap.id);
  if (!url) return null;
  const target = swap.then.slice('bsvex:'.length);
  return { label: `Continue to bsvex to buy ${OUTPOINT.test(target) ? 'this token' : `$${target}`}`, url };
};
