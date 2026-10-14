import { describe, expect, test } from 'bun:test';
import {
  FEEDS,
  FEED_COLORS,
  FIXED_ROW,
  MAX_PINNED,
  PINS_KEY,
  cleanPins,
  feedColor,
  feedGroups,
  hasCustomView,
  loadPins,
  migrateFeedId,
  rowFeeds,
  savePins,
  stepFeed,
  swipeDir,
  togglePin,
} from './feeds';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('feed colours', () => {
  test('the basic suite is red, green, blue; bRadio orange', () => {
    expect(feedColor('bmovies')).toBe('#E5484D');
    expect(feedColor('bnews')).toBe('#30A46C');
    expect(feedColor('bmusic')).toBe('#3E8BFF');
    expect(feedColor('bradio')).toBe('#F76B15');
  });
  test('every bApp colour is a #rrggbb and bApp colours (bar gold) are distinct', () => {
    for (const c of Object.values(FEED_COLORS)) expect(c).toMatch(/^#[0-9A-F]{6}$/i);
    const bapps = FEEDS.filter((f) => f.group === 'bapps' && f.color !== '#FFD24D').map((f) => f.color);
    expect(new Set(bapps).size).toBe(bapps.length);
  });
  test('an unknown feed is gold', () => expect(feedColor('nope')).toBe('#FFD24D'));
});

describe('feed list', () => {
  test('bWalletX build: core, then bApps led by bMovies, bNews, bMusic, then Other', () => {
    expect(FEEDS.slice(0, 4).map((f) => f.id)).toEqual(['home', 'bmovies', 'bnews', 'bmusic']);
    const groups = feedGroups();
    expect(groups.map((g) => g.label)).toEqual(['bApps', 'Other']);
    for (const id of ['bradio', 'bgame', 'b3d', 'bphotos', 'bbooks', 'writer', 'bmail', 'bsocial'])
      expect(groups[0].feeds.map((f) => f.id)).toContain(id);
    expect(groups[1].feeds.map((f) => f.id)).toContain('vexvoid');
    expect(
      groups[1].feeds.some((f) => f.id.startsWith('b') && f.id !== 'bcorp' && f.id !== 'bitgit' && f.id !== 'bsvex'),
    ).toBe(false);
  });
  test('cherryx and aigf are never listed; ids are unique', () => {
    for (const id of ['cherryx', 'aigf']) expect(FEEDS.map((f) => f.id)).not.toContain(id);
    expect(new Set(FEEDS.map((f) => f.id)).size).toBe(FEEDS.length);
  });
  test('only the built-in views are custom; the rest are bChatX feeds', () => {
    expect(hasCustomView('bnews')).toBe(true);
    expect(hasCustomView('bradio')).toBe(false);
  });
});

describe('feed row', () => {
  test('fixed row first, then pins; old saved rows with core feeds still load', () => {
    expect(rowFeeds([])).toEqual([...FIXED_ROW]);
    expect(rowFeeds(['bradio', 'bnews'])).toEqual([...FIXED_ROW, 'bradio']);
    expect(cleanPins(['following', 'bradio', 'bradio', 'nope', 'cherryx', 'bmail'])).toEqual(['bradio', 'bmail']);
    expect(cleanPins('junk')).toEqual([]);
  });
  test('toggling pins: fixed feeds stay; a full row drops the oldest', () => {
    expect(togglePin([], 'bnews')).toEqual([]);
    expect(togglePin(['bradio'], 'bradio')).toEqual([]);
    const full = FEEDS.filter((f) => !FIXED_ROW.includes(f.id))
      .slice(0, MAX_PINNED)
      .map((f) => f.id);
    expect(togglePin(full, 'vexvoid')).toEqual([...full.slice(1), 'vexvoid']);
  });
  test('Following and For you are one Home chip; old ids migrate to it', () => {
    expect(FIXED_ROW[0]).toBe('home');
    expect(FEEDS.some((f) => f.id === 'following' || f.id === 'foryou')).toBe(false);
    expect(migrateFeedId('following')).toBe('home');
    expect(migrateFeedId('foryou')).toBe('home');
    expect(migrateFeedId('bnews')).toBe('bnews');
    expect(cleanPins(['foryou', 'bradio'])).toEqual(['bradio']);
    expect(hasCustomView('home')).toBe(true);
  });
  test('pins persist per device', () => {
    const store = memory();
    expect(loadPins(store)).toEqual([]);
    savePins(['bradio', 'bmail'], store);
    expect(store.getItem(PINS_KEY)).toBe('["bradio","bmail"]');
    expect(loadPins(store)).toEqual(['bradio', 'bmail']);
  });
  test('swiping steps through the row, plus the open feed when it is not in it', () => {
    expect(stepFeed([], 'home', 1)).toBe(rowFeeds([])[1]);
    expect(stepFeed([], 'home', -1)).toBeNull();
    expect(stepFeed(['bradio'], 'bmusic', 1)).toBe('bradio');
    expect(stepFeed(['bradio'], 'bradio', 1)).toBeNull();
    expect(stepFeed([], 'bmail', -1)).toBe('bmusic');
  });
  test('a left swipe is next, a right swipe previous, a scroll is neither', () => {
    expect(swipeDir(-100, 10)).toBe(1);
    expect(swipeDir(100, 10)).toBe(-1);
    expect(swipeDir(-100, 90)).toBe(0);
    expect(swipeDir(-30, 0)).toBe(0);
  });
});
