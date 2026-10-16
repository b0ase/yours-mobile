import { describe, expect, test } from 'bun:test';
import { ADD_ON_IDS, DEFAULT_BWEB, bwebContext, enabledAddOns, parseBWeb, toggleIn } from './bweb';

describe('bWeb settings', () => {
  test('bad or missing values fall back to defaults', () => {
    expect(parseBWeb(null)).toEqual(DEFAULT_BWEB);
    expect(parseBWeb({ dockHidden: 'x', addOns: { names: 'yes' }, privacy: 3 })).toEqual(DEFAULT_BWEB);
  });
  test('add-ons are off by default and parse only known ids', () => {
    expect(enabledAddOns(DEFAULT_BWEB)).toEqual([]);
    const s = parseBWeb({ addOns: { names: true, feed: true, evil: true } });
    expect(enabledAddOns(s)).toEqual(['names', 'feed']);
    expect(Object.keys(s.addOns).sort()).toEqual([...ADD_ON_IDS].sort());
  });
  test('hidden lists dedupe and drop non-strings', () => {
    expect(parseBWeb({ dockHidden: ['bmovies', 'bmovies', 3, ''] }).dockHidden).toEqual(['bmovies']);
    expect(toggleIn(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleIn(['a', 'b'], 'a', false)).toEqual(['b']);
  });
  test('context lists enabled add-ons and shares setup only when allowed', () => {
    expect(bwebContext(DEFAULT_BWEB)).toBe('');
    const s = parseBWeb({ addOns: { bmail: true }, feedHidden: ['bMovies'] });
    expect(bwebContext(s)).toContain('bMail drafting');
    expect(bwebContext(s)).not.toContain('bMovies');
    expect(bwebContext({ ...s, privacy: { shareScreen: true, shareSetup: true } })).toContain('bMovies');
  });
  test('screen sharing defaults on, setup sharing off', () => {
    expect(DEFAULT_BWEB.privacy).toEqual({ shareScreen: true, shareSetup: false });
  });
});
