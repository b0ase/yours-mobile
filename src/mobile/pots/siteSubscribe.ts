/**
 * "Subscribe with bWalletX" from a web page outside the bApp frame (docs/SUBSCRIBE-API.md › Where it works):
 *  - the in-app browser: the native WebView reports the page origin (dappBrowser.ts → answerSiteSubscribe);
 *  - the Chrome extension: content.ts forwards the page's message; Chrome's sender (origin / tab URL) names the
 *    page, never the message (installExtensionSubscribe below, on the wallet page).
 * Either way the origin is the browser's, and the request must still carry a valid merchant signature for it.
 *
 * ⚠ bWalletX only: loaded lazily behind SUBSCRIPTIONS_ENABLED, so a store build has none of it.
 */
import { originatorForOrigin } from '../../services/originKey';
import { answerSubscribe, parseSubscribeMessage, SUBSCRIBE_MSG, subscribeErrorReply } from './appSubscribe';
import { subscribeDeps } from './subscribeAsk';

export const SUBSCRIBE_ACTION = 'bwxSubscribe';

/** One page's subscribe message, answered as a reply message (never throws). `origin` is browser-reported. */
export const answerSiteSubscribe = async (origin: string, data: unknown) => {
  const m = parseSubscribeMessage(data);
  const id = (data as { id?: unknown } | null)?.id;
  if (!m) return subscribeErrorReply(typeof id === 'string' || typeof id === 'number' ? id : 0, 'Bad request');
  let o: string;
  try {
    o = new URL(origin).origin;
  } catch {
    return subscribeErrorReply(m.id, 'Unknown page');
  }
  // https only (loopback http for development), as for every other wallet call (security review M3).
  if (!originatorForOrigin(o).originator) return subscribeErrorReply(m.id, 'This page can’t subscribe (https only)');
  return answerSubscribe(m, o, subscribeDeps());
};

type Sender = { id?: string; origin?: string; url?: string; tab?: { url?: string } };

/** The page origin Chrome reports for a content-script message, or null. Never taken from the message. */
export const senderPageOrigin = (sender: Sender, runtimeId: string): string | null => {
  if (!sender?.tab || sender.id !== runtimeId) return null; // only our own content script, in a tab
  const src = sender.origin ?? sender.url ?? sender.tab.url;
  if (!src) return null;
  try {
    const o = new URL(src).origin;
    return o.startsWith('https://') || o.startsWith('http://') ? o : null;
  } catch {
    return null;
  }
};

let installed = false;
/** Extension wallet page: answer subscribe messages forwarded by content.ts. Only a visible page answers. */
export const installExtensionSubscribe = () => {
  // The real extension only: in the web / phone builds chrome.runtime is the in-page hub, where sites' calls travel.
  if (installed || location.protocol !== 'chrome-extension:') return;
  const rt = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  if (!rt?.onMessage || !rt.id) return;
  installed = true;
  rt.onMessage.addListener((msg: { action?: unknown; data?: unknown }, sender, sendResponse) => {
    if (msg?.action !== SUBSCRIBE_ACTION) return false;
    if (document.visibilityState !== 'visible') return false;
    const origin = senderPageOrigin(sender as Sender, rt.id);
    if (!origin) return false;
    void answerSiteSubscribe(origin, msg.data).then(sendResponse);
    return true;
  });
};

export { SUBSCRIBE_MSG };
