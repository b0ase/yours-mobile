import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PAIR_HOST } from '../../pair/protocol';
import { IS_EXTENSION } from '../extension';

/**
 * App links: scanning a site's pairing QR with the phone's own camera opens
 * https://www.bwallet.space/pair?… straight into bWallet (iOS universal link / Android app link,
 * site/.well-known). The link is held here until the wallet is unlocked and TopNav can show the
 * confirm screen.
 */
let pending: string | null = null;
const listeners = new Set<() => void>();

export const isPairLink = (url: string) => {
  try {
    const u = new URL(url);
    return (u.host === PAIR_HOST || u.host === 'bwallet.space') && u.pathname === '/pair';
  } catch {
    return false;
  }
};
const offer = (url?: string | null) => {
  if (!url || !isPairLink(url)) return;
  pending = url;
  listeners.forEach((l) => l());
};

export const takePairLink = () => {
  const u = pending;
  pending = null;
  return u;
};
export const onPairLink = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => offer(url));
  void CapApp.getLaunchUrl().then((r) => offer(r?.url));
}

/**
 * Extension: opening https://www.bwallet.space/pair?… in Chrome is caught by the background worker
 * (background.ts, tabs.onUpdated), which stores it under PAIR_LINK_KEY and opens the side panel. The
 * panel takes it from there (on load, or live via storage.onChanged) and clears it.
 */
export const PAIR_LINK_KEY = 'bwalletxPendingPairLink';
if (IS_EXTENSION && typeof chrome !== 'undefined' && chrome.storage?.local) {
  const pick = (url?: unknown) => {
    if (typeof url !== 'string' || !url) return;
    void chrome.storage.local.remove(PAIR_LINK_KEY);
    offer(url);
  };
  chrome.storage.local.get(PAIR_LINK_KEY, (r) => pick(r?.[PAIR_LINK_KEY]));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch[PAIR_LINK_KEY]?.newValue) pick(ch[PAIR_LINK_KEY].newValue);
  });
}
