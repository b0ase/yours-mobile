import { toRouter } from '../../url/publicUrl';
import { parseOutpoint } from './verify';

/**
 * Check this mint is readable without a wallet (signed out or locked): /bmint/check and /check, keeping a
 * valid ?o=<outpoint>. Returns the router path, or null for any other address-bar URL.
 */
export const guestCheckRoute = (pathname: string, search = ''): string | null => {
  const r = toRouter(pathname, '');
  if (r !== '/m/bmint/check' && r !== '/m/check') return null;
  const o = parseOutpoint(new URLSearchParams(search).get('o') ?? '');
  return o ? `/m/bmint/check?o=${o}` : '/m/bmint/check';
};
