import { describe, expect, test } from 'bun:test';
import { isBappRoom } from './bappRooms';

describe('isBappRoom', () => {
  test('matches listed bApp room tickers, any case, with or without $', () => {
    expect(isBappRoom('BRADIO')).toBe(true);
    expect(isBappRoom('$bmovies')).toBe(true);
    expect(isBappRoom('bMusicX')).toBe(true);
  });
  test('the Help Desk and ordinary rooms are not bApp rooms', () => {
    expect(isBappRoom('LOUNGE')).toBe(false);
    expect(isBappRoom('STUFF')).toBe(false);
    expect(isBappRoom(null)).toBe(false);
  });
});
