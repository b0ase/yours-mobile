import { useEffect, useRef } from 'react';
import { BG_POSTER, BG_VIDEO } from './lib/bgVideo';

/**
 * bMint's background film on Desktop (owner, 20 Oct 2026): the bmintx.com hero mash-up, muted and looped behind a
 * dark gradient. Only at ≥1024px, never with prefers-reduced-motion or Save-Data, so phones and metered links never
 * load it; paused while the tab is hidden.
 */
export const BgVideo = () => {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const sync = () => {
      const v = ref.current;
      if (!v) return;
      if (document.hidden) v.pause();
      else void v.play().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return (
    <div className="bm-bgvid" aria-hidden="true">
      <video ref={ref} src={BG_VIDEO} poster={BG_POSTER} muted loop autoPlay playsInline preload="auto" />
    </div>
  );
};
