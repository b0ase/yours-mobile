/* eslint-disable @typescript-eslint/no-explicit-any */
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { createChromeShim } from './chromeShim';
import { Hub } from './hub';
import { closeOverlayForFrame, handleHostOp, removeOverlay, setOverlayRemovedHandler, topOverlayId } from './overlays';
import { INTERNAL_ORIGIN, MOBILE_EXTENSION_ID, type Sender } from './protocol';
import './mobile.css';

/**
 * Mobile entry point. Stands up the hub (the "browser"), the background
 * worker, and a chrome shim for this window, then loads the unmodified
 * extension popup UI (src/index.tsx).
 */

declare const __MOBILE_VERSION__: string;

const rootUrl = new URL('./', location.href).href;
const senderFor = (url: string): Sender => ({ id: MOBILE_EXTENSION_ID, url, origin: INTERNAL_ORIGIN });
const defineChrome = (target: any, chrome: unknown) =>
  Object.defineProperty(target, 'chrome', { value: chrome, writable: true, configurable: true });

const hub = new Hub(handleHostOp);

// Frames (overlay iframes) register here; swept when their overlay closes.
const frames = new Map<string, Window>();
setOverlayRemovedHandler((windowId) => {
  for (const [id, win] of frames) {
    if (win.closed || !win.frameElement) {
      frames.delete(id);
      hub.unregister(id);
    }
  }
  hub.broadcast({ t: 'windowRemoved', windowId });
});

const attachContext = (id: string, win: Window) => {
  const { chrome, receive } = createChromeShim({
    post: (json) => queueMicrotask(() => void hub.handle(id, JSON.parse(json))),
    parse: (json) => (win as Window & typeof globalThis).JSON.parse(json),
    rootUrl,
    version: __MOBILE_VERSION__,
    timers: {
      setInterval: win.setInterval.bind(win),
      setTimeout: win.setTimeout.bind(win),
      clearInterval: win.clearInterval.bind(win),
    },
  });
  hub.register(id, { post: (json) => win.setTimeout(() => receive(json), 0), sender: senderFor(win.location.href) });
  return chrome;
};

// Called synchronously by an inline script at the top of every overlay page.
let frameSeq = 0;
(window as any).__yoursMobile = {
  attachFrame: (win: Window) => {
    const id = `frame-${++frameSeq}`;
    frames.set(id, win);
    win.addEventListener('pagehide', () => {
      frames.delete(id);
      hub.unregister(id);
    });
    // The prompt and USB pages close themselves when done.
    (win as any).close = () => closeOverlayForFrame(win);
    return attachContext(id, win);
  },
};

// Background worker.
const worker = new Worker(new URL('./background.worker.ts', import.meta.url), { type: 'module' });
hub.register('background', { post: (json) => worker.postMessage(json), sender: senderFor(rootUrl + 'background.js') });
worker.addEventListener('message', (e) => {
  if (typeof e.data === 'string') void hub.handle('background', JSON.parse(e.data));
  else if (e.data?.t === 'ready') hub.markBackgroundReady();
  else if (e.data?.t === 'error') console.error('[background worker] failed to start:', e.data.message);
});
worker.addEventListener('error', (e) => console.error('[background worker]', e.message, e));
worker.postMessage({ rootUrl, version: __MOBILE_VERSION__ });

// This window's own chrome (the "popup").
defineChrome(window, attachContext('main', window));

if (Capacitor.isNativePlatform()) {
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
  CapApp.addListener('backButton', () => {
    const top = topOverlayId();
    if (top !== undefined) removeOverlay(top);
    else void CapApp.minimizeApp();
  });
}

await import('../index');
