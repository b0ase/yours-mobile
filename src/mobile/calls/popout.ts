/**
 * bWalletX extension: calls outside the side panel (owner, 10 Oct 2026: "check the video calls in the extension").
 *
 * A call lives in the page that placed or answered it, so closing the side panel ends it. For longer
 * calls the Calls page opens in its own small window (`index.html?route=/m/calls`), which stays up
 * while you browse. Picture-in-picture floats the other person's video above every window.
 */
import { IS_EXTENSION } from '../extension';
import { CALLS_ROUTE } from './route';

type ChromeWin = {
  runtime?: { getURL?: (p: string) => string };
  windows?: { create?: (o: Record<string, unknown>) => unknown };
};
const chromeApi = (): ChromeWin | undefined => (globalThis as { chrome?: ChromeWin }).chrome;

/** Routes a window may be opened straight onto (MemoryRouter has no URL of its own). */
const START_ROUTES = new Set([CALLS_ROUTE]);

/** The route this page was opened on (`?route=`), when it is one we allow; else '/'. */
export function startRoute(search: string = typeof location !== 'undefined' ? location.search : ''): string {
  try {
    const r = new URLSearchParams(search).get('route');
    return r && START_ROUTES.has(r) ? r : '/';
  } catch {
    return '/';
  }
}

/** This page is the popped-out calls window. */
export const isCallsWindow = (search?: string) => startRoute(search) === CALLS_ROUTE;

/** The extension can open a calls window here (side panel / popup, not already the window). */
export const canPopOutCalls = (search?: string, ext = IS_EXTENSION, c = chromeApi()) =>
  ext && !isCallsWindow(search) && !!c?.windows?.create && !!c.runtime?.getURL;

/** Open the Calls page in its own small window. False when it can't. */
export function openCallsWindow(c = chromeApi()): boolean {
  if (!c?.windows?.create || !c.runtime?.getURL) return false;
  void c.windows.create({
    url: c.runtime.getURL(`index.html?route=${encodeURIComponent(CALLS_ROUTE)}`),
    type: 'popup',
    width: 420,
    height: 760,
    focused: true,
  });
  return true;
}

type PipDoc = Document & { pictureInPictureEnabled?: boolean; pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
type PipVideo = HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };

/** Picture-in-picture is available for this video (Chrome desktop, Safari; not every phone webview). */
export const pipSupported = (v: HTMLVideoElement | null, d: PipDoc | undefined = typeof document !== 'undefined' ? document : undefined) =>
  !!v && !!d?.pictureInPictureEnabled && typeof (v as PipVideo).requestPictureInPicture === 'function';

/** Float `v` above every window, or bring it back if it is already floating. */
export async function togglePip(v: HTMLVideoElement | null, d: PipDoc | undefined = typeof document !== 'undefined' ? document : undefined): Promise<void> {
  if (!v || !d) return;
  if (d.pictureInPictureElement === v) {
    await d.exitPictureInPicture?.();
    return;
  }
  await (v as PipVideo).requestPictureInPicture?.();
}
