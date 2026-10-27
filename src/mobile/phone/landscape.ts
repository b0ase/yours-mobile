import { useSyncExternalStore } from 'react';
import { phoneLayoutOn } from './flag';

/**
 * Landscape phone layout (owner, 27 Oct 2026: "the wallet needs a landscape version that works when you tip it on
 * its side"). A touch phone turned sideways is short and wide: the dock becomes a slim rail on the left, the top
 * icon row a compact strip beside it, and pages use the width (mobile.css, html[data-rail], set by the Dock while the rail shows). Portrait,
 * tablets and desktops are unchanged. UI only.
 */
export const LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)';

/** Pure rule, for tests: a touch screen wider than tall and at most 500px high. */
export const isLandscapePhone = (width: number, height: number, coarse: boolean) =>
  coarse && width > height && height <= 500;

const query = (): MediaQueryList | null => {
  try {
    return typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(LANDSCAPE_QUERY) : null;
  } catch {
    return null;
  }
};

const mql = query();

/** On when the phone layout is on and the screen is a sideways phone. */
export const landscapeOn = (): boolean => !!mql?.matches && phoneLayoutOn();

const subscribe = (fn: () => void) => {
  mql?.addEventListener('change', fn);
  window.addEventListener('bwallet:phone-layout-changed', fn);
  return () => {
    mql?.removeEventListener('change', fn);
    window.removeEventListener('bwallet:phone-layout-changed', fn);
  };
};

/** True while the screen calls for the landscape rail layout. */
export const useLandscapeRail = () => useSyncExternalStore(subscribe, landscapeOn, () => false);
