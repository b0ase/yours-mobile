import { describe, expect, test } from 'bun:test';
import {
  CREDITS_TERMS,
  addPending,
  depositOutcome,
  entryAmount,
  entryLabel,
  parseAmount,
  parseCreditsInfo,
  parseLedger,
  prunePending,
  rawAmount,
  removePending,
  topUpCheck,
  topUpCost,
} from './credits';

const live = {
  enabled: true,
  tokenId: 'a'.repeat(64) + '_0',
  treasury: '1Treasury',
  priceSats: 100,
  decimals: 0,
  balance: 42,
};

describe('credits info', () => {
  test('unconfigured server reads as coming soon', () => {
    expect(parseCreditsInfo({ enabled: false, tokenId: null, treasury: null, priceSats: null }).enabled).toBe(false);
    expect(parseCreditsInfo(null).enabled).toBe(false);
    expect(parseCreditsInfo({ enabled: true, tokenId: '', treasury: 'x' }).enabled).toBe(false);
  });
  test('live config and balance', () => {
    const i = parseCreditsInfo(live);
    expect(i.enabled).toBe(true);
    expect(i.balance).toBe(42);
    expect(i.priceSats).toBe(100);
  });
  test('junk numbers are ignored', () => {
    const i = parseCreditsInfo({ ...live, balance: -3, priceSats: 'lots', decimals: 1.5 });
    expect(i.balance).toBe(0);
    expect(i.priceSats).toBeNull();
    expect(i.decimals).toBe(0);
  });
  test('terms say no dividends and no cash out', () => {
    expect(CREDITS_TERMS).toContain("don't pay dividends");
    expect(CREDITS_TERMS).toContain("can't be cashed out");
  });
});

describe('top up', () => {
  test('amount parsing', () => {
    expect(parseAmount('25')).toEqual({ ok: true, credits: 25 });
    expect(parseAmount('1,000').ok).toBe(true);
    expect(parseAmount('0').ok).toBe(false);
    expect(parseAmount('2.5').ok).toBe(false);
    expect(parseAmount('abc').ok).toBe(false);
    expect(parseAmount('99999999').ok).toBe(false);
  });
  test('cost only when priced', () => {
    expect(topUpCost(25, 100)).toBe(2500);
    expect(topUpCost(25, null)).toBeNull();
    expect(topUpCost(3, 0.5)).toBe(2);
  });
  test('raw amount honours decimals', () => {
    expect(rawAmount(5, 0)).toBe(BigInt(5));
    expect(rawAmount(5, 2)).toBe(BigInt(500));
  });
  test('checks', () => {
    const i = parseCreditsInfo(live);
    expect(topUpCheck(parseCreditsInfo({}), 1, null)).toBe('Credits are coming soon');
    expect(topUpCheck(i, 10, BigInt(5))).toContain("don't have");
    expect(topUpCheck(i, 5, BigInt(5))).toBeNull();
    expect(topUpCheck(i, 5, null)).toBeNull();
  });
  test('deposit outcome', () => {
    expect(depositOutcome(200, { balance: 10 })).toBe('credited');
    expect(depositOutcome(202, { pending: true })).toBe('pending');
    expect(depositOutcome(200, { pending: true })).toBe('pending');
    expect(depositOutcome(400, { error: 'x' })).toBe('failed');
  });
  test('pending list', () => {
    let p = addPending([], 't1', 5, 1000);
    p = addPending(p, 't1', 5, 2000);
    expect(p.length).toBe(1);
    p = addPending(p, 't2', 3, 1000);
    expect(removePending(p, 't1').map((x) => x.txid)).toEqual(['t2']);
    expect(prunePending(p, 1000 + 8 * 86_400_000)).toEqual([]);
  });
});

describe('history', () => {
  test('ledger parsing and labels', () => {
    const rows = parseLedger({
      entries: [
        { id: '2', kind: 'debit', app: 'bchat', action: 'ai-turn', units: 3, balanceAfter: 7, createdAt: 't' },
        { id: '1', kind: 'deposit', units: 10, txid: 'ab', balanceAfter: 10, createdAt: 't' },
        { id: '0', kind: 'withdrawal', units: 1 },
        { id: 'x', kind: 'debit', units: 0 },
      ],
    });
    expect(rows.length).toBe(2);
    expect(entryLabel(rows[0])).toBe('bchat · ai-turn');
    expect(entryAmount(rows[0])).toBe('−3');
    expect(entryLabel(rows[1])).toBe('Top up');
    expect(entryAmount(rows[1])).toBe('+10');
    expect(parseLedger({ entries: 'no' })).toEqual([]);
  });
});
