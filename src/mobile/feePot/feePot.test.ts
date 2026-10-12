import { describe, expect, test } from 'bun:test';
import {
  contributionOk,
  feeFor,
  feePotDecision,
  MAX_ACTIONS_PER_USER_DAY,
  MAX_FEE_SATS_PER_ACTION,
  monthlyBudgetSats,
  SPONSOR_OVERHEAD_BYTES,
} from './feePot';

const now = new Date('2026-10-12T12:00:00Z');
const newUser = new Date('2026-10-01T00:00:00Z');
const oldUser = new Date('2026-08-01T00:00:00Z');
const fresh = { userToday: 0, monthSats: 0 };
const BUDGET = monthlyBudgetSats(10, 20);

describe('fee pot monthly budget (USD)', () => {
  test('$10 at $20/BSV is 50,000,000 sats', () => expect(monthlyBudgetSats(10, 20)).toBe(50_000_000));
  test('$10 at $50/BSV is 20,000,000 sats', () => expect(monthlyBudgetSats(10, 50)).toBe(20_000_000));
  test('hard ceiling when the price crashes', () => expect(monthlyBudgetSats(10, 0.01)).toBe(100_000_000));
  test('custom ceiling', () => expect(monthlyBudgetSats(10, 20, 1_000_000)).toBe(1_000_000));
  test('no price means no budget', () => {
    expect(monthlyBudgetSats(10, 0)).toBe(0);
    expect(monthlyBudgetSats(10, NaN)).toBe(0);
    expect(monthlyBudgetSats(10, Infinity)).toBe(0);
  });
});

describe('fee pot limits', () => {
  test('fee rounds up at 100 sat/kB', () => {
    expect(feeFor(250)).toBe(25);
    expect(feeFor(251)).toBe(26);
    expect(feeFor(0)).toBe(1);
  });

  test('new user post is covered, fee includes the sponsor overhead', () => {
    const d = feePotDecision({ kind: 'post', userCreatedAt: newUser, now, txBytes: 300 }, fresh, BUDGET);
    expect(d).toEqual({ ok: true, feeSats: feeFor(300 + SPONSOR_OVERHEAD_BYTES) });
  });

  test('only listed kinds', () => {
    expect(feePotDecision({ kind: 'send', userCreatedAt: newUser, now, txBytes: 300 }, fresh, BUDGET)).toEqual({
      ok: false,
      reason: 'kind',
    });
  });

  test('after 30 days only artist plays are covered', () => {
    expect(feePotDecision({ kind: 'like', userCreatedAt: oldUser, now, txBytes: 300 }, fresh, BUDGET).ok).toBe(false);
    expect(feePotDecision({ kind: 'artist-play', userCreatedAt: oldUser, now, txBytes: 300 }, fresh, BUDGET).ok).toBe(
      true,
    );
  });

  test('per-user daily cap', () => {
    const d = feePotDecision(
      { kind: 'like', userCreatedAt: newUser, now, txBytes: 300 },
      { userToday: MAX_ACTIONS_PER_USER_DAY, monthSats: 0 },
    );
    expect(d).toEqual({ ok: false, reason: 'user-day' });
  });

  test('monthly budget', () => {
    const d = feePotDecision(
      { kind: 'like', userCreatedAt: newUser, now, txBytes: 300 },
      { userToday: 0, monthSats: 999 },
      1000,
    );
    expect(d).toEqual({ ok: false, reason: 'month-budget' });
  });

  test('big transactions are the user’s to pay', () => {
    expect(feePotDecision({ kind: 'post', userCreatedAt: newUser, now, txBytes: 100_000 }, fresh, BUDGET)).toEqual({
      ok: false,
      reason: 'too-big',
    });
  });

  test('the service pays fees only, never value', () => {
    expect(contributionOk(1000, 970, 30)).toBe(true);
    expect(contributionOk(1000, 900, 30)).toBe(false);
    expect(contributionOk(1000, 1001, 30)).toBe(false);
    expect(contributionOk(1000, 0, 1000)).toBe(false);
    expect(contributionOk(1000, 1000 - MAX_FEE_SATS_PER_ACTION, MAX_FEE_SATS_PER_ACTION)).toBe(true);
  });
});
