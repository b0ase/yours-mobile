import { describe, expect, test } from 'bun:test';
import { loungeFirst, pinnedRank } from './openRooms';

describe('Lounge pinned first (owner, 9 Oct 2026)', () => {
  test('the Lounge goes to the top, the rest keep their order', () => {
    const list = ['ABC', 'XYZ', 'LOUNGE', 'DEF'];
    expect(loungeFirst(list, (t) => t)).toEqual(['LOUNGE', 'ABC', 'XYZ', 'DEF']);
  });
  test('case and $ do not matter; no Lounge leaves the list as is', () => {
    expect(pinnedRank('$lounge')).toBe(0);
    expect(loungeFirst(['B', 'A'], (t) => t)).toEqual(['B', 'A']);
  });
});
