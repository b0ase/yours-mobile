import { describe, expect, test } from 'bun:test';
import type { HistoryRow } from '../wallet/txHistory';
import {
  priceAt,
  profitUsd,
  rankHoldings,
  rebased,
  rangeStart,
  sampleTimes,
  satsAt,
  twrSeries,
  valueSeries,
  type PricePoint,
} from './portfolioMath';

const DAY = 86_400_000;
const row = (time: number, amountSats: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  txid: `t${time}`,
  time,
  direction: amountSats >= 0 ? 'in' : 'out',
  amountSats,
  feeSats: 0,
  counterparty: '',
  label: '',
  note: '',
  confirmations: 1,
  ...extra,
});

describe('balance walked back from today', () => {
  const rows = [row(1 * DAY, 100_000_000), row(5 * DAY, -40_000_000)];
  test('before, between and after the rows', () => {
    expect(satsAt(rows, 60_000_000, 0)).toBe(0);
    expect(satsAt(rows, 60_000_000, 2 * DAY)).toBe(100_000_000);
    expect(satsAt(rows, 60_000_000, 6 * DAY)).toBe(60_000_000);
  });
  test('a lock only costs its fee (locked BSV is still yours)', () => {
    const lock = row(3 * DAY, -50_000_000, { category: 'lock', feeSats: 100 });
    expect(satsAt([lock], 1_000_000_000, 2 * DAY)).toBe(1_000_000_100);
  });
});

describe('prices', () => {
  const s: PricePoint[] = [
    { t: 0, p: 10 },
    { t: DAY, p: 20 },
    { t: 2 * DAY, p: 40 },
  ];
  test('last known at or before t; first point before the series', () => {
    expect(priceAt(s, -5)).toBe(10);
    expect(priceAt(s, DAY + 5)).toBe(20);
    expect(priceAt(s, 9 * DAY)).toBe(40);
    expect(priceAt([], 1)).toBeUndefined();
  });
  test('rebased to % from the first sample', () => {
    expect(rebased(s, [0, DAY, 2 * DAY])).toEqual([0, 100, 300]);
  });
  test('samples include both ends', () => {
    const t = sampleTimes(0, 10, 3);
    expect(t).toEqual([0, 5, 10]);
  });
  test('ALL starts at the first row', () => {
    expect(rangeStart('ALL', 100 * DAY, 3 * DAY)).toBe(3 * DAY);
    expect(rangeStart('1W', 100 * DAY)).toBe(93 * DAY);
  });
});

describe('performance', () => {
  const bsv: PricePoint[] = [
    { t: 0, p: 50 },
    { t: 2 * DAY, p: 100 },
  ];
  test('holding 1 BSV while the price doubles is +100%', () => {
    const times = [0, 2 * DAY];
    const v = valueSeries([], 100_000_000, bsv, times);
    expect(v.map((x) => x.usd)).toEqual([50, 100]);
    expect(twrSeries(v, [], bsv)).toEqual([0, 100]);
    expect(profitUsd(v, [], bsv)).toBe(50);
  });
  test('a deposit is not performance', () => {
    const flat: PricePoint[] = [{ t: 0, p: 50 }];
    const dep = row(DAY, 100_000_000, { usdRate: 50 });
    const times = [0, 2 * DAY];
    const v = valueSeries([dep], 200_000_000, flat, times);
    expect(v.map((x) => x.usd)).toEqual([50, 100]);
    expect(twrSeries(v, [dep], flat)).toEqual([0, 0]);
    expect(profitUsd(v, [dep], flat)).toBe(0);
  });
  test('the live price prices the last point', () => {
    const v = valueSeries([], 100_000_000, bsv, [0, DAY], 80);
    expect(v[1].usd).toBe(80);
  });
});

describe('holdings', () => {
  test('largest first, shares, best and worst only when they differ', () => {
    const r = rankHoldings([
      { id: 'mnee', name: 'MNEE', usd: 25, changePct: 0 },
      { id: 'bsv', name: 'BSV', usd: 75, changePct: 12 },
      { id: 'tok', name: 'Token', usd: 0, changePct: null },
    ]);
    expect(r.held.map((h) => h.id)).toEqual(['bsv', 'mnee']);
    expect(r.share(r.held[0])).toBe(75);
    expect(r.best?.id).toBe('bsv');
    expect(r.worst?.id).toBe('mnee');
    expect(rankHoldings([{ id: 'bsv', name: 'BSV', usd: 1, changePct: 3 }]).best).toBeNull();
  });
});
