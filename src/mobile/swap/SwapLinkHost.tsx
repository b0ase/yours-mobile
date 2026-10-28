import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { SWAP_ENABLED } from '../storeBuild';
import { extensionSwapPrefill, parseSwapLink, swapRoute, type SwapPrefill } from './swapLink';

/**
 * A www.bwallet.space/swap?… or bwalletx://swap?… link opened the app: go to Exchange › Swap with the coin, network
 * and amount filled in (swapLink.ts); in the extension, a <page>.html#/swap?… hash does the same. Nothing starts; the user confirms as usual. In the store edition
 * (SWAP_ENABLED false) the link is ignored and the app stays on Home.
 */
let pending: SwapPrefill | null = null;
const listeners = new Set<() => void>();
const offer = (link?: string | null) => {
  if (!SWAP_ENABLED) return;
  const p = parseSwapLink(link);
  if (!p) return;
  pending = p;
  listeners.forEach((l) => l());
};
if (SWAP_ENABLED && Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => offer(url));
  void CapApp.getLaunchUrl().then((r) => offer(r?.url));
} else if (SWAP_ENABLED && typeof window !== 'undefined' && window.location) {
  // Extension: chrome-extension://<id>/<page>.html#/swap?from=… (its pages have no routes in the path).
  pending = extensionSwapPrefill(window.location.pathname, window.location.hash);
}

export function SwapLinkHost() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!SWAP_ENABLED) return;
    const go = () => {
      const p = pending;
      pending = null;
      if (p) navigate(swapRoute(p));
    };
    go();
    listeners.add(go);
    return () => void listeners.delete(go);
  }, [navigate]);
  return null;
}
