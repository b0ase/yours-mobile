import { describe, expect, test } from 'bun:test';
import { buildRows, newestFirst, stampUnconfirmed, type HistoryRow, type RawTx } from './txHistory';

const row = (txid: string, time: number, blockHeight?: number): HistoryRow =>
  ({
    txid,
    time,
    blockHeight,
    confirmations: blockHeight ? 1 : 0,
    direction: 'out',
    amountSats: -1,
    feeSats: 0,
    counterparty: '',
    label: 'send',
    note: '',
  }) as HistoryRow;

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('activity history order', () => {
  test('newest first, unconfirmed at the top by their local time', () => {
    const rows = [
      row('old', 1_000, 800_000),
      row('pendingOlder', 5_000),
      row('new', 3_000, 800_010),
      row('pendingNewer', 6_000),
      row('mid', 2_000, 800_005),
    ];
    expect(newestFirst(rows).map((r) => r.txid)).toEqual(['pendingNewer', 'pendingOlder', 'new', 'mid', 'old']);
  });

  test('an oldest-first list (as cached) comes out newest-first, without changing the input', () => {
    const asc = [row('a', 1, 1), row('b', 2, 2), row('c', 3, 3)];
    expect(newestFirst(asc).map((r) => r.txid)).toEqual(['c', 'b', 'a']);
    expect(asc.map((r) => r.txid)).toEqual(['a', 'b', 'c']);
  });

  test('buildRows returns newest first, unconfirmed on top', () => {
    const own = new Set(['1me']);
    const tx = (txid: string, time?: number, blockHeight?: number): RawTx => ({
      txid,
      time,
      blockHeight,
      confirmations: blockHeight ? 1 : 0,
      vin: [],
      vout: [{ n: 0, sats: 100, addresses: ['1me'] }],
    });
    const rows = buildRows([tx('a', 100, 10), tx('p'), tx('b', 200, 11)], own, new Map(), 1_000_000);
    expect(rows.map((r) => r.txid)).toEqual(['p', 'b', 'a']);
  });

  test('unconfirmed keep the time this device first saw them across refreshes', () => {
    const st = mem();
    const first = stampUnconfirmed([row('p1', 10_000), row('c', 1, 5)], 10_000, st);
    expect(first[0].time).toBe(10_000);
    const later = stampUnconfirmed([row('p1', 50_000), row('p2', 50_000), row('c', 1, 5)], 50_000, st);
    expect(later.map((r) => r.time)).toEqual([10_000, 50_000, 1]);
    expect(newestFirst(later).map((r) => r.txid)).toEqual(['p2', 'p1', 'c']);
  });
});
