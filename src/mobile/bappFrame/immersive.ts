import { useEffect, useState } from 'react';

/**
 * Immersive mode for the in-wallet bApp frame (owner, 27 Oct 2026: TERRORNODE wasn't full screen). A phone turned
 * to landscape is short and wide; there the frame covers the wallet's top bar, dock and its own toolbar so the page
 * fills the screen (inside the safe-area insets). Portrait, tablets and desktops keep the normal frame.
 * UI only: the iframe, its origin and every wallet call are unchanged.
 */
export const IMMERSIVE_QUERY = '(orientation: landscape) and (max-height: 540px)';

/** Pure rule, for tests: a phone-sized screen in landscape. */
export const isImmersiveViewport = (width: number, height: number) => width > height && height <= 540;

/** Seconds the corner close button stays up before it fades; a tap on the edge strip brings it back. */
export const IMMERSIVE_BUTTON_MS = 3000;

export const useImmersiveViewport = () => {
  const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(IMMERSIVE_QUERY) : null;
  const [on, setOn] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return;
    const update = () => setOn(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return on;
};
