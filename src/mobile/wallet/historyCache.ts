import type { HistoryRow } from './txHistory';

export type LoadedHistory = { rows: HistoryRow[]; at: number };

/**
 * Last loaded history per account (owner, 11 Oct 2026: Desktop reloaded it from scratch every time the wallet page
 * opened). Shown at once on the next open while a quiet refresh runs; also kept for this tab's session. Shared by
 * the History screen and Friends (payments with one person).
 */
const HISTORY_CACHE = new Map<string, LoadedHistory>();
export const historyCacheKey = (addresses: string[]) => `bwx-history:${addresses.join(',')}`;
export const readHistoryCache = (key: string): LoadedHistory | null => {
  const hit = HISTORY_CACHE.get(key);
  if (hit) return hit;
  try {
    const raw = sessionStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as LoadedHistory) : null;
    if (v && Array.isArray(v.rows) && typeof v.at === 'number') {
      HISTORY_CACHE.set(key, v);
      return v;
    }
  } catch {
    /* no storage or bad JSON: load fresh */
  }
  return null;
};
export const writeHistoryCache = (key: string, v: LoadedHistory) => {
  HISTORY_CACHE.set(key, v);
  try {
    sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* over quota or blocked: the in-memory copy still serves this tab */
  }
};
