/**
 * The web and Desktop wallets run on a MemoryRouter, so the address bar never moved (owner, 11 Oct 2026: "add the
 * routes to the URL bar"). These map between the router's paths and the pretty ones shown in the address bar:
 *   /m/spaces              ↔ /spaces
 *   /m/spaces?space=<slug> ↔ /spaces/<slug>   (a permanent Space, e.g. /spaces/bwallet-lounge)
 *   /m/<page>              ↔ /<page>
 *   /bsv-wallet            ↔ /wallet
 * Other top-level app routes (/settings, …) keep their own path.
 */
const TOP = new Set(['/bsv-wallet', '/ord-wallet', '/tools', '/settings', '/browser']);
/**
 * Set-up and restore screens are never put in the address bar or reopened from it: restoring reloads the page, and
 * reopening /restore-wallet after that reload sent people round in a loop (owner, 11 Oct 2026).
 */
const ONBOARDING = new Set(['/create-wallet', '/restore-wallet', '/import-wallet', '/master-restore', '/sweep']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/i;

/** Router location → address-bar path (with any remaining query). */
export const toPublic = (pathname: string, search: string): string => {
  if (ONBOARDING.has(pathname)) return '/';
  const q = new URLSearchParams(search);
  let path = pathname;
  if (path === '/m/spaces' && SLUG.test(q.get('space') ?? '')) {
    path = `/spaces/${q.get('space')}`;
    q.delete('space');
  } else if (path === '/bsv-wallet') path = '/wallet';
  else if (path.startsWith('/m/')) path = path.slice(2);
  const rest = q.toString();
  return rest ? `${path}?${rest}` : path;
};

/** Address-bar path on first load → router path to open, or null to keep the app's own start. */
export const toRouter = (pathname: string, search: string): string | null => {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || ONBOARDING.has(path) || /\.[a-z0-9]+$/i.test(path)) return null;
  const q = search.replace(/^\?/, '');
  const withQ = (p: string, extra?: string) => {
    const all = [extra, q].filter(Boolean).join('&');
    return all ? `${p}?${all}` : p;
  };
  const space = /^\/spaces\/([^/]+)$/.exec(path);
  if (space) return SLUG.test(space[1]) ? withQ('/m/spaces', `space=${encodeURIComponent(space[1])}`) : '/m/spaces';
  if (path === '/wallet') return withQ('/bsv-wallet');
  if (TOP.has(path)) return withQ(path);
  return withQ(`/m${path}`);
};
