import { Capacitor } from '@capacitor/core';
import { IS_EXTENSION } from './extension';

/**
 * Which shell is this? The same UI ships as the Capacitor apps (native), the Chrome extension
 * (vite.config.ts, IS_EXTENSION) and the web app (`pnpm build:web` → web.bwalletx.com, which is
 * the mobile build with Capacitor's web fallbacks, so isNativePlatform() is false). Anything that
 * is neither native nor the extension keeps its keys in this browser's storage: the web app
 * (and `pnpm preview:mobile`, which is the same build). Desktop (Tauri) keeps them in its own app data dir.
 */
export type WebAppEnv = { native: boolean; extension: boolean; tauri?: boolean };
export const detectWebApp = ({ native, extension, tauri = false }: WebAppEnv) => !native && !extension && !tauri;

/**
 * bWalletX Desktop (src-tauri/): the Tauri webview injects __TAURI_INTERNALS__ before any page script runs, and only
 * into the app's own pages. Capacitor's isNativePlatform() is false there, so Desktop is told apart by this.
 */
export const detectTauri = (w: unknown = typeof window === 'undefined' ? undefined : window): boolean =>
  !!w && typeof w === 'object' && '__TAURI_INTERNALS__' in w && !!(w as Record<string, unknown>).__TAURI_INTERNALS__;
export const isTauri = () => detectTauri();

export type IosEnv = {
  userAgent: string;
  /** navigator.platform ('iPhone', 'MacIntel'…). */
  platform?: string;
  maxTouchPoints?: number;
  /** navigator.standalone (iOS Home Screen app) or display-mode: standalone. */
  standalone?: boolean;
};
/** iPhone / iPad Safari, or a Home Screen web app on iOS (iPadOS reports a Mac with touch). */
export const detectIos = ({ userAgent, platform = '', maxTouchPoints = 0, standalone = false }: IosEnv) =>
  /iPhone|iPad|iPod/i.test(userAgent) ||
  /iPhone|iPad|iPod/i.test(platform) ||
  (/Macintosh/i.test(userAgent) && maxTouchPoints > 1 && (standalone || /Safari/i.test(userAgent)));

const currentIosEnv = (): IosEnv => {
  if (typeof navigator === 'undefined') return { userAgent: '' };
  let standalone = !!(navigator as Navigator & { standalone?: boolean }).standalone;
  try {
    standalone ||= !!window.matchMedia?.('(display-mode: standalone)').matches;
  } catch {
    /* no matchMedia */
  }
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone,
  };
};

/** Web app (not the native apps, not the extension): the wallet lives only in this browser. */
export const isWebApp = () =>
  detectWebApp({ native: Capacitor.isNativePlatform(), extension: IS_EXTENSION, tauri: detectTauri() });
/** The web app on an iPhone / iPad (Safari or added to the Home Screen), where iOS may clear site data. */
export const isIosWebApp = () => isWebApp() && detectIos(currentIosEnv());
