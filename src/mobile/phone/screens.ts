import { MARKET_ENABLED, STORE_BUILD, screensFor } from '../storeBuild';

/**
 * Phone layout swipe screens (docs/PHONE-LAYOUT-PLAN.md §3, §14). Pure: no React, so it is unit-tested.
 * Left to right: Wallet · Exchange · HOME · Apps · Games · People · Feed · Chat. The agent is not a page: it is the
 * hold-b sheet (Variant B), with /m/agent kept as a full-screen route outside the strip.
 */
export type ScreenId = 'wallet' | 'exchange' | 'home' | 'apps' | 'games' | 'people' | 'feed' | 'chat';

export type Screen = {
  id: ScreenId;
  label: string;
  route: string;
  /** Other paths that are this screen (old tab routes keep working). */
  aliases?: readonly string[];
  /** Old bottom-bar ids (tabs.ts) for this screen: TAB_TAP resets and upstream handleSelect callers. */
  legacyIds: readonly string[];
};

export const SCREENS: readonly Screen[] = [
  { id: 'wallet', label: 'Wallet', route: '/bsv-wallet', aliases: ['/ord-wallet'], legacyIds: ['bsv', 'ords'] },
  // Store builds have no Market at all: written inline so Rollup drops it from the store bundle.
  ...(MARKET_ENABLED
    ? [{ id: 'exchange', label: 'Exchange', route: '/m/market', legacyIds: ['market'] } satisfies Screen]
    : []),
  { id: 'home', label: 'Home', route: '/m/home', legacyIds: [] },
  { id: 'apps', label: 'bApps', route: '/browser', aliases: ['/m/apps'], legacyIds: ['browser'] },
  { id: 'games', label: 'Games', route: '/m/games', legacyIds: [] },
  { id: 'people', label: 'People', route: '/m/people', legacyIds: [] },
  { id: 'feed', label: 'Feed', route: '/m/feed', legacyIds: ['feed'] },
  { id: 'chat', label: 'Chat', route: '/m/chat', legacyIds: ['chat'] },
];

export const HOME: ScreenId = 'home';

/** The strip for a build: a store build has no Exchange (and no build without the Market shows it). */
export const stripFor = (store = STORE_BUILD, market = MARKET_ENABLED): Screen[] =>
  screensFor(SCREENS, store).filter((s) => market || s.id !== 'exchange');

export const STRIP: readonly Screen[] = stripFor();

export const screenById = (id: string, strip: readonly Screen[] = STRIP): Screen | undefined =>
  strip.find((s) => s.id === id);

/** The strip page a path shows, or null (settings, the agent, /social, onboarding… are not strip pages). */
export const screenForPath = (pathname: string, strip: readonly Screen[] = STRIP): Screen | null => {
  const path = pathname.replace(/\/+$/, '') || '/';
  return strip.find((s) => s.route === path || (s.aliases ?? []).includes(path)) ?? null;
};

/** A legacy bottom-bar id (tabs.ts) → its screen. 'settings', 'tools' and 'media' are not strip pages. */
export const screenForSelected = (selected: string | null, strip: readonly Screen[] = STRIP): Screen | null =>
  (selected && strip.find((s) => s.legacyIds.includes(selected))) || null;

/** The neighbour a swipe goes to: dir +1 = next (swipe left), -1 = previous. Null at either end. */
export const neighbour = (id: ScreenId, dir: 1 | -1, strip: readonly Screen[] = STRIP): Screen | null => {
  const i = strip.findIndex((s) => s.id === id);
  if (i < 0) return null;
  return strip[i + dir] ?? null;
};

/**
 * Option B (owner, round 5; plan §14.4): only app screens swipe. These pages open from their tiles or the dock,
 * with no swipe neighbours, and stay mounted once opened (phone/pager.tsx) so they reopen instantly.
 */
export const KEEP_PAGES: readonly ScreenId[] = ['wallet', 'exchange', 'people', 'feed', 'chat'];

/** The page (not an app screen) a path shows, or null. */
export const pageForPath = (pathname: string, strip: readonly Screen[] = STRIP): Screen | null => {
  const s = screenForPath(pathname, strip);
  return s && KEEP_PAGES.includes(s.id) ? s : null;
};

/** App screen i's route: Home is /m/home, the others /m/screen/2, /m/screen/3… */
export const appScreenRoute = (i: number) => (i <= 0 ? '/m/home' : `/m/screen/${i + 1}`);

/**
 * The app screen a path shows (index), or null. Old routes still land: Apps (/browser, /m/apps) on screen 2 and
 * Games (/m/games) on screen 3, or the last screen there is.
 */
export const appIndexForPath = (pathname: string, count: number): number | null => {
  const path = pathname.replace(/\/+$/, '') || '/';
  const last = Math.max(0, count - 1);
  if (path === '/m/home') return 0;
  const m = /^\/m\/screen\/(\d+)$/.exec(path);
  if (m) return Math.min(Math.max(0, Number(m[1]) - 1), last);
  if (path === '/browser' || path === '/m/apps') return Math.min(1, last);
  if (path === '/m/games') return Math.min(2, last);
  return null;
};
