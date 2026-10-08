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
