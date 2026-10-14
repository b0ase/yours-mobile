import type { Trade } from './exchangeData';

/** What a price chart draws. `kind` says where the line came from. */
export type ChartSeries =
  | { kind: 'trades'; points: number[] }
  | { kind: 'flat'; points: number[]; price: number; source: string }
  | { kind: 'baseline'; points: number[] };

/**
 * Trades → their prices (oldest → newest). With fewer than two trades the chart still draws:
 * a flat line at the one trade / lowest ask / launch price, else an empty baseline.
 */
export const chartSeries = (
  trades: readonly Trade[],
  known: { lowestAsk?: number | null; launchPrice?: number | null } = {},
): ChartSeries => {
  if (trades.length >= 2) return { kind: 'trades', points: trades.map((t) => t.satsPerToken) };
  const pick: [number | null | undefined, string][] = [
    [trades[0]?.satsPerToken, 'Last trade'],
    [known.lowestAsk, 'Lowest ask'],
    [known.launchPrice, 'Launch price'],
  ];
  for (const [p, source] of pick)
    if (typeof p === 'number' && Number.isFinite(p) && p > 0) return { kind: 'flat', points: [p, p], price: p, source };
  return { kind: 'baseline', points: [0, 0] };
};
