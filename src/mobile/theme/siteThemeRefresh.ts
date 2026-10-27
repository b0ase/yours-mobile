import { loadAccent, loadStorePack, wearSiteTheme } from './accent';
import { fetchSiteThemeIfChanged } from './siteTheme';
import type { ThemePack } from './themePack';
import type { ThemeSite } from './themeSites';

/**
 * Keeps a worn site theme current (owner 27 Oct 2026: bMarketX went from light to dark and the wallet kept the old
 * colours until a disconnect). When the site of the theme the account is wearing is opened or connects, its theme
 * file is asked again (with its ETag, at most once per site per REFRESH_MS) and, if it changed and still passes the
 * same checks as the first offer, re-applied without a new offer. A file that now fails the checks keeps the current
 * theme, and a site whose theme isn't worn is never fetched or applied.
 */
export const REFRESH_MS = 5 * 60 * 1000;

export interface RefreshDeps {
  now: () => number;
  fetchTheme: typeof fetchSiteThemeIfChanged;
  /** The account's worn store pack, when its current accent is that pack. */
  worn: (account: string) => ThemePack | null;
  wear: (account: string, pack: ThemePack) => void;
}

const live: RefreshDeps = {
  now: Date.now,
  fetchTheme: fetchSiteThemeIfChanged,
  worn: (account) => (loadAccent(account) === 'custom' ? loadStorePack(account) : null),
  wear: wearSiteTheme,
};

// Per site: when it was last asked and the ETag it answered with (this session only).
const asked = new Map<string, { at: number; etag: string | null }>();

/** Test hook: forgets the throttle and ETags. */
export const resetSiteThemeRefresh = (): void => asked.clear();

/** Re-applies the site's theme if the account is wearing it and the file changed. True when it re-applied. */
export async function refreshWornSiteTheme(
  site: ThemeSite | null,
  account: string,
  deps: RefreshDeps = live,
): Promise<boolean> {
  if (!site) return false;
  const id = `site-${site.id}`;
  if (deps.worn(account)?.id !== id) return false;
  const prev = asked.get(site.id);
  const now = deps.now();
  if (prev && now - prev.at < REFRESH_MS) return false;
  asked.set(site.id, { at: now, etag: prev?.etag ?? null });
  const r = await deps.fetchTheme(site, prev?.etag ?? null);
  if (r === 'unchanged') return false;
  asked.set(site.id, { at: now, etag: r.etag });
  if (!r.pack || r.pack.id !== id) return false;
  // Still worn after the fetch, and actually different.
  const cur = deps.worn(account);
  if (cur?.id !== id || JSON.stringify(cur) === JSON.stringify(r.pack)) return false;
  deps.wear(account, r.pack);
  return true;
}
