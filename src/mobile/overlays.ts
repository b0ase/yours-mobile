/* eslint-disable @typescript-eslint/no-explicit-any */
import type { HostOp } from './protocol';

/**
 * chrome.windows / chrome.tabs for a single-WebView app: each "window" the
 * background opens (permission prompts, sweep tab, USB flow) becomes a
 * full-screen iframe overlay above the main wallet UI.
 */

type Overlay = { id: number; tabId: number; type: string; el: HTMLDivElement; iframe: HTMLIFrameElement };

const overlays = new Map<number, Overlay>();
let nextId = 1;
let onRemoved: (windowId: number) => void = () => {};

export const setOverlayRemovedHandler = (fn: (windowId: number) => void) => {
  onRemoved = fn;
};

const describe = (o: Overlay) => ({
  id: o.id,
  type: o.type,
  focused: o.el === document.body.lastElementChild,
  state: 'fullscreen',
  tabs: [{ id: o.tabId, windowId: o.id, url: o.iframe.contentWindow?.location.href ?? o.iframe.src, active: true }],
});

const open = (url: string, type: string) => {
  const id = nextId++;
  const el = document.createElement('div');
  el.className = 'yours-overlay';
  const bar = document.createElement('div');
  bar.className = 'yours-overlay-bar';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'yours-overlay-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  close.addEventListener('click', () => removeOverlay(id));
  bar.appendChild(close);
  const iframe = document.createElement('iframe');
  iframe.src = url;
  el.append(bar, iframe);
  document.body.appendChild(el);
  const overlay: Overlay = { id, tabId: id, type, el, iframe };
  overlays.set(id, overlay);
  return overlay;
};

export const removeOverlay = (id: number) => {
  const overlay = overlays.get(id);
  if (!overlay) return false;
  overlays.delete(id);
  overlay.el.remove();
  onRemoved(id);
  return true;
};

/** Close whichever overlay owns this frame window (its window.close()). */
export const closeOverlayForFrame = (frame: Window) => {
  for (const o of overlays.values()) {
    if (o.iframe.contentWindow === frame) return removeOverlay(o.id);
  }
  return false;
};

/** Topmost overlay, for the Android back button. */
export const topOverlayId = () => [...overlays.keys()].pop();

export const handleHostOp = async (op: HostOp, args: any[]): Promise<unknown> => {
  switch (op) {
    case 'windows.create':
      return describe(open(args[0]?.url, args[0]?.type ?? 'normal'));
    case 'tabs.create':
      return describe(open(args[0]?.url, 'normal')).tabs[0];
    case 'windows.remove':
      if (!removeOverlay(args[0])) throw new Error(`No window with id: ${args[0]}.`);
      return undefined;
    case 'windows.update': {
      const overlay = overlays.get(args[0]);
      if (!overlay) throw new Error(`No window with id: ${args[0]}.`);
      document.body.appendChild(overlay.el);
      return describe(overlay);
    }
    case 'windows.getAll':
      return [...overlays.values()].map(describe);
    case 'tabs.update': {
      const overlay = [...overlays.values()].find((o) => o.tabId === args[0]);
      if (!overlay) throw new Error(`No tab with id: ${args[0]}.`);
      if (args[1]?.url) overlay.iframe.src = args[1].url;
      return describe(overlay).tabs[0];
    }
    case 'notifications.create': {
      // Background tx alerts. Native local notifications are a follow-up; the
      // in-app balance refresh already covers the foreground case.
      const [idOrOptions, maybeOptions] = args;
      const options = typeof idOrOptions === 'string' ? maybeOptions : idOrOptions;
      console.log('[notification]', options?.title, options?.message);
      return typeof idOrOptions === 'string' ? idOrOptions : `n-${Date.now()}`;
    }
  }
};
