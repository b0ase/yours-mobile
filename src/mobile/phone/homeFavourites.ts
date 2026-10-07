/**
 * The Apps › Home favourites list (BrowserPage.tsx owns it; with the phone layout it is only the starting point
 * of the app screens, phone/appScreens.ts). Parked extras from the round-4 preview are merged in when read.
 */
export const FAV_KEY = 'bwallet:favourite-apps';
export const FAVOURITES_CHANGED = 'bwallet:favourites-changed';
/** URLs to add to Home when the list is still the built-in default (merged by BrowserPage readFavourites). */
export const FAV_EXTRA_KEY = 'bwallet:favourite-apps:extra';

const readList = (key: string): string[] | null => {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const v: unknown = JSON.parse(raw);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
};

/** Merge parked URLs into a favourites list (and clear them). */
export const mergeFavouriteExtras = (favs: string[]): string[] => {
  try {
    const extra = readList(FAV_EXTRA_KEY);
    if (!extra?.length) return favs;
    localStorage.removeItem(FAV_EXTRA_KEY);
    const merged = [...favs, ...extra.filter((u) => !favs.includes(u))];
    localStorage.setItem(FAV_KEY, JSON.stringify(merged));
    return merged;
  } catch {
    return favs;
  }
};
