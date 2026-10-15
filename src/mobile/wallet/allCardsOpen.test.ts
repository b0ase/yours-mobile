import { describe, expect, it } from 'bun:test';
import { requestAllCards, subscribeAllCards, swapRowButtons } from './allCardsOpen';

describe('All cards button', () => {
  it('a request reaches a subscriber until it unsubscribes', () => {
    const t = new EventTarget();
    let n = 0;
    const off = subscribeAllCards(() => n++, t);
    requestAllCards(t);
    expect(n).toBe(1);
    off();
    requestAllCards(t);
    expect(n).toBe(1);
  });
  it('All cards sits left of Swap, half each; full width without Swap; no row in the store', () => {
    expect(swapRowButtons(true, true)).toEqual(['allCards', 'swap']);
    expect(swapRowButtons(false, true)).toEqual(['allCards']);
    expect(swapRowButtons(true, false)).toEqual(['swap']);
    expect(swapRowButtons(false, false)).toEqual([]);
  });
});
