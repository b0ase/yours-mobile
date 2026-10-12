import { toRouter } from './publicUrl';

// Read once at load, before anything replaces the address bar.
let start = typeof window === 'undefined' ? null : toRouter(window.location.pathname, window.location.search);
/** The route UrlSync opens once the wallet has started. */
export const startRoute = () => start;
/** A guest page (media/artists/GuestMusic.tsx) sets where to come back to after create/unlock. */
export const resumeAt = (routerPath: string) => {
  start = routerPath;
};
