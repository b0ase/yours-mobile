import { describe, expect, test } from 'bun:test';
import { groupPots, potName, PNEE_POT } from './pots';
import type { LockPlan } from './schedule';

const plan = (id: string, pot: string | undefined, sats: number, height: number, claimed = false): LockPlan => ({
  id,
  label: id,
  mode: 'date',
  txids: [id],
  createdAt: '2026-10-10T00:00:00Z',
  pieces: [{ height, sats, vout: 0, txid: id, claimed }],
  ...(pot ? { pot } : {}),
});

describe('Pots & Locks grouping', () => {
  test('names', () => {
    expect(potName(PNEE_POT)).toBe('PNEEs');
    expect(potName('pension')).toBe('Pension');
    expect(potName('nope')).toBe('Other locks');
  });
  test('groups by pot, PNEEs first, Other last, unknown pots fall into Other', () => {
    const pots = groupPots(
      [
        plan('a', undefined, 100, 900),
        plan('b', 'savings', 500, 900),
        plan('c', PNEE_POT, 50, 900),
        plan('d', 'pension', 1000, 2000),
        plan('e', 'bogus', 7, 900),
      ],
      1000,
    );
    expect(pots.map((p) => p.id)).toEqual([PNEE_POT, 'pension', 'savings', 'other']);
    const other = pots[3];
    expect(other.plans.map((p) => p.id)).toEqual(['a', 'e']);
    expect(other.locked).toBe(107);
    expect(other.ready).toBe(107);
    expect(pots[1].next).toBe(2000);
    expect(pots[1].ready).toBe(0);
  });
  test('claimed pieces are not counted as locked', () => {
    const [p] = groupPots([plan('x', PNEE_POT, 300, 10, true)], 1000);
    expect(p.locked).toBe(0);
    expect(p.ready).toBe(0);
  });
});
