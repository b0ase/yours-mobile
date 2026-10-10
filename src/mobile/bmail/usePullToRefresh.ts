import { useEffect, useRef, useState, type RefObject } from 'react';

/** Distance (px, after damping) the list must be pulled before release triggers a refresh. */
export const PULL_THRESHOLD = 64;
const PULL_MAX = 110;
/** Finger travel is halved so the indicator trails the touch, as in native lists. */
const DAMPING = 0.5;

/**
 * Touch pull-down-to-refresh for a scroll container (iOS WKWebView + Android WebView).
 * Only arms when the container is scrolled to the top; while pulling, the touchmove is
 * cancelled so native overscroll/bounce does not fight the gesture.
 */
export const usePullToRefresh = (
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onRefresh: () => Promise<unknown> | void,
) => {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef({ onRefresh, refreshing });
  live.current = { onRefresh, refreshing };

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let startY: number | null = null;
    let dist = 0;

    const onStart = (e: TouchEvent) => {
      if (live.current.refreshing || e.touches.length !== 1 || el.scrollTop > 0) return;
      startY = e.touches[0].clientY;
      dist = 0;
    };
    const onMove = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || el.scrollTop > 0) {
        if (dist) setPull(0);
        dist = 0;
        if (dy < 0) startY = null; // user is scrolling up the list, not pulling
        return;
      }
      if (e.cancelable) e.preventDefault();
      dist = Math.min(PULL_MAX, dy * DAMPING);
      setPull(dist);
    };
    const onEnd = () => {
      if (startY === null) return;
      startY = null;
      const fire = dist >= PULL_THRESHOLD;
      dist = 0;
      setPull(0);
      if (!fire) return;
      setRefreshing(true);
      void Promise.resolve()
        .then(() => live.current.onRefresh())
        .catch(() => undefined)
        .finally(() => setRefreshing(false));
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      setPull(0);
    };
  }, [ref, enabled]);

  return { pull, refreshing, armed: pull >= PULL_THRESHOLD };
};
