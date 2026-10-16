import { useEffect, useState } from 'react';
import {
  type AvatarPlace,
  bitsignStillUrl,
  mayBeAnimated,
  prefersReducedMotion,
  shouldAnimate,
  stillFrame,
} from './animatedAvatar';

/**
 * The src to draw for an avatar under the playback policy (./animatedAvatar.ts): the picture itself when it may
 * animate here, else its cached still first frame. In lists, pressing or hovering the row's avatar plays it.
 * Spread `handlers` onto the element. A frame that can't be drawn (cross-origin) falls back to the picture.
 */
export function useAvatarPlayback(src: string | null | undefined, place: AvatarPlace) {
  const [active, setActive] = useState(false);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const [poster, setPoster] = useState('');
  const s = src || '';
  const animate = shouldAnimate(place, reduced, active);
  const wantPoster = !animate && mayBeAnimated(s);
  // bit-sign pictures: the server's own still (`?still=1`); other hosts: a canvas first frame.
  const serverStill = wantPoster ? bitsignStillUrl(s) : null;
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const on = () => setReduced(mq!.matches);
    mq.addEventListener?.('change', on);
    return () => mq!.removeEventListener?.('change', on);
  }, []);
  useEffect(() => {
    if (!wantPoster || serverStill) return;
    let live = true;
    void stillFrame(s).then((p) => live && setPoster(p));
    return () => {
      live = false;
    };
  }, [s, wantPoster, serverStill]);
  useEffect(() => setPoster(''), [s]);
  const handlers =
    place === 'list'
      ? {
          onPointerEnter: () => setActive(true),
          onPointerLeave: () => setActive(false),
          onPointerDown: () => setActive(true),
          onPointerUp: () => setActive(false),
          onPointerCancel: () => setActive(false),
        }
      : {};
  return { src: serverStill ?? (wantPoster && poster ? poster : s), handlers };
}
