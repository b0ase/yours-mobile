import { useEffect, useState } from 'react';

/**
 * Optional shimmer on the generated gold bAvatar (owner, 15 Oct 2026): off by default, switched on in Theme →
 * Design your card. CSS only (a gradient sweep moved by transform, see .bw-bavatar-shimmer in mobile.css), and
 * still under prefers-reduced-motion. Kept per device.
 */
const KEY = 'bwallet.bavatarShimmer';
const EVENT = 'bwallet-bavatar-shimmer';

export const isBavatarSrc = (src: string | null | undefined) => String(src || '').startsWith('data:image/svg+xml');

export const getBavatarShimmer = (): boolean => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

export const setBavatarShimmer = (on: boolean) => {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no storage / window */
  }
};

export const useBavatarShimmer = () => {
  const [on, setOn] = useState(getBavatarShimmer);
  useEffect(() => {
    const f = () => setOn(getBavatarShimmer());
    window.addEventListener(EVENT, f);
    return () => window.removeEventListener(EVENT, f);
  }, []);
  return on;
};
