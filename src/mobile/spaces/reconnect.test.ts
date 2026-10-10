import { describe, expect, test } from 'bun:test';
import { REJOIN_BUDGET_MS, REJOIN_DELAYS_MS, rejoinWithBackoff, SpaceOverError } from './reconnect';

const noSleep = async () => undefined;

describe('rejoinWithBackoff', () => {
  test('budget is about a minute and the first try is immediate', () => {
    expect(REJOIN_DELAYS_MS[0]).toBe(0);
    expect(REJOIN_BUDGET_MS).toBeGreaterThanOrEqual(55_000);
    expect(REJOIN_BUDGET_MS).toBeLessThanOrEqual(65_000);
    REJOIN_DELAYS_MS.slice(1).forEach((d, i) => expect(d).toBeGreaterThanOrEqual(REJOIN_DELAYS_MS[i]));
  });
  test('retries until an attempt succeeds', async () => {
    let n = 0;
    const out = await rejoinWithBackoff({
      attempt: async () => {
        if (++n < 3) throw new Error('net');
      },
      cancelled: () => false,
      sleep: noSleep,
    });
    expect(out).toBe('rejoined');
    expect(n).toBe(3);
  });
  test('gives up after the budget', async () => {
    let n = 0;
    const slept: number[] = [];
    const out = await rejoinWithBackoff({
      attempt: async () => {
        n++;
        throw new Error('net');
      },
      cancelled: () => false,
      sleep: async (ms) => void slept.push(ms),
    });
    expect(out).toBe('gave-up');
    expect(n).toBe(REJOIN_DELAYS_MS.length);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(REJOIN_BUDGET_MS);
  });
  test('stops at once when the Space is over', async () => {
    let n = 0;
    const out = await rejoinWithBackoff({
      attempt: async () => {
        n++;
        throw new SpaceOverError('ended');
      },
      cancelled: () => false,
      sleep: noSleep,
    });
    expect(out).toBe('ended');
    expect(n).toBe(1);
  });
  test('leaving cancels the loop', async () => {
    let n = 0;
    let gone = false;
    const out = await rejoinWithBackoff({
      attempt: async () => {
        n++;
        gone = true;
        throw new Error('net');
      },
      cancelled: () => gone,
      sleep: noSleep,
    });
    expect(out).toBe('cancelled');
    expect(n).toBe(1);
  });
});
