import { useEffect, useRef } from 'react';
import { accentById } from '../../theme/accents';
import { useAccentId } from '../../theme/useAccent';
import { createPointField } from './pointField';

/**
 * Per-artist opt-in: VexVoid allows its black-and-white work to be shown inverted (white with black) on light
 * themes (owner, 16 Oct 2026). Other artists' work is never recoloured.
 */
const ARTIST = { id: 'vexvoid', name: 'VexVoid', url: 'https://bchatx.com/u/vexvoid', invertOnLight: true };

/**
 * Header of the Music section: a lightweight live port of the VexVoid AV client's hero (point fields on a 2D
 * canvas, ~7 KB, no video, no library). Renders only while on screen and the app is in the foreground; one still
 * frame under reduced motion. Light themes get the inverted version through a GPU-cheap CSS filter.
 */
export default function VexVoidHero() {
  const ref = useRef<HTMLCanvasElement>(null);
  const light = accentById(useAccentId()).scheme === 'light';
  const invert = light && ARTIST.invertOnLight;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const field = createPointField(cv);
    if (!field) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let onScreen = false;
    let raf = 0;
    let prev = 0;
    // Dev only: average rAF work per frame, logged every 5 s, to watch for jank.
    let work = 0;
    let frames = 0;
    let lastLog = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = prev ? Math.min((now - prev) / 16.67, 3) : 1;
      prev = now;
      const t0 = performance.now();
      field.frame(dt);
      if (import.meta.env.DEV) {
        work += performance.now() - t0;
        frames++;
        if (now - lastLog > 5000) {
          console.debug(`[vexvoid hero] ${(work / frames).toFixed(2)} ms/frame`);
          lastLog = now;
          work = frames = 0;
        }
      }
    };
    const run = () => {
      const want = onScreen && !document.hidden && !reduce;
      if (want && !raf) {
        prev = 0;
        raf = requestAnimationFrame(loop);
      } else if (!want && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const fit = () => {
      const r = cv.getBoundingClientRect();
      field.resize(r.width, r.height);
      if (reduce) field.still();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(cv);
    const io = new IntersectionObserver((es) => {
      onScreen = es[0]?.isIntersecting ?? false;
      run();
    });
    io.observe(cv);
    document.addEventListener('visibilitychange', run);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', run);
    };
  }, []);

  return (
    <div className="relative -mx-4 overflow-hidden" style={{ height: 200, background: invert ? '#fff' : '#000' }}>
      <canvas
        ref={ref}
        aria-hidden
        className="absolute inset-0 h-full w-full"
        style={invert ? { filter: 'invert(1)' } : undefined}
      />
      <div
        className="absolute left-4 bottom-3 right-4 flex items-end justify-between gap-3 text-[10px] uppercase tracking-[0.25em]"
        style={{ color: invert ? '#000' : '#fff' }}
      >
        <span className="font-bold">bTV: AIVJ</span>
        <a href={ARTIST.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
          Live set by {ARTIST.name}
        </a>
      </div>
    </div>
  );
}
