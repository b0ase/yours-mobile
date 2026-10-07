import { describe, expect, test } from 'bun:test';
import {
  defaultScreens,
  moveToScreen,
  parseScreens,
  placeFirstFree,
  reconcile,
  removeKey,
  renameScreen,
  reorderScreen,
  SCREEN_SLOTS,
  screenOf,
  screenTitle,
  serialiseScreens,
  tidy,
} from './appScreens';
import { dockKeyOf } from './appScreensStore';
import { defaultDock, removeFromDock, addToDock } from './dockModel';
import { appIndexForPath, appScreenRoute, pageForPath, stripFor } from './screens';

const REQUIRED = ['screen:wallet', 'screen:exchange', 'screen:feed', 'screen:chat'];
const dockKeys = (store = false, items = defaultDock(store)) => new Set(items.map(dockKeyOf));
const base = () =>
  defaultScreens(['https://a.example', 'https://b.example'], ['https://b1', 'https://b2'], ['https://g1']);
const everywhere = (s: ReturnType<typeof base>) => s.screens.flatMap((x) => x.items);

describe('app screens (Option B)', () => {
  test('default / migration: Home = favourites, then bApps (agent first), then Games; titles', () => {
    const s = base();
    expect(s.screens.map((x, i) => screenTitle(x, i))).toEqual(['Home', 'bApps', 'Games']);
    expect(s.screens[1].items[0]).toBe('sys:agent');
    // A bApp already on Home is not repeated on screen 2.
    const s2 = defaultScreens(['https://b1'], ['https://b1', 'https://b2'], []);
    expect(s2.screens[1].items).toEqual(['sys:agent', 'https://b2']);
    expect(screenTitle({ items: [] }, 3)).toBe('Apps 4');
  });

  test('a tile is in one place: moving takes it off its old screen; a new last screen; empty end screens go', () => {
    let s = moveToScreen(base(), 'https://a.example', 1);
    expect(screenOf(s, 'https://a.example')).toBe(1);
    expect(everywhere(s).filter((k) => k === 'https://a.example')).toHaveLength(1);
    s = moveToScreen(s, 'https://a.example', s.screens.length);
    expect(s.screens).toHaveLength(4);
    s = moveToScreen(s, 'https://a.example', 0);
    expect(s.screens).toHaveLength(3); // the emptied last screen is removed
  });

  test('first free slot fills the first screen with room, else a new screen', () => {
    let s = tidy([{ items: Array.from({ length: SCREEN_SLOTS }, (_, i) => `k${i}`) }]);
    s = { v: 1, screens: s };
    const placed = placeFirstFree(s, 'x');
    expect(placed.screens).toHaveLength(2);
    expect(placed.screens[1].items).toEqual(['x']);
    expect(placeFirstFree(placed, 'x')).toBe(placed);
  });

  test('dock ⇄ screens round trip: never both, Wallet never lost', () => {
    let dock = defaultDock(false);
    // Default: Wallet, Exchange, Feed, Chat in the dock, none on a screen.
    let s = reconcile(base(), dockKeys(false, dock), REQUIRED);
    for (const k of REQUIRED) expect(screenOf(s, k)).toBe(-1);
    // Remove Wallet from the dock: it lands on a screen (first free slot: Home).
    dock = removeFromDock(dock, { kind: 'screen', id: 'wallet' });
    s = reconcile(s, dockKeys(false, dock), REQUIRED);
    expect(screenOf(s, 'screen:wallet')).toBe(0);
    // Add it back: off the screens again.
    const r = addToDock(dock, { kind: 'screen', id: 'wallet' }, false);
    expect(r.ok).toBe(true);
    s = reconcile(s, dockKeys(false, r.items), REQUIRED);
    expect(screenOf(s, 'screen:wallet')).toBe(-1);
    // An app moved into the dock leaves its screen; out of the dock, it is placed again.
    const withApp = [
      ...removeFromDock(r.items, { kind: 'screen', id: 'chat' }),
      { kind: 'app' as const, url: 'https://a.example', name: 'A' },
    ];
    s = reconcile(s, dockKeys(false, withApp), REQUIRED);
    expect(screenOf(s, 'https://a.example')).toBe(-1);
    expect(screenOf(s, 'screen:chat')).toBeGreaterThanOrEqual(0);
    s = placeFirstFree(s, 'https://a.example');
    expect(screenOf(s, 'https://a.example')).toBeGreaterThanOrEqual(0);
    // Whatever is removed from the dock, every page tile is somewhere, exactly once.
    for (const i of defaultDock(false)) {
      const d = removeFromDock(defaultDock(false), i);
      const t = reconcile(base(), dockKeys(false, d), REQUIRED);
      for (const k of REQUIRED) expect(Number(d.some((x) => dockKeyOf(x) === k)) + Number(screenOf(t, k) >= 0)).toBe(1);
    }
  });

  test('a removed Wallet comes back even if it was taken off every screen', () => {
    const dock = removeFromDock(defaultDock(false), { kind: 'screen', id: 'wallet' });
    let s = reconcile(base(), dockKeys(false, dock), REQUIRED);
    s = removeKey(s, 'screen:wallet');
    expect(screenOf(reconcile(s, dockKeys(false, dock), REQUIRED), 'screen:wallet')).toBe(0);
  });

  test('reorder, rename, storage round trip; corrupt → null', () => {
    let s = reorderScreen(base(), 0, 1, 0);
    expect(s.screens[0].items).toEqual(['https://b.example', 'https://a.example']);
    s = renameScreen(s, 2, '  Play  ');
    expect(screenTitle(s.screens[2], 2)).toBe('Play');
    expect(parseScreens(serialiseScreens(s))).toEqual(s);
    expect(parseScreens('{nope')).toBeNull();
    expect(parseScreens('{"v":2,"screens":[]}')).toBeNull();
    expect(parseScreens(null)).toBeNull();
  });

  test('routes: only app screens swipe; old Apps/Games routes land on screens 2/3; pages are not screens', () => {
    expect(appScreenRoute(0)).toBe('/m/home');
    expect(appScreenRoute(2)).toBe('/m/screen/3');
    expect(appIndexForPath('/m/home', 3)).toBe(0);
    expect(appIndexForPath('/m/screen/3', 3)).toBe(2);
    expect(appIndexForPath('/m/screen/9', 3)).toBe(2);
    expect(appIndexForPath('/browser', 3)).toBe(1);
    expect(appIndexForPath('/m/games', 1)).toBe(0);
    expect(appIndexForPath('/bsv-wallet', 3)).toBeNull();
    const strip = stripFor(false, true);
    expect(pageForPath('/bsv-wallet', strip)?.id).toBe('wallet');
    expect(pageForPath('/m/feed', strip)?.id).toBe('feed');
    expect(pageForPath('/m/home', strip)).toBeNull();
  });
});
