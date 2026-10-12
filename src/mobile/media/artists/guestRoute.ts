import { toRouter } from '../../url/publicUrl';

/**
 * Read-only bMusic pages a visitor may see without a wallet (signed out or locked): the artists list, an artist,
 * and a shared album. Nothing else is public; every other route still needs create/unlock first.
 */
const GUEST = [
  /^\/m\/media\/artists$/,
  /^\/m\/media\/artists\/[a-z0-9-]{1,64}$/i,
  /^\/m\/media\/album\/[a-z0-9-]{1,64}$/i,
];

/** Router path for a guest-viewable address-bar URL, or null. Query strings are dropped (nothing else rides in). */
export const guestMusicRoute = (pathname: string): string | null => {
  const r = toRouter(pathname, '');
  return r && GUEST.some((re) => re.test(r)) ? r : null;
};
