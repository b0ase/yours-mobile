/* global chrome */

import { isCWIEventName } from '@1sat/wallet-browser';
import { CustomListenerName, RequestEventDetail, RequestParams, ResponseEventDetail } from './inject';

console.log('🌱 Yours Wallet Loaded');

// inject.js runs as a MAIN-world content script (see manifest.json), so
// window.CWI is bound before any page script executes.

// Forward CWI requests from page to background service worker
self.addEventListener(CustomListenerName.YOURS_REQUEST, (e: Event) => {
  const { type, messageId, params: originalParams = {} } = (e as CustomEvent<RequestEventDetail>).detail;
  if (!type || !isCWIEventName(type)) return;

  let params: RequestParams = {};

  if (Array.isArray(originalParams)) {
    params.data = originalParams;
  } else if (typeof originalParams === 'object') {
    params = { ...params, ...originalParams };
  }

  // Use originator at message level (BRC-100 standard)
  const originator = window.location.host;

  chrome.runtime.sendMessage({ action: type, params, originator }, buildResponseCallback(messageId));
});

const buildResponseCallback = (messageId: string) => {
  return (response: ResponseEventDetail) => {
    const detail = chrome.runtime.lastError
      ? { success: false, error: chrome.runtime.lastError.message || 'Message channel closed' }
      : (response ?? { success: false, error: 'No response from service worker' });
    const responseEvent = new CustomEvent(messageId, { detail });
    self.dispatchEvent(responseEvent);
  };
};

// bWalletX: tell the page whether to be the wallet websites connect to (window.CWI over another
// wallet such as Yours). Default on; Settings › Websites turns it off (src/brand/cwi.ts).
chrome.storage?.local.get('bwalletxTakeCwi', (r) => {
  const take = r?.bwalletxTakeCwi !== false;
  const send = () => self.dispatchEvent(new CustomEvent('bwalletx:cwi-pref', { detail: { take } }));
  send();
  setTimeout(send, 300); // the MAIN-world script may not be listening yet at document_start
});

// Live balance (docs/LIVE-BALANCE.md): a dApp that funded a session through this wallet (a TokenBlaster gun pack)
// may report what it spends from it with window.postMessage({ type: 'bwallet:session-spend', … }). Forwarded to the
// wallet page with this page's host; the page checks it against the sender origin and only lowers its meter.
// Never sent to wallet methods (background.ts ignores the action). Light pre-check and at most 20 a second here.
let liveSec = 0;
let liveN = 0;
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || (e.data as { type?: unknown } | null)?.type !== 'bwallet:session-spend') return;
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== liveSec) {
    liveSec = sec;
    liveN = 0;
  }
  if (++liveN > 20) return;
  try {
    chrome.runtime
      .sendMessage({ action: 'bwxSessionSpend', data: e.data, originator: window.location.host })
      ?.catch(() => undefined);
  } catch {
    /* extension reloaded: nothing to tell */
  }
});

// In-page wallet sheet (docs/ONE-SHEET-PERMISSIONS.md §3d). When the side panel can't open, the background asks
// for the wallet's own approval page (prompt.html, extension origin) as a sheet over this site. It sits in a
// closed shadow root, so the site's scripts can't reach the frame or read its address (which carries the
// one-time token); the page inside checks that token with the background and only arms its buttons once it is
// fully visible. Answers go from that page straight to the background, never through the site.
let sheetHost: HTMLElement | undefined;
const hideSheet = () => {
  sheetHost?.remove();
  sheetHost = undefined;
};
const showSheet = (src: string) => {
  hideSheet();
  const host = document.createElement('div');
  host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483647;');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .scrim{position:fixed;inset:0;background:rgba(0,0,0,.45)}
    .sheet{position:fixed;right:16px;bottom:16px;width:min(380px,calc(100vw - 32px));height:min(600px,calc(100vh - 32px));
      border-radius:20px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);border:1px solid #ffffff1f;background:#010101}
    @media (max-width:520px){.sheet{right:0;bottom:0;width:100vw;height:min(620px,92vh);border-radius:20px 20px 0 0}}
    iframe{width:100%;height:100%;border:0;display:block;color-scheme:normal}`;
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.title = 'bWalletX';
  frame.allow = 'usb; hid';
  sheet.appendChild(frame);
  root.append(style, scrim, sheet);
  (document.body ?? document.documentElement).appendChild(host);
  sheetHost = host;
};
try {
  chrome.runtime.onMessage.addListener((msg: { action?: string; query?: string }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.action === 'BWX_INPAGE_SHEET_SHOW' && typeof msg.query === 'string') {
      if (window.top !== window) return false; // only the top frame shows the sheet (and answers)
      // Always the wallet's own prompt page, never an address from the message.
      showSheet(`${chrome.runtime.getURL('prompt.html')}?${msg.query}`);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.action === 'BWX_INPAGE_SHEET_HIDE') {
      if (window.top !== window) return false;
      hideSheet();
      sendResponse({ ok: true });
    }
    return false;
  });
} catch {
  /* extension reloaded */
}
