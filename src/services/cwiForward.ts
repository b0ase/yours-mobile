/**
 * Forward one page CWI call (window.CWI → content.ts) to the background, and ALWAYS answer the page.
 *
 * The page's promise (src/cwi.ts transport) waits for one event named after the call's messageId and has no
 * timeout. When the extension is reloaded or updated while a tab stays open, this content script is cut off:
 * chrome.runtime.sendMessage throws "Extension context invalidated" synchronously (or chrome.runtime.id is gone)
 * and the response callback never runs. Before this, that throw escaped the event listener and the site's
 * getPublicKey / createAction waited for ever ("Reconnect" never came back until the page was reloaded,
 * TokenBlaster gallery, 24 Oct 2026). Now the page gets a plain error it can act on.
 */
import { LIVE_PORT_NAME } from './promptLiveness';

export const RELOAD_PAGE_ERROR = 'bWalletX was updated or restarted: reload this page to reconnect';

export interface LivePort {
  postMessage: (message: unknown) => void;
  disconnect: () => void;
}

export interface ForwardRuntime {
  id?: string;
  lastError?: { message?: string } | null;
  sendMessage: (message: unknown, callback: (response: unknown) => void) => unknown;
  connect?: (info: { name: string }) => LivePort;
}

const newToken = (): string => {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Liveness (BRC-219): each call also opens a port and names it with a one-time token carried in the message
 * (`liveToken`). Chrome disconnects that port when this document goes away (tab closed, reload, navigation to another
 * page, bfcache, prerender swap; not a single-page route change), and the background then closes the sheets this
 * call could own, so none can be approved for a page that is gone. The port is closed once the call is answered.
 */
export const forwardCwiCall = (
  runtime: ForwardRuntime | undefined,
  message: unknown,
  answer: (detail: unknown) => void,
  token: string = newToken(),
): void => {
  let answered = false;
  let port: LivePort | undefined;
  const once = (detail: unknown) => {
    if (answered) return;
    answered = true;
    try {
      port?.disconnect();
    } catch {
      /* already gone */
    }
    answer(detail);
  };
  try {
    if (!runtime?.id) throw new Error(RELOAD_PAGE_ERROR);
    try {
      port = runtime.connect?.({ name: LIVE_PORT_NAME });
      port?.postMessage({ token });
    } catch {
      port = undefined; // no liveness for this call: it still works, as before
    }
    const sent =
      port && message && typeof message === 'object' ? { ...(message as object), liveToken: token } : message;
    runtime.sendMessage(sent, (response) => {
      const lastError = runtime.lastError;
      once(
        lastError
          ? { success: false, error: lastError.message || 'Message channel closed' }
          : (response ?? { success: false, error: 'No response from service worker' }),
      );
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    once({ success: false, error: /context invalidated/i.test(msg) ? RELOAD_PAGE_ERROR : msg });
  }
};
