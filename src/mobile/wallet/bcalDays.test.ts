import { describe, expect, it } from 'bun:test';
import { dayKey, episodeItems, groupByDay, monthGrid, podcastItems, tradeItems, type CalItem } from './bcalDays';
import type { HistoryRow } from './txHistory';
import type { Podcast } from '../bradio/podcasts';
import type { PodcastEpisode } from '../bradio/rssPodcasts';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
const item = (id: string, t: number, kind: CalItem['kind'] = 'buy'): CalItem => ({
  id,
  at: t,
  kind,
  title: id,
  sub: '',
});

describe('bCal day grouping', () => {
  it('groups by local day, newest first within a day', () => {
    const g = groupByDay([item('a', at(2026, 9, 15, 9)), item('b', at(2026, 9, 15, 18)), item('c', at(2026, 9, 14))]);
    expect([...g.keys()].sort()).toEqual(['2026-10-14', '2026-10-15']);
    expect(g.get('2026-10-15')?.map((x) => x.id)).toEqual(['b', 'a']);
  });
  it('splits at local midnight', () => {
    const g = groupByDay([item('late', at(2026, 9, 15, 23)), item('early', at(2026, 9, 16, 0))]);
    expect(g.get('2026-10-15')?.[0]?.id).toBe('late');
    expect(g.get('2026-10-16')?.[0]?.id).toBe('early');
  });
  it('drops items with no real time', () => {
    expect(groupByDay([item('x', 0), item('y', NaN)]).size).toBe(0);
  });
  it('dayKey pads month and day', () => {
    expect(dayKey(at(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('bCal month grid', () => {
  it('October 2026 starts on Thursday, Monday-first whole weeks', () => {
    const g = monthGrid(2026, 9);
    expect(g.length % 7).toBe(0);
    expect(g.filter((c) => c.inMonth).length).toBe(31);
    expect(g[3]).toEqual({ key: '2026-10-01', day: 1, inMonth: true });
    expect(g[0]?.inMonth).toBe(false);
  });
  it('handles a leap February', () => {
    expect(monthGrid(2028, 1).filter((c) => c.inMonth).length).toBe(29);
  });
});

describe('bCal sources', () => {
  it('only buy and sell history rows become trade items', () => {
    const base = { feeSats: 0, counterparty: '', note: '', confirmations: 1, direction: 'out' } as const;
    const rows = [
      { ...base, txid: 't1', time: at(2026, 9, 1), amountSats: -500, label: 'market', type: 'buy' },
      { ...base, txid: 't2', time: at(2026, 9, 2), amountSats: 900, label: 'market', type: 'sell' },
      { ...base, txid: 't3', time: at(2026, 9, 3), amountSats: -10, label: 'send', type: 'send' },
    ] as unknown as HistoryRow[];
    const t = tradeItems(rows);
    expect(t.map((x) => x.kind)).toEqual(['buy', 'sell']);
    expect(t[0]?.sub).toBe('500 sats');
  });
  it('episodes without a date are left out; held podcasts are marked', () => {
    const eps = [
      { id: 'e1', at: at(2026, 9, 1), title: 'One', showName: 'Show' },
      { id: 'e2', at: 0, title: 'Undated', showName: 'Show' },
    ] as PodcastEpisode[];
    expect(episodeItems(eps).map((x) => x.id)).toEqual(['ep:e1']);
    const pods = [
      { id: 'p1', title: 'Mine', host: 'vex', createdAt: '2026-10-01T10:00:00Z' },
      { id: 'p2', title: 'Theirs', host: '', createdAt: '2026-10-02T10:00:00Z' },
    ] as Podcast[];
    const items = podcastItems(pods, (p) => p.id === 'p1');
    expect(items.map((x) => x.kind)).toEqual(['held', 'podcast']);
    expect(items[1]?.sub).toBe('bRadio');
  });
});
