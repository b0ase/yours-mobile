/**
 * What a tab navigation does to the site the panel is wearing (background.ts, tabs.onUpdated). Owner, 27 Oct 2026:
 * bmarketx.com sends the user to /my about 100 ms after sign-in, the tab reloads, and the panel dropped the site's
 * theme because a "loading" tab was always forgotten. The new page only re-announces once it talks to the wallet
 * again, and a page whose session restores from a cookie may not, so the wallet went back to the default theme.
 *
 * Now a navigation that stays on the same origin keeps the site (and moves to the new path); a navigation to
 * another origin, or one whose URL Chrome didn't give us, forgets it as before.
 */
export type TabNav = { keep: true; path: string } | { keep: false };

export function siteAfterNavigation(origin: string | null | undefined, url: string | null | undefined): TabNav {
  if (!origin || !url) return { keep: false };
  try {
    const u = new URL(url);
    if (u.origin !== origin) return { keep: false };
    return { keep: true, path: u.pathname };
  } catch {
    return { keep: false };
  }
}
