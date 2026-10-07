import { describe, expect, test } from 'bun:test';
import { computeGains, dayIn, taxYearOf, totalsByAsset, type LedgerEvent } from './gains';
import { buildLedger, gainsCsv } from './taxLedger';
import { nearestPrevious } from './txHistory';
import { parseBoeCsv, bsvFiat } from './fiatRates';
import type { HistoryRow } from './txHistory';

let seq = 0;
const ev = (day: string, side: 'acquire' | 'dispose', qty: number, fiat: number, asset = 'token:X'): LedgerEvent => ({
  asset,
  label: 'X',
  day,
  time: Date.parse(`${day}T12:00:00Z`) + seq++,
  side,
  qty,
  fiat,
  txid: `t${seq}`,
});
const near = (a: number, b: number) => expect(Math.round(a * 100) / 100).toBe(b);

describe('HMRC share pooling: worked examples', () => {
  test('section 104 pool at average cost', () => {
    // Pool: 100 for £1,000 + 100 for £3,000 = 200 at £20 each. Sell 50 for £2,500: cost £1,000, gain £1,500.
    // Then sell the other 150 for £4,500: cost £3,000, gain £1,500.
    const d = computeGains(
      [ev('2026-01-01', 'acquire', 100, 1000), ev('2026-02-01', 'acquire', 100, 3000), ev('2026-05-01', 'dispose', 50, 2500), ev('2026-09-01', 'dispose', 150, 4500)],
      'hmrc',
    );
    expect(d.map((x) => [x.cost, x.gain, x.matches[0].rule])).toEqual([
      [1000, 1500, 's104'],
      [3000, 1500, 's104'],
    ]);
  });

  test('same-day rule beats the pool', () => {
    // Pool 100 at £10. On 1 Jun buy 10 for £500 and sell 10 for £400: matched to that day's buy, loss £100.
    const d = computeGains(
      [ev('2026-01-01', 'acquire', 100, 1000), ev('2026-06-01', 'acquire', 10, 500), ev('2026-06-01', 'dispose', 10, 400)],
      'hmrc',
    );
    expect(d[0]).toMatchObject({ cost: 500, gain: -100, matches: [{ rule: 'same-day', qty: 10 }] });
  });

  test('same-day disposals and acquisitions are each treated as one', () => {
    const d = computeGains(
      [ev('2026-06-01', 'acquire', 4, 40), ev('2026-06-01', 'acquire', 6, 80), ev('2026-06-01', 'dispose', 5, 100), ev('2026-06-01', 'dispose', 5, 100)],
      'hmrc',
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ qty: 10, proceeds: 200, cost: 120, gain: 80 });
    expect(d[0].txids).toHaveLength(2);
  });

  test('30-day bed-and-breakfast rule: a buy back within 30 days is matched first, and stays out of the pool', () => {
    // Pool 150 for £3,000 (£20 each). Sell 20 on 1 Jul for £600; buy 20 back on 15 Jul for £700.
    // The sale is matched to the buy-back: cost £700, loss £100 (not £400 cost from the pool).
    // Selling the remaining 150 later uses the untouched pool: cost £3,000.
    const d = computeGains(
      [ev('2026-01-01', 'acquire', 150, 3000), ev('2026-07-01', 'dispose', 20, 600), ev('2026-07-15', 'acquire', 20, 700), ev('2026-09-01', 'dispose', 150, 4500)],
      'hmrc',
    );
    expect(d[0]).toMatchObject({ cost: 700, gain: -100, matches: [{ rule: 'bed-and-breakfast', qty: 20, acquiredOn: '2026-07-15' }] });
    expect(d[1]).toMatchObject({ cost: 3000, gain: 1500, matches: [{ rule: 's104', qty: 150 }] });
  });

  test('partial bed-and-breakfast: the rest comes from the pool', () => {
    // Pool 100 at £10. Sell 50 for £1,000 on 1 Mar; buy 20 for £300 on 20 Mar.
    // 20 matched at £300, 30 from the pool at £300: cost £600, gain £400. Pool left: 70 at £10 (the March buy is used up).
    const d = computeGains(
      [ev('2026-01-01', 'acquire', 100, 1000), ev('2026-03-01', 'dispose', 50, 1000), ev('2026-03-20', 'acquire', 20, 300), ev('2026-12-01', 'dispose', 70, 1400)],
      'hmrc',
    );
    expect(d[0].matches.map((m) => [m.rule, m.qty, m.cost])).toEqual([
      ['bed-and-breakfast', 20, 300],
      ['s104', 30, 300],
    ]);
    expect(d[0].gain).toBe(400);
    expect(d[1]).toMatchObject({ cost: 700, gain: 700 });
  });

  test('day 30 counts, day 31 does not', () => {
    const in30 = computeGains([ev('2026-01-01', 'acquire', 10, 100), ev('2026-01-10', 'dispose', 10, 200), ev('2026-02-09', 'acquire', 10, 150)], 'hmrc');
    expect(in30[0].matches[0]).toMatchObject({ rule: 'bed-and-breakfast', cost: 150 });
    const in31 = computeGains([ev('2026-01-01', 'acquire', 10, 100), ev('2026-01-10', 'dispose', 10, 200), ev('2026-02-10', 'acquire', 10, 150)], 'hmrc');
    expect(in31[0].matches[0]).toMatchObject({ rule: 's104', cost: 100 });
  });

  test('a same-day match takes priority over an earlier disposal’s bed-and-breakfast claim', () => {
    // Sell 10 on 1 May; on 5 May buy 10 and sell 10. The 5 May buy goes to the 5 May sale (same day),
    // so the 1 May sale falls back to the pool.
    const d = computeGains(
      [ev('2026-01-01', 'acquire', 10, 50), ev('2026-05-01', 'dispose', 10, 100), ev('2026-05-05', 'acquire', 10, 90), ev('2026-05-05', 'dispose', 10, 95)],
      'hmrc',
    );
    expect(d[0].matches[0]).toMatchObject({ rule: 's104', cost: 50 });
    expect(d[1].matches[0]).toMatchObject({ rule: 'same-day', cost: 90 });
  });

  test('nothing to match: cost 0 and flagged', () => {
    const d = computeGains([ev('2026-01-01', 'dispose', 5, 50)], 'hmrc');
    expect(d[0]).toMatchObject({ cost: 0, gain: 50, matches: [{ rule: 'unmatched' }] });
    expect(d[0].flags[0]).toMatch(/no matching acquisition/);
  });

  test('assets are pooled separately', () => {
    const d = computeGains([ev('2026-01-01', 'acquire', 10, 100, 'A'), ev('2026-01-01', 'acquire', 10, 900, 'B'), ev('2026-02-01', 'dispose', 10, 500, 'A')], 'hmrc');
    expect(d[0]).toMatchObject({ asset: 'A', cost: 100, gain: 400 });
  });
});

describe('FIFO', () => {
  test('oldest lots first, across lots', () => {
    // 10 at £10, then 10 at £20. Sell 15 for £450: cost 10×£10 + 5×£20 = £200, gain £250. Sell 5 more: cost £100.
    const d = computeGains(
      [ev('2026-01-01', 'acquire', 10, 100), ev('2026-02-01', 'acquire', 10, 200), ev('2026-03-01', 'dispose', 15, 450), ev('2026-04-01', 'dispose', 5, 50)],
      'fifo',
    );
    expect(d[0]).toMatchObject({ cost: 200, gain: 250 });
    expect(d[0].matches.map((m) => [m.qty, m.cost, m.acquiredOn])).toEqual([
      [10, 100, '2026-01-01'],
      [5, 100, '2026-02-01'],
    ]);
    expect(d[1]).toMatchObject({ cost: 100, gain: -50 });
  });
  test('no bed-and-breakfast under FIFO', () => {
    const d = computeGains([ev('2026-01-01', 'acquire', 10, 100), ev('2026-01-10', 'dispose', 10, 200), ev('2026-01-15', 'acquire', 10, 150)], 'fifo');
    expect(d[0]).toMatchObject({ cost: 100, gain: 100 });
  });
});

describe('tax years, days, totals', () => {
  test('UK tax year runs 6 April to 5 April', () => {
    expect(taxYearOf('2026-04-05', true)).toBe('2025-26');
    expect(taxYearOf('2026-04-06', true)).toBe('2026-27');
    expect(taxYearOf('2026-04-05', false)).toBe('2026');
  });
  test('UK days are London days', () => {
    expect(dayIn(Date.parse('2026-06-30T23:30:00Z'), true)).toBe('2026-07-01');
    expect(dayIn(Date.parse('2026-06-30T23:30:00Z'), false)).toBe('2026-06-30');
  });
  test('totals split gains and losses', () => {
    const d = computeGains([ev('2026-01-01', 'acquire', 10, 100), ev('2026-02-01', 'dispose', 5, 100), ev('2026-03-01', 'dispose', 5, 20)], 'hmrc');
    expect(totalsByAsset(d)[0]).toMatchObject({ disposals: 2, gains: 50, losses: 30, net: 20 });
  });
});

describe('prices', () => {
  test('Bank of England CSV and nearest earlier day', () => {
    const m = parseBoeCsv('DATE,XUDLUSS\r\n04 Sep 2026,1.3515\r\n07 Sep 2026,1.3600\r\n');
    expect(m.get('2026-09-04')).toBe(1.3515);
    expect(nearestPrevious(m, '2026-09-06')).toBe(1.3515); // weekend → Friday
    expect(nearestPrevious(m, '2026-09-01')).toBeUndefined(); // never a later day
    near(bsvFiat('2026-09-06', new Map([['2026-09-05', 27.03]]), 'GBP', m)!, 20);
  });
});

describe('ledger from History rows', () => {
  const row = (p: Partial<HistoryRow>): HistoryRow => ({
    txid: `r${seq++}`,
    time: Date.parse('2026-05-01T10:00:00Z'),
    direction: 'out',
    amountSats: 0,
    feeSats: 0,
    counterparty: '',
    label: '',
    note: '',
    confirmations: 1,
    usdRate: 50,
    ...p,
  });
  const price = (r: HistoryRow) => r.usdRate;
  const day = (ms: number) => dayIn(ms, false);

  test('buying a token disposes of BSV and acquires the token at BSV paid + fee', () => {
    const r = row({ amountSats: -10_000_000, feeSats: 100, type: 'buy', category: 'token', asset: { kind: 'token', id: 'T_0', qty: '204', symbol: '$T' } });
    const { events } = buildLedger([r], price, day);
    expect(events.map((e) => [e.asset, e.side, e.qty, Math.round(e.fiat * 100) / 100])).toEqual([
      ['token:T_0', 'acquire', 204, 5],
      ['BSV', 'dispose', 10_000_100, 5],
    ]);
  });
  test('selling a token disposes of it and acquires BSV', () => {
    const r = row({ direction: 'in', amountSats: 20_000_000, type: 'sell', category: 'token', asset: { kind: 'token', id: 'T_0', qty: '204' } });
    const { events } = buildLedger([r], price, day);
    expect(events.map((e) => [e.asset, e.side, e.fiat])).toEqual([
      ['token:T_0', 'dispose', 10],
      ['BSV', 'acquire', 10],
    ]);
  });
  test('airdrop at zero cost unless a cost is entered; own-wallet moves are left out', () => {
    const a = row({ direction: 'in', amountSats: 1, type: 'transfer-in', category: 'token', asset: { kind: 'token', id: 'T_0', qty: '5' } });
    expect(buildLedger([a], price, day).events[0]).toMatchObject({ side: 'acquire', fiat: 0 });
    expect(buildLedger([a], price, day, { ownWallet: [], lotValue: { [`${a.txid}|token:T_0`]: 12 } }).events[0]).toMatchObject({ fiat: 12 });
    const send = row({ amountSats: -5_000_000, feeSats: 50 });
    expect(buildLedger([send], price, day, { ownWallet: [send.txid], lotValue: {} }).events).toHaveLength(0);
  });
  test('end to end: buy then sell a token, and the accountant CSV', () => {
    const buy = row({ time: Date.parse('2026-05-01T10:00:00Z'), amountSats: -10_000_000, type: 'buy', category: 'token', asset: { kind: 'token', id: 'T_0', qty: '100', symbol: '$T' } });
    const sell = row({ time: Date.parse('2026-08-01T10:00:00Z'), direction: 'in', amountSats: 30_000_000, usdRate: 40, type: 'sell', category: 'token', asset: { kind: 'token', id: 'T_0', qty: '100', symbol: '$T' } });
    const d = computeGains(buildLedger([buy, sell], price, day).events, 'hmrc').filter((x) => x.asset !== 'BSV');
    expect(d[0]).toMatchObject({ proceeds: 12, cost: 5, gain: 7 });
    const csv = gainsCsv(d, { uk: true, currency: 'GBP', method: 'HMRC share pooling' });
    expect(csv.split('\r\n')[0]).toBe(
      '﻿tax_year,date_of_disposal,asset,asset_id,quantity,currency,disposal_proceeds,allowable_cost,gain_or_loss,matching,acquisition_dates,txids,notes',
    );
    expect(csv).toContain('2026-27,2026-08-01,$T,token:T_0,100,GBP,12.00,5.00,7.00,s104,');
    expect(csv).toContain('not tax advice');
  });
});
