import { describe, expect, test } from 'bun:test';
import {
  addTrade,
  checkBudget,
  executeTrade,
  freshBudget,
  loadBudget,
  loadTrades,
  removeTrade,
  saveBudget,
  saveTrades,
  spend,
  tradeSide,
  type Budget,
} from './swipeTrade';

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const NOON = new Date(2026, 9, 14, 12).getTime();
const TOMORROW = new Date(2026, 9, 15, 9).getTime();

describe('tradeSide: gesture → action', () => {
  test('swipe right buys, swipe left sells', () => {
    expect(tradeSide(120, 5)).toBe('buy');
    expect(tradeSide(-120, 5)).toBe('sell');
  });
  test('vertical or diagonal swipes never trade', () => {
    expect(tradeSide(10, -300)).toBeNull();
    expect(tradeSide(80, 70)).toBeNull();
  });
  test('short drags never trade', () => {
    expect(tradeSide(30, 0)).toBeNull();
    expect(tradeSide(-59, 0)).toBeNull();
  });
});

describe('budget', () => {
  test('first swipe asks, then trades until £1 is used', () => {
    let b: Budget = freshBudget(NOON);
    expect(checkBudget(b, NOON)).toBe('ask');
    b = { ...b, allowed: true };
    for (let i = 0; i < 100; i++) {
      expect(checkBudget(b, NOON)).toBe('ok');
      b = spend(b, NOON);
    }
    expect(checkBudget(b, NOON)).toBe('over');
  });
  test('a no stays a no', () => {
    expect(checkBudget({ ...freshBudget(NOON), allowed: false }, NOON)).toBe('denied');
  });
  test('a new day resets spend, keeps consent', () => {
    const b: Budget = { ...freshBudget(NOON), allowed: true, spentPence: 100 };
    expect(checkBudget(b, NOON)).toBe('over');
    expect(checkBudget(b, TOMORROW)).toBe('ok');
    expect(spend(b, TOMORROW).spentPence).toBe(1);
  });
  test('undo refunds, never below zero', () => {
    const b: Budget = { ...freshBudget(NOON), allowed: true, spentPence: 1 };
    expect(spend(b, NOON, -1).spentPence).toBe(0);
    expect(spend(spend(b, NOON, -1), NOON, -1).spentPence).toBe(0);
  });
  test('persists', () => {
    const s = memStore();
    saveBudget({ ...freshBudget(NOON), allowed: true, spentPence: 7 }, s);
    expect(loadBudget(NOON, s).spentPence).toBe(7);
    expect(loadBudget(TOMORROW, s)).toMatchObject({ allowed: true, spentPence: 0 });
  });
});

describe('mock trades', () => {
  test('records a 1p mock trade, newest first; undo removes it', async () => {
    const a = await executeTrade('ABYSS', 'buy', NOON);
    const b = await executeTrade('ABYSS', 'sell', NOON + 1);
    expect(a).toMatchObject({ ticker: 'ABYSS', side: 'buy', pence: 1, mock: true });
    const list = addTrade(addTrade([], a), b);
    expect(list.map((t) => t.side)).toEqual(['sell', 'buy']);
    expect(removeTrade(list, b.id)).toEqual([a]);
    const s = memStore();
    saveTrades(list, s);
    expect(loadTrades(s)).toEqual(list);
  });
});

describe('release switch', () => {
  test('ships with swipe trading hidden', async () => {
    const m = await import('./swipeTrade');
    expect(m.BMOVIES_SWIPE_TRADE_ENABLED).toBe(false);
  });
  test('ships without the card-art Subscribe (demo) tab', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../wallet/CardDesigner.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/label: 'Subscribe \(demo\)'/);
  });
});
