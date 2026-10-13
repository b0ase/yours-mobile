import { toRouter } from '../../url/publicUrl';

/**
 * The Name Store (/names) is readable without a wallet (signed out or locked): search and browse only.
 * Returns the router path (keeping a ?q= search) or null for any other address-bar URL.
 */
export const guestNamesRoute = (pathname: string, search = ''): string | null => {
  const r = toRouter(pathname, '');
  if (r === '/m/names/store') return r;
  if (r !== '/m/names') return null;
  const q = new URLSearchParams(search).get('q');
  return q ? `/m/names?q=${encodeURIComponent(q.slice(0, 64))}` : '/m/names';
};
