/**
 * App screens, iPhone style (docs/PHONE-LAYOUT-PLAN.md §14.4, owner's Option B). Pure; unit-tested.
 *
 * Only app screens swipe: Home is the first; the user can have as many as they like. Each is a 4 × 6 grid of
 * tiles with a title. A tile key is an app URL, `screen:<id>` for a page tile (Wallet, Exchange, Feed, Chat…)
 * or `sys:agent` for the b agent. A tile lives in exactly one place: one app screen, or the dock.
 */
export type AppScreen = { title?: string; items: string[] };
export type AppScreensState = { v: 1; screens: AppScreen[] };

export const APP_SCREENS_KEY = 'bwallet:app-screens:v1';
export const SCREEN_SLOTS = 24;

/** Home is "Home"; others are "Apps 2", "Apps 3"… unless renamed. */
export const screenTitle = (s: AppScreen | undefined, i: number) =>
  s?.title?.trim() || (i === 0 ? 'Home' : `Apps ${i + 1}`);

/** Each key once (first place wins), at least one screen (Home), no empty screens at the end. */
export const tidy = (screens: readonly AppScreen[]): AppScreen[] => {
  const seen = new Set<string>();
  const out = screens.map((s) => ({
    ...(s.title ? { title: s.title } : {}),
    items: s.items.filter((k) => (seen.has(k) ? false : (seen.add(k), true))),
  }));
  while (out.length > 1 && out[out.length - 1].items.length === 0) out.pop();
  return out.length ? out : [{ items: [] }];
};

const state = (screens: AppScreen[]): AppScreensState => ({ v: 1, screens: tidy(screens) });

export const allKeys = (s: AppScreensState): Set<string> => new Set(s.screens.flatMap((x) => x.items));

/** Which screen a key is on (-1: none). */
export const screenOf = (s: AppScreensState, key: string) => s.screens.findIndex((x) => x.items.includes(key));

export const removeKey = (s: AppScreensState, key: string): AppScreensState =>
  state(s.screens.map((x) => ({ ...x, items: x.items.filter((k) => k !== key) })));

/** Move a tile to screen `index` (its end); index = screens.length makes a new last screen. */
export const moveToScreen = (s: AppScreensState, key: string, index: number): AppScreensState => {
  const screens = removeKey(s, key).screens.map((x) => ({ ...x, items: [...x.items] }));
  const i = Math.max(0, Math.min(index, screens.length));
  if (i === screens.length) screens.push({ items: [] });
  screens[i].items.push(key);
  return state(screens);
};

/** Put a tile in the first free slot (a screen with fewer than 24), else on a new last screen. No-op if placed. */
export const placeFirstFree = (s: AppScreensState, key: string): AppScreensState => {
  if (allKeys(s).has(key)) return s;
  const i = s.screens.findIndex((x) => x.items.length < SCREEN_SLOTS);
  return moveToScreen(s, key, i < 0 ? s.screens.length : i);
};

/** Reorder within one screen. */
export const reorderScreen = (s: AppScreensState, index: number, from: number, to: number): AppScreensState => {
  const screens = s.screens.map((x) => ({ ...x, items: [...x.items] }));
  const items = screens[index]?.items;
  if (!items || from < 0 || from >= items.length || to < 0 || to >= items.length) return s;
  const [k] = items.splice(from, 1);
  items.splice(to, 0, k);
  return state(screens);
};

export const renameScreen = (s: AppScreensState, index: number, title: string): AppScreensState =>
  state(s.screens.map((x, i) => (i === index ? { ...x, title: title.trim().slice(0, 24) || undefined } : x)));

/**
 * One place only, and nothing lost: keys in the dock come off the screens; every `required` key (the page tiles
 * this build has: Wallet first) that is neither in the dock nor on a screen goes in the first free slot.
 */
export const reconcile = (s: AppScreensState, dockKeys: ReadonlySet<string>, required: readonly string[]) => {
  let next = state(s.screens.map((x) => ({ ...x, items: x.items.filter((k) => !dockKeys.has(k)) })));
  for (const k of required) if (!dockKeys.has(k)) next = placeFirstFree(next, k);
  return next;
};

/** Saved JSON → screens; missing or corrupt → null (the caller builds the default / migrates). */
export const parseScreens = (raw: string | null): AppScreensState | null => {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<AppScreensState> | null;
    if (!p || p.v !== 1 || !Array.isArray(p.screens)) return null;
    const screens = p.screens
      .filter((x): x is AppScreen => !!x && typeof x === 'object' && Array.isArray((x as AppScreen).items))
      .map((x) => ({
        ...(typeof x.title === 'string' && x.title.trim() ? { title: x.title.trim().slice(0, 24) } : {}),
        items: x.items.filter((k): k is string => typeof k === 'string' && k.length > 0),
      }));
    return state(screens);
  } catch {
    return null;
  }
};

export const serialiseScreens = (s: AppScreensState) => JSON.stringify(s);

/**
 * The first layout, or the migration from the previous model (one Home of favourites; bApps and Games as their
 * own pages): Home = the saved favourites (or the default set); screen 2 "bApps" = our bApps not on Home, with
 * the b agent first; screen 3 "Games" = the games not on Home.
 */
export const defaultScreens = (home: readonly string[], bapps: readonly string[], games: readonly string[]) => {
  const onHome = new Set(home);
  return state([
    { items: [...home] },
    { title: 'bApps', items: ['sys:agent', ...bapps.filter((k) => !onHome.has(k))] },
    { title: 'Games', items: games.filter((k) => !onHome.has(k)) },
  ]);
};
