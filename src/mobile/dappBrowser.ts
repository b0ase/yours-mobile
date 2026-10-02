/* eslint-disable @typescript-eslint/no-explicit-any */
import { isCWIEventName } from '@1sat/wallet-browser';
import { YoursNative, isNative } from './native';

/**
 * In-app dApp browser. Each site is a hub endpoint whose sender origin is the
 * site's real origin (reported by the native WebView), so background.ts
 * treats it exactly as it treats a content script: originator must match
 * sender.origin, and every sensitive call goes through the permission prompts.
 */

type ContextFactory = (id: string, origin: string, url: string) => any;

let providerSource: Promise<string> | undefined;
let open = false;
let hiddenForOverlay = false;
let overlayCount = 0;
const contexts = new Map<string, any>();
const lastUrls = new Map<string, string>();

/** Last page URL a site was on when it called the wallet (this session), e.g. to reopen bChat where it was. */
export const lastUrlFor = (origin: string) => lastUrls.get(origin);

export const isDappBrowserOpen = () => open;

export const openDappBrowser = async (url: string) => {
  providerSource ??= fetch(new URL('dapp-provider.js', document.baseURI)).then((r) => {
    if (!r.ok) throw new Error('dapp-provider.js missing from the app bundle');
    return r.text();
  });
  await YoursNative.browserOpen({ url, provider: await providerSource });
  open = true;
  // Opened (or re-shown) while a prompt is up: stay behind it until it closes.
  hiddenForOverlay = false;
  onOverlayCountChanged(overlayCount);
};

/** Approval prompts render in the wallet WebView, under the browser: step it aside. */
export const onOverlayCountChanged = (count: number) => {
  overlayCount = count;
  if (!open) return;
  if (count > 0 && !hiddenForOverlay) {
    hiddenForOverlay = true;
    void YoursNative.browserSetHidden({ hidden: true });
  } else if (count === 0 && hiddenForOverlay) {
    hiddenForOverlay = false;
    void YoursNative.browserSetHidden({ hidden: false });
  }
};

let contextFactory: ContextFactory | undefined;

/**
 * One wallet call from a site, on behalf of `origin` (already verified by the caller: the native
 * WebView's frame info, or a postMessage from our own bApp iframe). Returns the wallet's
 * { success, data, error } reply. Shared by the full-screen browser and in-frame bApps.
 */
export const handleSiteCall = async (origin: string, url: string, type: string, params: unknown) => {
  if (!contextFactory) throw new Error('Wallet not ready');
  const o = new URL(origin);
  if (o.protocol !== 'https:' && o.protocol !== 'http:') throw new Error('Unsupported origin');
  if (!isCWIEventName(type)) throw new Error(`Unsupported request: ${type}`);
  if (url.startsWith(o.origin)) lastUrls.set(o.origin, url);
  let chrome = contexts.get(o.origin);
  if (!chrome) {
    chrome = contextFactory(`dapp:${o.origin}`, o.origin, url);
    contexts.set(o.origin, chrome);
  }
  // originator is derived from the verified origin, as content.ts derives it from window.location.host.
  return chrome.runtime.sendMessage({ action: type, params: params ?? {}, originator: o.host });
};

export const initDappBrowser = (createContext: ContextFactory) => {
  contextFactory = createContext;
  if (!isNative) return;

  void YoursNative.addListener('browserClosed', () => {
    open = false;
    hiddenForOverlay = false;
  });

  void YoursNative.addListener('browserRequest', async (req) => {
    let response: unknown;
    try {
      const { type, params } = JSON.parse(req.payload) as { type: string; params?: unknown };
      response = await handleSiteCall(req.origin, req.url ?? '', type, params);
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    await YoursNative.browserRespond({
      requestId: req.requestId,
      response: JSON.stringify(response ?? { success: false, error: 'No response from wallet' }),
    });
  });
};

/** Route a context's window.open(http[s]) into the dApp browser. */
export const routeWindowOpen = (win: Window) => {
  if (!isNative) return;
  const original = win.open.bind(win);
  win.open = ((url?: string | URL, target?: string, features?: string) => {
    const raw = url === undefined ? '' : String(url);
    const href = raw === '' ? '' : new URL(raw, win.location.href).href;
    if (/^https?:/i.test(href)) {
      openDappBrowser(href).catch((error) => console.error('[dapp browser]', error));
      return null;
    }
    return original(url, target, features);
  }) as typeof win.open;
};
