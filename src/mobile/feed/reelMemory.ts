import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Memory rules for the full-screen reels (bMovies / bMusic, bExchange, bApps) and the bNews video list.
 *
 * iOS kills the WKWebView's web-content process when it holds too much memory (owner, 15 Oct 2026: the bMovies
 * reel went black and the app came back on the Wallet). Decoded posters and video decoders are what fill it, so:
 *  - only slides within REEL_RADIUS of the one on screen mount any media (current ± 1, so at most 3);
 *  - nothing mounts while the reel's page is hidden (phone layout keeps the Feed mounted) or the app is hidden;
 *  - a <video> leaving the window is unloaded (pause, drop src, load()) so WebKit frees its decoder at once,
 *    instead of whenever the element is garbage collected.
 */

/** Slides each side of the one on screen that may hold media. */
export const REEL_RADIUS = 1;

/** True when slide i may mount its poster / video: within `radius` of the active slide, and the reel is shown. */
export const inReelWindow = (i: number, active: number, shown = true, radius = REEL_RADIUS): boolean =>
  shown && Math.abs(i - active) <= radius;

/**
 * A poster URL sized for a phone screen: X's image CDN (pbs.twimg.com) serves `name=medium` (at most 1200px)
 * instead of the full original; any other URL is unchanged.
 */
export const phonePoster = (url: string): string => {
  try {
    const u = new URL(url);
    if (u.hostname !== 'pbs.twimg.com') return url;
    u.searchParams.set('name', 'medium');
    return u.toString();
  } catch {
    return url;
  }
};

type Releasable = Pick<HTMLVideoElement, 'pause' | 'removeAttribute' | 'load'>;

/** Frees a video's buffers and decoder now: pause, drop its source, and load() the empty element. */
export const releaseVideo = (v: Releasable | null | undefined): void => {
  if (!v) return;
  try {
    v.pause();
    v.removeAttribute('src');
    v.load();
  } catch {
    /* already detached */
  }
};

const subscribeVisibility = (cb: () => void) => {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};
const docVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** False while the app is in the background (tab hidden / app switched away). */
export const useAppVisible = (): boolean => useSyncExternalStore(subscribeVisibility, docVisible, () => true);

/**
 * A reel's <video>: plays while `playing`, pauses otherwise, and is unloaded the moment it unmounts. Returns a
 * callback ref (works for a <video> that only renders some of the time).
 */
export const useReelVideo = (playing: boolean) => {
  const el = useRef<HTMLVideoElement | null>(null);
  const want = useRef(playing);
  want.current = playing;
  const ref = useCallback((v: HTMLVideoElement | null) => {
    if (el.current && el.current !== v) releaseVideo(el.current);
    el.current = v;
    if (v && want.current) void v.play().catch(() => undefined);
  }, []);
  useEffect(() => {
    const v = el.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing]);
  return ref;
};

/** [ref, near]: near while the element is within about a screen and a half of the viewport. */
export function useNearView<T extends Element>(): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '150% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, near];
}

/** Dev only: logs how many media items a reel has mounted when that changes (nothing in a production build). */
export const useReelDevLog = (name: string, mounted: number) => {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    console.debug(
      `[reel] ${name}: ${mounted} media mounted${mem ? `, heap ${Math.round(mem.usedJSHeapSize / 1e6)} MB` : ''}`,
    );
  }, [name, mounted]);
};
