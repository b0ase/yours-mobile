import { describe, expect, it } from 'bun:test';
import { SWIPE_OPEN_PX, closesAddressBook, opensAddressBook } from './addressBookGesture';
import { mergeNames } from './namesList';

describe('address book gesture', () => {
  it('opens on a right pull at the first card', () => {
    expect(opensAddressBook(0, { dx: SWIPE_OPEN_PX, dy: 0 })).toBe(true);
    expect(opensAddressBook(0.5, { dx: 120, dy: 20 })).toBe(true);
  });
  it('ignores short, vertical, leftward or mid-carousel drags', () => {
    expect(opensAddressBook(0, { dx: SWIPE_OPEN_PX - 1, dy: 0 })).toBe(false);
    expect(opensAddressBook(0, { dx: 100, dy: 90 })).toBe(false);
    expect(opensAddressBook(0, { dx: -100, dy: 0 })).toBe(false);
    expect(opensAddressBook(320, { dx: 100, dy: 0 })).toBe(false);
  });
  it('closes on a left swipe only', () => {
    expect(closesAddressBook({ dx: -SWIPE_OPEN_PX, dy: 0 })).toBe(true);
    expect(closesAddressBook({ dx: -50, dy: 0 })).toBe(false);
    expect(closesAddressBook({ dx: 100, dy: 0 })).toBe(false);
    expect(closesAddressBook({ dx: -100, dy: 100 })).toBe(false);
  });
});

describe('mergeNames', () => {
  it('joins bound state with listing state, sorted', () => {
    expect(
      mergeNames(
        [
          { name: 'zed', id: 'z', published: true },
          { name: 'amy', id: 'a', published: false },
        ],
        [
          { name: 'amy', id: 'a', listedSats: 500 },
          { name: 'bob', id: 'b', listedSats: null },
        ],
      ),
    ).toEqual([
      { name: 'amy', id: 'a', published: false, listedSats: 500 },
      { name: 'bob', id: 'b', published: false, listedSats: null },
      { name: 'zed', id: 'z', published: true, listedSats: null },
    ]);
  });
});
