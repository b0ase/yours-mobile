import { describe, expect, it } from 'bun:test';
import { lockTabFor, subsForTab } from './subsList';
import type { Subscription } from './pots';

const sub = (id: string, status: Subscription['status'], nextDue: number) => ({ id, status, nextDue }) as Subscription;

describe('subsForTab', () => {
  it('puts paying subscriptions first by next payment, then paused, then finished', () => {
    const out = subsForTab([
      sub('c', 'cancelled', 1),
      sub('p', 'paused', 2),
      sub('a2', 'active', 50),
      sub('l', 'lowFunds', 10),
      sub('e', 'ended', 0),
    ]).map((s) => s.id);
    expect(out).toEqual(['l', 'a2', 'p', 'e', 'c']);
  });
});

describe('lockTabFor', () => {
  it('maps router paths to tabs', () => {
    expect(lockTabFor('/m/lock', true)).toBe('pots');
    expect(lockTabFor('/m/lock/locks', true)).toBe('locks');
    expect(lockTabFor('/m/lock/subscriptions/', true)).toBe('subscriptions');
  });
  it('falls back to Pots when subscriptions are off (store build)', () => {
    expect(lockTabFor('/m/lock/subscriptions', false)).toBe('pots');
  });
});
