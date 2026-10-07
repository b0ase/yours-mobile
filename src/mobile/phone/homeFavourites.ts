/**
 * The Apps › Home favourites list (BrowserPage.tsx owns it). The phone dock puts an app back on Home when it is
 * removed from the dock (owner, round 4: an app lives in the dock or on Home, never lost).
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

/** Add a URL to the Home favourites if it isn't there. */
export const ensureFavourite = (url: string) => {
  try {
    const favs = readList(FAV_KEY);
    if (favs) {
      if (!favs.includes(url)) localStorage.setItem(FAV_KEY, JSON.stringify([...favs, url]));
    } else {
      // Still the built-in defaults: park it; BrowserPage merges it in when it reads the list.
      const extra = readList(FAV_EXTRA_KEY) ?? [];
      if (!extra.includes(url)) localStorage.setItem(FAV_EXTRA_KEY, JSON.stringify([...extra, url]));
    }
    window.dispatchEvent(new Event(FAVOURITES_CHANGED));
  } catch {
    /* storage unavailable */
  }
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
