import { describe, expect, test } from 'bun:test';
import { balances, filterRange, rangeFor, totals, type HistoryRow } from './txHistory';
import { hiddenByRange, updatedText } from './historyRefresh';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12);
const row = (txid: string, daysAgo: number, amountSats: number, feeSats = 0): HistoryRow => ({
  txid,
  time: NOW - daysAgo * DAY,
  direction: amountSats > 0 ? 'in' : amountSats < 0 ? 'out' : 'self',
  amountSats,
  feeSats,
  counterparty: '',
  label: '',
  note: '',
  confirmations: 10,
});

// The reported screen: 0.05449588 BSV, all of it received more than 30 days ago.
const history = [row('a', 90, 6_000_000), row('b', 60, -540_000, 412), row('c', 45, -10_000, 0)];

describe('History refresh: "0 transactions" with a balance', () => {
  test('reproduces the report: the 30-day range hides every row, opening = closing = balance', () => {
    const r = rangeFor('30d', NOW);
    const rows = filterRange(history, r);
    const bal = balances(history, r);
    expect(rows.length).toBe(0);
    expect(bal.opening).toBe(5_449_588);
    expect(bal.closing).toBe(5_449_588);
    expect(hiddenByRange(history, r)).toBe(3);
  });

  test('All time shows them and nothing is hidden', () => {
    const r = rangeFor('all', NOW);
    expect(filterRange(history, r).length).toBe(3);
    expect(hiddenByRange(history, r)).toBe(0);
  });

  test('closing - opening equals the net of the rows in range (fees included), for every preset', () => {
    for (const p of ['7d', '30d', 'year', 'all'] as const) {
      const r = rangeFor(p, NOW);
      const bal = balances(history, r);
      expect(bal.closing - bal.opening).toBe(totals(filterRange(history, r)).netSats);
    }
    const r = rangeFor('all', NOW);
    expect(balances(history, r).closing).toBe(6_000_000 - 540_000 - 412 - 10_000);
  });
});

describe('updatedText', () => {
  test('just now, minutes, then a time', () => {
    expect(updatedText(NOW, NOW)).toBe('Updated just now');
    expect(updatedText(NOW - 30_000, NOW)).toBe('Updated just now');
    expect(updatedText(NOW - 5 * 60_000, NOW)).toBe('Updated 5 min ago');
    expect(updatedText(NOW - 3 * 3_600_000, NOW)).toMatch(/^Updated \d/);
  });
});
