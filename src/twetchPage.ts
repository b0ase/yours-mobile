/**
 * Page side of twetch.* in the Chrome extension (services/twetchSite.ts). Non-standard methods next to the BRC-100
 * ones on window.CWI, sent through the provider's own transport; the wallet takes the origin from the browser.
 *
 *   await window.CWI.twetch.status()                       → { linked, handle?, userId?, publicKey? }
 *   await window.CWI.twetch.loginSign({ challenge })       → { signature, publicKey, address }
 *   await window.CWI.twetch.buildPost({ text, replyTxid?, files? }) → { txHex, txid }  (unsent: the site submits it)
 *   await window.CWI.twetch.signRequest({ method, path, userId, ts, body }) → { signature }  (POST /v1/posts only)
 *
 * bChatX (bit-sign src/lib/feed/twetch-wallet.ts) calls the EIP-1193-like shape on the announced provider / window.CWI:
 *
 *   await window.CWI.request({ method: 'twetch.status' | 'twetch.loginSign' | 'twetch.buildPost' | 'twetch.signRequest',
 *   params })
 *
 * Any other method rejects with code NOT_SUPPORTED (an existing request(), if one is ever attached first, keeps
 * answering non-twetch methods).
 *
 * Rejects with an Error carrying `code` (see services/twetchSite.ts). `NOT_SUPPORTED` in store builds.
 */
import {
  TWETCH_LOGIN,
  TWETCH_POST,
  TWETCH_SIGN_REQUEST,
  TWETCH_STATUS,
  isTwetchAction,
} from './mobile/twetch/twetchAction';

const notSupported = (method: unknown) =>
  Object.assign(new Error(`${String(method)} is not supported.`), { code: 'NOT_SUPPORTED' });

export const attachTwetch = (
  target: Record<string, unknown>,
  transport: (action: string, params: unknown) => Promise<unknown>,
) => {
  target.twetch = Object.freeze({
    status: () => transport(TWETCH_STATUS, {}),
    loginSign: (args: unknown) => transport(TWETCH_LOGIN, args ?? {}),
    buildPost: (args: unknown) => transport(TWETCH_POST, args ?? {}),
    signRequest: (args: unknown) => transport(TWETCH_SIGN_REQUEST, args ?? {}),
  });
  const prior = typeof target.request === 'function' ? (target.request as (a: unknown) => Promise<unknown>) : undefined;
  target.request = (args: unknown) => {
    const { method, params } = (args ?? {}) as { method?: unknown; params?: unknown };
    if (isTwetchAction(method)) return transport(method, params ?? {});
    if (typeof method === 'string' && method.startsWith('twetch.')) return Promise.reject(notSupported(method));
    return prior ? prior(args) : Promise.reject(notSupported(method));
  };
};
