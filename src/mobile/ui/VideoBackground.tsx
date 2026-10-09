import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePrefs } from '../settings/usePrefs';

/** Scrims: Apps is lighter (tiles are bold); Wallet / Feed are darker so balances and post text stay crisp. */
const SCRIMS = {
  apps: 'linear-gradient(180deg, rgba(1,1,1,0.55) 0%, rgba(1,1,1,0.68) 45%, rgba(1,1,1,0.85) 100%)',
  dark: 'linear-gradient(180deg, rgba(1,1,1,0.74) 0%, rgba(1,1,1,0.84) 40%, rgba(1,1,1,0.93) 100%)',
} as const;

type Props = {
  src: string;
  poster: string;
  scrim?: keyof typeof SCRIMS;
  /**
   * 'absolute' fills a non-scrolling parent (Apps). 'fixed' pins to the viewport from inside a
   * scroll container; that container needs `isolate` so the layer (z -1) sits above its background.
   */
  position?: 'absolute' | 'fixed';
};

/**
 * Looping brand clip (360x640 H.264, no audio) at half opacity under a dark scrim, in its own
 * non-scrolling layer. Still poster with prefers-reduced-motion or Settings → Animated backgrounds
 * off. Plays only while on screen and the app is in the foreground; paused on unmount.
 */
export const VideoBackground = ({ src, poster, scrim = 'apps', position = 'absolute' }: Props) => {
  const reduce = useReducedMotion();
  const [prefs] = usePrefs();
  // Data saver (Chrome/Android "Lite"): the still poster, no video download.
  const saveData =
    typeof navigator !== 'undefined' &&
    !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  const still = reduce || !prefs.animatedBackgrounds || saveData;
  const video = useRef<HTMLVideoElement>(null);
  const [onScreen, setOnScreen] = useState(true);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    // iOS (Safari and WKWebView) only autoplays inline when muted/playsinline are real attributes; React sets
    // `muted` as a property only. Low Power Mode rejects play(): the poster stays, and the first touch retries.
    v.muted = true;
    v.defaultMuted = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    const sync = () => {
      if (document.hidden || !onScreen) v.pause();
      else if (v.paused) v.play().catch(() => undefined);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('touchstart', sync, { passive: true });
    return () => {
      document.removeEventListener('visibilitychange', sync);
      document.removeEventListener('touchstart', sync);
      v.pause();
    };
  }, [still, onScreen]);

  return (
    <motion.div
      ref={wrap}
      aria-hidden
      className={`bw-vbg pointer-events-none ${position} inset-0 overflow-hidden`}
      style={position === 'fixed' ? { zIndex: -1 } : undefined}
      initial={{ opacity: 0, scale: reduce ? 1 : 1.08 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
    >
      {still ? (
        <img src={poster} alt="" className="h-full w-full object-cover" style={{ opacity: 0.5 }} />
      ) : (
        <video
          ref={video}
          src={src}
          poster={poster}
          muted
          loop
          autoPlay
          playsInline
          disablePictureInPicture
          preload="auto"
          className="h-full w-full object-cover"
          style={{ opacity: 0.5 }}
        />
      )}
      <div className="absolute inset-0" style={{ background: SCRIMS[scrim] }} />
    </motion.div>
  );
};
