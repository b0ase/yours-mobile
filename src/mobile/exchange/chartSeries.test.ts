import { describe, expect, it } from 'bun:test';
import { chartSeries } from './chartSeries';

const t = (satsPerToken: number) => ({ height: 1, satsPerToken, totalSats: satsPerToken, amount: 1 });

describe('chartSeries', () => {
  it('uses trade prices when there are trades', () => {
    expect(chartSeries([t(1), t(3), t(2)], { lowestAsk: 9 })).toEqual({ kind: 'trades', points: [1, 3, 2] });
  });
  it('draws a flat line at the lowest ask with no trades', () => {
    expect(chartSeries([], { lowestAsk: 5, launchPrice: 2 })).toEqual({
      kind: 'flat',
      points: [5, 5],
      price: 5,
      source: 'Lowest ask',
    });
  });
  it('falls back to the launch price, and a single trade beats both', () => {
    expect(chartSeries([], { lowestAsk: null, launchPrice: 2 })).toMatchObject({
      kind: 'flat',
      source: 'Launch price',
    });
    expect(chartSeries([t(7)], { lowestAsk: 5 })).toMatchObject({ kind: 'flat', price: 7, source: 'Last trade' });
  });
  it('draws a baseline when nothing is known', () => {
    expect(chartSeries([])).toEqual({ kind: 'baseline', points: [0, 0] });
    expect(chartSeries([], { lowestAsk: 0 })).toEqual({ kind: 'baseline', points: [0, 0] });
  });
});
