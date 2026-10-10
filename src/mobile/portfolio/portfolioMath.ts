/**
 * Portfolio vs market (owner, 10 Oct 2026: "performance of the user's portfolio against the market"): the maths,
 * kept pure so it is tested without the network. All times are unix ms, prices USD per coin.
 *
 * What we can honestly rebuild: the BSV the account held at any moment (today's balance, walked back through the
 * history) × the BSV price at that moment. Locks are BSV that is still yours, so locking and claiming move nothing
 * but the fee. Token prices in the past are not known, so tokens are not in the line (the screen says so).
 */
import type { HistoryRow } from '../wallet/txHistory';

export type PricePoint = { t: number; p: number };
export type RangeId = '1D' | '1W' | '1M' | '1Y' | 'ALL';

const DAY = 86_400_000;
export const RANGE_MS: Record<Exclude<RangeId, 'ALL'>, number> = {
  '1D': DAY,
  '1W': 7 * DAY,
  '1M': 30 * DAY,
  '1Y': 365 * DAY,
};

/** Start of a range. ALL starts at the first history row (or a year back when there is no history). */
export const rangeStart = (range: RangeId, now: number, firstRow?: number) =>
  range === 'ALL' ? (firstRow ?? now - RANGE_MS['1Y']) : now - RANGE_MS[range];

/** Balance change of a row for the account's total BSV (spendable + locked): a lock or claim only costs its fee. */
export const totalFlowSats = (r: HistoryRow) => (r.category === 'lock' ? -r.feeSats : r.amountSats - r.feeSats);

/** Money that came in or went out (not a fee, not a lock): what performance must not count as gain or loss. */
export const externalFlowSats = (r: HistoryRow) => (r.category === 'lock' ? 0 : r.amountSats);

/** Total BSV (sats) held at time t: today's total minus everything that happened after t. Never below zero. */
export const satsAt = (rows: HistoryRow[], nowSats: number, t: number) => {
  let s = nowSats;
  for (const r of rows) if (r.time > t) s -= totalFlowSats(r);
  return Math.max(0, s);
};

/** Price at t from a series sorted by time: the last point at or before t, else the first one. */
export const priceAt = (series: PricePoint[], t: number): number | undefined => {
  if (!series.length) return undefined;
  let lo = 0;
  let hi = series.length - 1;
  if (t < series[0].t) return series[0].p;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return series[lo].p;
};

/** Evenly spaced sample times across [from, to], always including both ends. */
export const sampleTimes = (from: number, to: number, n = 96) => {
  if (to <= from) return [to];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(from + ((to - from) * i) / (n - 1));
  return out;
};

export type ValuePoint = { t: number; usd: number; sats: number };

/** The account's BSV value over the range. `livePrice` (when known) prices the final point. */
export const valueSeries = (
  rows: HistoryRow[],
  nowSats: number,
  bsv: PricePoint[],
  times: number[],
  livePrice?: number,
): ValuePoint[] =>
  times.map((t, i) => {
    const sats = satsAt(rows, nowSats, t);
    const p = i === times.length - 1 && livePrice ? livePrice : (priceAt(bsv, t) ?? 0);
    return { t, sats, usd: (sats / 1e8) * p };
  });

/**
 * Time-weighted return of the account over the samples: each step's growth with the money that came in or went
 * out during that step taken out, so a deposit is not "performance". Returns the cumulative % at each sample.
 */
export const twrSeries = (values: ValuePoint[], rows: HistoryRow[], bsv: PricePoint[]): number[] => {
  const out: number[] = [];
  let idx = 1;
  for (let i = 0; i < values.length; i++) {
    if (i > 0) {
      const a = values[i - 1];
      const b = values[i];
      let flowUsd = 0;
      for (const r of rows)
        if (r.time > a.t && r.time <= b.t)
          flowUsd += (externalFlowSats(r) / 1e8) * (r.usdRate ?? priceAt(bsv, r.time) ?? 0);
      // Nothing held at the start of the step: no return to measure (the deposit just arrives).
      if (a.usd > 0) idx *= Math.max(0, (b.usd - flowUsd) / a.usd);
    }
    out.push((idx - 1) * 100);
  }
  return out;
};

/** A price series as % change from its value at the first sample. */
export const rebased = (series: PricePoint[], times: number[]): number[] => {
  const base = priceAt(series, times[0]);
  if (!base) return [];
  return times.map((t) => (((priceAt(series, t) ?? base) - base) / base) * 100);
};

/** Profit or loss in dollars over the range: end value − start value − money put in (+ money taken out). */
export const profitUsd = (values: ValuePoint[], rows: HistoryRow[], bsv: PricePoint[]) => {
  if (values.length < 2) return 0;
  const from = values[0].t;
  const to = values[values.length - 1].t;
  let flows = 0;
  for (const r of rows)
    if (r.time > from && r.time <= to) flows += (externalFlowSats(r) / 1e8) * (r.usdRate ?? priceAt(bsv, r.time) ?? 0);
  return values[values.length - 1].usd - values[0].usd - flows;
};

export type Holding = { id: string; name: string; usd: number; changePct: number | null };

/** Largest first; best and worst only when at least two holdings moved differently. */
export const rankHoldings = (list: Holding[]) => {
  const held = list.filter((h) => h.usd > 0).sort((a, b) => b.usd - a.usd);
  const total = held.reduce((s, h) => s + h.usd, 0);
  const priced = held.filter((h) => h.changePct !== null) as (Holding & { changePct: number })[];
  const sorted = [...priced].sort((a, b) => b.changePct - a.changePct);
  const differ = sorted.length >= 2 && sorted[0].changePct !== sorted[sorted.length - 1].changePct;
  return {
    held,
    total,
    share: (h: Holding) => (total > 0 ? (h.usd / total) * 100 : 0),
    best: differ ? sorted[0] : null,
    worst: differ ? sorted[sorted.length - 1] : null,
  };
};

/** Is the line partly estimated? (prices filled from today's rate, or the history may be missing coins) */
export const isEstimated = (rows: HistoryRow[], values: ValuePoint[], nowSats: number) =>
  rows.some((r) => r.usdRateIsCurrent) ||
  (values.length > 0 && values[0].sats === 0 && nowSats > 0 && rows.length === 0);
