import { describe, expect, it } from 'bun:test';
import { SWIPE_OPEN_PX, allCardsSwipe } from './addressBookGesture';

describe('All cards sideways swipe', () => {
  it('a right pull opens the address book, like the carousel', () => {
    expect(allCardsSwipe({ dx: SWIPE_OPEN_PX, dy: 0 })).toBe('book');
    expect(allCardsSwipe({ dx: 140, dy: 30 })).toBe('book');
  });
  it('the other way opens bCal', () => {
    expect(allCardsSwipe({ dx: -SWIPE_OPEN_PX, dy: 0 })).toBe('calendar');
    expect(allCardsSwipe({ dx: -140, dy: -30 })).toBe('calendar');
  });
  it('short or mostly vertical drags (flying through the deck) do nothing', () => {
    expect(allCardsSwipe({ dx: SWIPE_OPEN_PX - 1, dy: 0 })).toBeNull();
    expect(allCardsSwipe({ dx: -(SWIPE_OPEN_PX - 1), dy: 0 })).toBeNull();
    expect(allCardsSwipe({ dx: 100, dy: 90 })).toBeNull();
    expect(allCardsSwipe({ dx: -100, dy: -200 })).toBeNull();
    expect(allCardsSwipe({ dx: 0, dy: 300 })).toBeNull();
  });
});
