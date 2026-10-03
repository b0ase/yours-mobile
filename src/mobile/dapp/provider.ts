/**
 * Injected at document start into pages opened in the in-app dApp browser.
 * Mobile counterpart of the extension's inject.js + content.js: upstream's
 * inject/cwi give the page window.CWI, and requests go to the native bridge
 * instead of chrome.runtime. The origin is attached natively, not here.
 */
import { isCWIEventName } from '@1sat/wallet-browser';
import { CustomListenerName, type RequestEventDetail, type RequestParams } from '../../inject';
import { CWI } from '../../cwi';
import { announceWallet } from '../../brand/discovery';
import { appNameFor, isBWalletX } from '../storeBuild';
import bIcon from '../../../assets/bwallet-ext/icon128.png?inline';
import bxIcon from '../../../assets/bwalletx-ext/icon128.png?inline';

type AndroidBridge = { postMessage: (data: string) => void; onmessage: ((e: { data: string }) => void) | null };
type IosBridge = { postMessage: (data: string) => Promise<string> };

const w = window as unknown as {
  yoursNative?: AndroidBridge;
  webkit?: { messageHandlers?: { yours?: IosBridge } };
};

const pending = new Map<string, (response: string) => void>();
let seq = 0;

if (w.yoursNative) {
  w.yoursNative.onmessage = (e) => {
    const { id, response } = JSON.parse(e.data) as { id: string; response: string };
    pending.get(id)?.(response);
    pending.delete(id);
  };
}

const send = (payload: string): Promise<string> => {
  const ios = w.webkit?.messageHandlers?.yours;
  if (ios) return ios.postMessage(payload);
  const android = w.yoursNative;
  if (!android) return Promise.reject(new Error('Wallet bridge unavailable'));
  return new Promise((resolve) => {
    const id = String(++seq);
    pending.set(id, resolve);
    android.postMessage(JSON.stringify({ id, payload }));
  });
};

self.addEventListener(CustomListenerName.YOURS_REQUEST, (e: Event) => {
  const { type, messageId, params: originalParams = {} } = (e as CustomEvent<RequestEventDetail>).detail;
  if (!type || !isCWIEventName(type)) return;

  let params: RequestParams = {};
  if (Array.isArray(originalParams)) params.data = originalParams;
  else if (typeof originalParams === 'object') params = { ...params, ...originalParams };

  const reply = (detail: unknown) => self.dispatchEvent(new CustomEvent(messageId, { detail }));
  send(JSON.stringify({ type, params }))
    .then((response) => reply(JSON.parse(response)))
    .catch((error: unknown) =>
      reply({ success: false, error: error instanceof Error ? error.message : String(error) }),
    );
});

// Discovery (wallet-connect spec §3): the in-app browser has exactly one wallet; say which.
announceWallet(
  { name: appNameFor(), icon: isBWalletX() ? bxIcon : bIcon, rdns: 'space.bwallet.mobile', kind: 'in-app' },
  CWI,
);
