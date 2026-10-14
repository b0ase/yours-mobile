import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { parseShareLock } from './scripts';
import { shareTokenScript } from './token';
import { mayOpenBshares, nextStep, satsFor } from './placement';

const cert = {
  p: '403' as const,
  op: 'allot' as const,
  ticker: 'TEST',
  company: 'Test Co',
  shareClass: 'Ordinary',
  shares: 10,
  holder: 'alice',
  offerId: 'o1',
  allottedAt: '2026-10-14',
  register: 'https://example.invalid/r',
};

describe('$403 share token output', () => {
  test('the inscription wraps the lock and the lock still parses', () => {
    const d = PrivateKey.fromRandom().toPublicKey();
    const i = PrivateKey.fromRandom().toPublicKey();
    const s = shareTokenScript(cert, { directorPubKey: d, investorPubKey: i, unlockHeight: 1_000_000 });
    expect(parseShareLock(s)).toEqual({
      directorPubKey: d.toString(),
      investorPubKey: i.toString(),
      unlockHeight: 1_000_000,
    });
  });
});

describe('placement maths and gates', () => {
  test('sats = shares × £price ÷ £/BSV, rounded up', () => {
    // 1,000 shares at 5p with BSV at £40.00 → £50 → 1.25 BSV
    expect(satsFor(1000, 5, 4000)).toBe(125_000_000);
    expect(satsFor(1, 1, 3)).toBe(33_333_334);
    expect(() => satsFor(0, 5, 4000)).toThrow();
    expect(() => satsFor(1, 1.5, 4000)).toThrow();
  });
  test('only members and the director open bShares', () => {
    expect(mayOpenBshares({ role: 'member' })).toBe(true);
    expect(mayOpenBshares({ role: 'director' })).toBe(true);
    expect(mayOpenBshares({ role: null })).toBe(false);
    expect(mayOpenBshares(null)).toBe(false);
  });
  test('next steps', () => {
    expect(nextStep({ status: 'offered' }, 'investor')).toBe('Accept');
    expect(nextStep({ status: 'paid' }, 'investor')).toBeNull();
    expect(nextStep({ status: 'paid' }, 'director')).toBe('Approve allotment');
    expect(nextStep({ status: 'refund_due' }, 'director')).toBe('Record refund');
  });
});
