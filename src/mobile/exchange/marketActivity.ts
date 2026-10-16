/**
 * Which BSV-21 tokens have real market activity on 1sat.market: at least one active listing, or a trade in the
 * last 30 days. Data: GorillaPool's BSV-21 market API (the backend 1sat.market and the Exchange already use).
 * An objective filter only: no ranking, no labels. Pure helpers are tested; the fetch is cached for 10 minutes.
 */
import { cached } from '../market/indexer';
import { chainTip } from './exchangeData';

/** About 30 days of 10-minute blocks. */
export const ACTIVE_WINDOW_BLOCKS = 30 * 144;

export type MarketActivity = {
  /** Token ids with at least one active listing. */
  listed: ReadonlySet<string>;
  /** Token id → the block height of its latest trade. */
  lastTrade: ReadonlyMap<string, number>;
  /** Chain height the window is measured from (0 when unknown). */
  tip: number;
};

type Row = { id?: string; spendHeight?: number; height?: number };

/** Active-listing rows → the set of listed token ids (lowercase). */
export const listedIds = (rows: unknown): Set<string> => {
  const out = new Set<string>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Row[]) if (typeof r?.id === 'string') out.add(r.id.toLowerCase());
  return out;
};

/** Sale rows → token id → latest trade height, merged into `into`. */
export const lastTrades = (rows: unknown, into = new Map<string, number>()): Map<string, number> => {
  if (!Array.isArray(rows)) return into;
  for (const r of rows as Row[]) {
    if (typeof r?.id !== 'string') continue;
    const h = Number(r.spendHeight || r.height || 0);
    if (!(h > 0)) continue;
    const id = r.id.toLowerCase();
    if (h > (into.get(id) ?? 0)) into.set(id, h);
  }
  return into;
};

/** True when the token has an active listing or traded within the window. Unknown tip: any trade counts. */
export const isActiveOnMarket = (id: string, a: MarketActivity, window = ACTIVE_WINDOW_BLOCKS): boolean => {
  const k = id.toLowerCase();
  if (a.listed.has(k)) return true;
  const h = a.lastTrade.get(k);
  if (h === undefined) return false;
  return a.tip <= 0 || h >= a.tip - window;
};

/** Adds one token's own evidence (a live floor or its own trades) learned while showing its card. */
export const withTokenEvidence = (
  a: MarketActivity,
  id: string,
  ev: { listed: boolean; lastTradeHeight: number | null },
): MarketActivity => {
  const k = id.toLowerCase();
  const listed = ev.listed && !a.listed.has(k) ? new Set([...a.listed, k]) : a.listed;
  const prev = a.lastTrade.get(k) ?? 0;
  const lastTrade =
    ev.lastTradeHeight && ev.lastTradeHeight > prev ? new Map([...a.lastTrade, [k, ev.lastTradeHeight]]) : a.lastTrade;
  return listed === a.listed && lastTrade === a.lastTrade ? a : { ...a, listed, lastTrade };
};

const GP = 'https://ordinals.gorillapool.io/api/bsv20/market';
const PAGE = 300;
const MAX_PAGES = 30;

const page = async (url: string): Promise<unknown[]> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`1sat.market ${r.status}`);
  const j: unknown = await r.json();
  return Array.isArray(j) ? j : [];
};

/** Every active listing and every sale back to the 30-day window (paged, newest first). Cached 10 minutes. */
export const marketActivity = (): Promise<MarketActivity> =>
  cached(
    'bex:activity',
    async () => {
      const tip = await chainTip();
      const listed = new Set<string>();
      for (let p = 0; p < MAX_PAGES; p++) {
        const rows = await page(`${GP}?limit=${PAGE}&offset=${p * PAGE}&dir=desc`);
        for (const id of listedIds(rows)) listed.add(id);
        if (rows.length < PAGE) break;
      }
      const lastTrade = new Map<string, number>();
      for (let p = 0; p < MAX_PAGES; p++) {
        const rows = await page(`${GP}/sales?limit=${PAGE}&offset=${p * PAGE}&dir=desc`);
        lastTrades(rows, lastTrade);
        const oldest = Number((rows[rows.length - 1] as Row | undefined)?.spendHeight ?? 0);
        if (rows.length < PAGE || (tip > 0 && oldest > 0 && oldest < tip - ACTIVE_WINDOW_BLOCKS)) break;
      }
      return { listed, lastTrade, tip };
    },
    10 * 60_000,
  );
