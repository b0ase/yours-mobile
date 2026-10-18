import { toRouter } from './publicUrl';
import { WIDE_ON } from '../wide/flag';

/** How this page load began: a typed / pasted / clicked link is 'navigate'; a refresh or a restored tab is not. */
const navType = (): string => {
  try {
    const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return e?.type ?? 'navigate';
  } catch {
    return 'navigate';
  }
};

/**
 * Desktop opens on the Wallet (owner, 19 Oct 2026): a link someone followed still opens its page, but a refresh or a
 * restored tab does not drop you back into whatever page was last in the address bar (the emoji shop, say), and a
 * Store page never opens before the Wallet.
 */
export const desktopStart = (route: string | null, wide: boolean, type: string): string | null => {
  if (!route || !wide) return route;
  if (type === 'reload' || type === 'back_forward') return null;
  if (route.startsWith('/m/store')) return null;
  return route;
};

// Read once at load, before anything replaces the address bar.
let start =
  typeof window === 'undefined' || !window.location
    ? null
    : desktopStart(toRouter(window.location.pathname, window.location.search), WIDE_ON, navType());
/** The route UrlSync opens once the wallet has started. */
export const startRoute = () => start;
/** A guest page (media/artists/GuestMusic.tsx) sets where to come back to after create/unlock. */
export const resumeAt = (routerPath: string) => {
  start = routerPath;
};
