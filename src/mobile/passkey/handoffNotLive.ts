import { parseHandoffSearch } from './extHandoff';

/**
 * The extension's "Sign in with a passkey" link (/restore?passkey=1&ext=<id>&n=<nonce>) opened on a web build that
 * has passkeys switched off (owner, 22 Oct 2026: passkeys launch on the web later). Instead of the classic welcome,
 * which would make a wallet on the web, the page says so and sends the person back to the extension.
 */
export const isHandoffNotLive = (handoffEnabled: boolean, pathname: string, search: string): boolean =>
  !handoffEnabled && pathname.replace(/\/$/, '') === '/restore' && parseHandoffSearch(search) !== null;
