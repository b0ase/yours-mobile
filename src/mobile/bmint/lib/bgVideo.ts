import { useEffect, useState } from 'react';

/** BgVideo.tsx: the film's source and when it may load. */
export const BG_VIDEO = 'https://bmintx.com/media/hero-mashup-sound.mp4';
export const BG_POSTER = 'https://bmintx.com/media/hero-mashup-poster.webp';

const WIDE = '(min-width: 1024px)';
const CALM = '(prefers-reduced-motion: reduce)';

const allowed = () => {
  try {
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
    return matchMedia(WIDE).matches && !matchMedia(CALM).matches && !saveData;
  } catch {
    return false;
  }
};

export const useBgVideo = () => {
  const [on, setOn] = useState(allowed);
  useEffect(() => {
    const wide = matchMedia(WIDE);
    const calm = matchMedia(CALM);
    const update = () => setOn(allowed());
    wide.addEventListener('change', update);
    calm.addEventListener('change', update);
    return () => {
      wide.removeEventListener('change', update);
      calm.removeEventListener('change', update);
    };
  }, []);
  return on;
};
