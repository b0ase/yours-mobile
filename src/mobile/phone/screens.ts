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
  { id: 'apps', label: 'Apps', route: '/browser', aliases: ['/m/apps'], legacyIds: ['browser'] },
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
