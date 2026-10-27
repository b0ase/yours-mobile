/**
 * Page side of twetch.* in the Chrome extension (services/twetchSite.ts). Non-standard methods next to the BRC-100
 * ones on window.CWI, sent through the provider's own transport; the wallet takes the origin from the browser.
 *
 *   await window.CWI.twetch.status()                       → { linked, handle?, userId?, publicKey? }
 *   await window.CWI.twetch.loginSign({ challenge })       → { signature, publicKey, address }
 *   await window.CWI.twetch.buildPost({ text, replyTxid?, files? }) → { txHex, txid }  (unsent: the site submits it)
 *
 * Rejects with an Error carrying `code` (see services/twetchSite.ts). `NOT_SUPPORTED` in store builds.
 */
import { TWETCH_LOGIN, TWETCH_POST, TWETCH_STATUS } from './mobile/twetch/twetchAction';

export const attachTwetch = (
  target: Record<string, unknown>,
  transport: (action: string, params: unknown) => Promise<unknown>,
) => {
  target.twetch = Object.freeze({
    status: () => transport(TWETCH_STATUS, {}),
    loginSign: (args: unknown) => transport(TWETCH_LOGIN, args ?? {}),
    buildPost: (args: unknown) => transport(TWETCH_POST, args ?? {}),
  });
};
