import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { PAIR_HOST } from '../../pair/protocol';

/**
 * App links: scanning a site's pairing QR with the phone's own camera opens
 * https://www.bwallet.space/pair?… straight into bWallet (iOS universal link / Android app link,
 * site/.well-known). The link is held here until the wallet is unlocked and TopNav can show the
 * confirm screen.
 */
let pending: string | null = null;
const listeners = new Set<() => void>();

const isPairLink = (url: string) => {
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
