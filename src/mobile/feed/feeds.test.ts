import { describe, expect, test } from 'bun:test';
import {
  FEEDS,
  type FeedId,
  MAX_PINNED,
  PINS_KEY,
  cleanPins,
  loadPins,
  savePins,
  stepFeed,
  swipeDir,
  togglePin,
} from './feeds';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('feed picker', () => {
  test('bWalletX build lists Following, For you, bNews and bMovies', () => {
    expect(FEEDS.map((f) => f.id)).toEqual(['following', 'foryou', 'bnews', 'bmovies']);
  });

  test('pins: known, unique, at most MAX_PINNED; default row when nothing valid', () => {
    expect(cleanPins(['bnews', 'bnews', 'nope', 'foryou'])).toEqual(['bnews', 'foryou']);
    expect(cleanPins(null)).toEqual(FEEDS.slice(0, MAX_PINNED).map((f) => f.id));
    expect(cleanPins('junk')).toHaveLength(Math.min(MAX_PINNED, FEEDS.length));
  });

  test('toggling pins keeps at least one and drops the oldest when full', () => {
    expect(togglePin(['following', 'bnews'], 'bnews')).toEqual(['following']);
    expect(togglePin(['following'], 'following')).toEqual(['following']);
    expect(togglePin(['following', 'foryou', 'bnews'], 'bmovies')).toEqual(['following', 'foryou', 'bnews', 'bmovies']);
    expect(togglePin(['following', 'foryou', 'bnews', 'bmovies'], 'following').length).toBe(3);
    // A full row: the oldest pin makes room.
    expect(togglePin(['following', 'foryou', 'bnews', 'bmovies'], 'later' as FeedId)).toEqual([
      'foryou',
      'bnews',
      'bmovies',
      'later',
    ]);
  });

  test('pins persist per device', () => {
    const store = memory();
    expect(loadPins(store)).toEqual(cleanPins(null));
    savePins(['bmovies', 'bnews'], store);
    expect(store.getItem(PINS_KEY)).toBe('["bmovies","bnews"]');
    expect(loadPins(store)).toEqual(['bmovies', 'bnews']);
  });

  test('swiping steps through the row, plus the open feed when it is not pinned', () => {
    expect(stepFeed(['following', 'bnews'], 'following', 1)).toBe('bnews');
    expect(stepFeed(['following', 'bnews'], 'bnews', 1)).toBeNull();
    expect(stepFeed(['following', 'bnews'], 'following', -1)).toBeNull();
    expect(stepFeed(['following', 'bnews'], 'bmovies', -1)).toBe('bnews');
  });

  test('a left swipe is next, a right swipe previous, a scroll is neither', () => {
    expect(swipeDir(-100, 10)).toBe(1);
    expect(swipeDir(100, 10)).toBe(-1);
    expect(swipeDir(-100, 90)).toBe(0);
    expect(swipeDir(-30, 0)).toBe(0);
  });
});
