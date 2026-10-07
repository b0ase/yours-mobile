import { describe, expect, test } from 'bun:test';
import { neighbour, SCREENS, screenForPath, screenForSelected, stripFor } from './screens';

const ids = (s: { id: string }[]) => s.map((x) => x.id);

describe('phone layout screens', () => {
  test('strip order: Wallet · Exchange · HOME · Apps · Games · People · Feed · Chat', () => {
    expect(ids(stripFor(false, true))).toEqual([
      'wallet',
      'exchange',
      'home',
      'apps',
      'games',
      'people',
      'feed',
      'chat',
    ]);
  });

  test('store build: no Exchange, everything else in the same order', () => {
    expect(ids(stripFor(true, false))).toEqual(['wallet', 'home', 'apps', 'games', 'people', 'feed', 'chat']);
    // Even if the market flag were on, a store build hides Exchange.
    expect(ids(stripFor(true, true))).not.toContain('exchange');
    // And a build without the Market never shows it.
    expect(ids(stripFor(false, false))).not.toContain('exchange');
  });

  test('the agent is not a strip page (it is the hold-b sheet)', () => {
    expect(ids([...SCREENS])).not.toContain('agent');
  });

  test('legacy routes land on their screens', () => {
    const strip = stripFor(false, true);
    expect(screenForPath('/bsv-wallet', strip)?.id).toBe('wallet');
    expect(screenForPath('/ord-wallet', strip)?.id).toBe('wallet');
    expect(screenForPath('/m/market', strip)?.id).toBe('exchange');
    expect(screenForPath('/browser', strip)?.id).toBe('apps');
    expect(screenForPath('/m/feed', strip)?.id).toBe('feed');
    expect(screenForPath('/m/chat/', strip)?.id).toBe('chat');
    expect(screenForPath('/m/home', strip)?.id).toBe('home');
  });

  test('non-strip paths (settings, agent, /social, onboarding) are not pages', () => {
    for (const p of ['/m/settings', '/m/agent', '/m/media', '/social', '/', '/create-wallet'])
      expect(screenForPath(p)).toBeNull();
  });

  test('legacy bottom-bar ids map onto screens', () => {
    const strip = stripFor(false, true);
    expect(screenForSelected('bsv', strip)?.id).toBe('wallet');
    expect(screenForSelected('ords', strip)?.id).toBe('wallet');
    expect(screenForSelected('market', strip)?.id).toBe('exchange');
    expect(screenForSelected('browser', strip)?.id).toBe('apps');
    expect(screenForSelected('feed', strip)?.id).toBe('feed');
    expect(screenForSelected('settings', strip)).toBeNull();
    expect(screenForSelected(null, strip)).toBeNull();
    // Store build: 'market' has no page.
    expect(screenForSelected('market', stripFor(true, false))).toBeNull();
  });

  test('swipe neighbours stop at the ends', () => {
    const strip = stripFor(false, true);
    expect(neighbour('home', 1, strip)?.id).toBe('apps');
    expect(neighbour('home', -1, strip)?.id).toBe('exchange');
    expect(neighbour('wallet', -1, strip)).toBeNull();
    expect(neighbour('chat', 1, strip)).toBeNull();
    expect(neighbour('home', -1, stripFor(true, false))?.id).toBe('wallet');
  });
});
