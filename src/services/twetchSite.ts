/**
 * twetch.* from a web page through the Chrome extension (bChatX "Post to Twetch" with no paired phone).
 *
 * Page side (cwi.ts): `window.CWI.twetch.status()`, `window.CWI.twetch.loginSign({ challenge })`,
 * `window.CWI.twetch.signRequest({ method, path, userId, ts, body })`,
 * `window.CWI.twetch.buildPost({ text, replyTxid?, files? })`. Each travels like any CWI call (YoursRequest event →
 * content.ts → chrome.runtime → background.ts) with type 'twetch.status' | 'twetch.loginSign' | 'twetch.buildPost' |
 * 'twetch.signRequest'.
 * A refusal rejects with an Error carrying `code` (INVALID_PARAMS, TWETCH_NOT_LINKED, TWETCH_KEY_MISMATCH,
 * NOT_SUPPORTED, LOCKED, ERROR, or ERR_PERMISSION_DENIED when the user declined).
 *
 * All validation, caps, sheets and unsent rules are the paired version's (mobile/twetch/twetchCalls.ts); this module
 * only routes: the origin is Chrome's sender.origin, never anything the page sent, and the reply is turned into the
 * extension's `{ success, data | error, code }` shape. Extension pages never use this route.
 */
import { originatorForOrigin } from './originKey';
import { USER_DENIED_CODE, USER_DENIED_STATUS } from './userDenied';
import { handleTwetchCall, isTwetchAction, type TwetchDeps } from '../mobile/twetch/twetchCalls';

export { isTwetchAction };

export type TwetchSiteReply =
  | { success: true; data: unknown }
  | { success: false; error: string; code?: string; status?: number };

/**
 * One twetch.* message from the extension bridge. `senderOrigin` is chrome's MessageSender.origin; `deps` is built
 * lazily so a refused call never touches the wallet. `proven` is always true: the browser vouches for the origin.
 */
export async function routeTwetchMessage(
  message: { action?: unknown; params?: unknown },
  sender: { origin?: string; isFromExtension: boolean },
  deps: (action: string) => Promise<Omit<TwetchDeps, 'proven'>>,
): Promise<TwetchSiteReply> {
  const action = message.action;
  if (!isTwetchAction(action)) return { success: false, error: 'Unknown action', code: 'ERROR' };
  if (sender.isFromExtension) return { success: false, error: 'Unauthorized', code: 'ERROR' };
  const derived = originatorForOrigin(sender.origin);
  if (!derived.originator) return { success: false, error: derived.error ?? 'Invalid origin', code: 'ERROR' };
  const origin = new URL(sender.origin as string).origin;
  let d: Omit<TwetchDeps, 'proven'>;
  try {
    d = await deps(action);
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e), code: 'LOCKED' };
  }
  const r = await handleTwetchCall(action, stripTransport(message.params), origin, { ...d, proven: true });
  if ('result' in r) return { success: true, data: r.result };
  return {
    success: false,
    error: r.error.message,
    code: r.error.code,
    ...(r.error.code === USER_DENIED_CODE && { status: USER_DENIED_STATUS }),
  };
}

/** content.ts spreads the page's params into a RequestParams object; drop the fields it may add. */
const stripTransport = (p: unknown): unknown => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
  const { domain, appName, appIcon, isAuthorized, ...rest } = p as Record<string, unknown>;
  return rest;
};
