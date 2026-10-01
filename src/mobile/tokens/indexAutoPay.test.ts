import { describe, expect, test } from 'bun:test';
import { INDEX_AUTOPAY_MAX_SATS, createIndexAutoPayGuard, decideIndexAutoPay, formatSmallUsd } from './indexAutoPay';
import { MAX_PER_MINUTE, WINDOW_MS } from '../settings/oneClick';
import { withOwnToken } from './indexFund';

const on = { indexAutoPayUsd: 0.1 as const };
const RATE = 20; // $20 / BSV → 3,030 sats ≈ $0.0006

describe('index auto-pay', () => {
  test('pays small fees under the threshold', () => {
    const d = decideIndexAutoPay(3030, RATE, on, [], 0);
    expect(d.ok).toBe(true);
  });
  test('off at 0', () => {
    expect(decideIndexAutoPay(3030, RATE, { indexAutoPayUsd: 0 }, [], 0)).toEqual({ ok: false, reason: 'off' });
  });
  test('unknown rate confirms', () => {
    for (const r of [0, NaN, -1, Infinity]) expect(decideIndexAutoPay(3030, r, on, [], 0).ok).toBe(false);
  });
  test('at or above the USD threshold confirms', () => {
    // 10,000 sats at $1,000/BSV = $0.10 exactly → not under
    expect(decideIndexAutoPay(10_000, 1000, on, [], 0)).toEqual({ ok: false, reason: 'over-limit' });
    expect(decideIndexAutoPay(9_999, 1000, on, [], 0).ok).toBe(true);
  });
  test('hard sats cap even at a tiny rate', () => {
    expect(decideIndexAutoPay(INDEX_AUTOPAY_MAX_SATS + 1, 0.0001, on, [], 0).ok).toBe(false);
  });
  test('bad amounts', () => {
    for (const s of [0, -5, 1.5, NaN]) expect(decideIndexAutoPay(s, RATE, on, [], 0).ok).toBe(false);
  });
  test('rate limit per minute, window slides', () => {
    const g = createIndexAutoPayGuard(() => on);
    for (let i = 0; i < MAX_PER_MINUTE; i++) expect(g.take(3030, RATE, 1000 + i).ok).toBe(true);
    expect(g.take(3030, RATE, 2000)).toEqual({ ok: false, reason: 'rate' });
    expect(g.peek(3030, RATE, 1000 + WINDOW_MS + 10).ok).toBe(true);
  });
  test('formats tiny USD', () => {
    expect(formatSmallUsd(0.000606)).toBe('$0.0006');
    expect(formatSmallUsd(0.12)).toBe('$0.12');
  });
  test('own token registry dedupes', () => {
    const l = withOwnToken([{ tokenId: 'a_0', ticker: 'A' }], { tokenId: 'a.0', ticker: 'A' });
    expect(l).toHaveLength(1);
  });
});
