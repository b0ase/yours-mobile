import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The full-screen snap reel the bMovies reel uses (BmoviesReel.tsx): the box fills the screen between the Feed
 * header and the tab bar, and the slide most on screen ([data-i], 60% visible) is the active one. Only the active
 * card plays video or updates live data.
 */
export const useReel = (count: number) => {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const fit = () => setTop(Math.max(0, box.current?.getBoundingClientRect().top ?? 0));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    const root = box.current;
    if (!root || !count) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i ?? 0));
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll('[data-i]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [count]);

  const style = {
    height:
      top === null
        ? '70vh'
        : `max(320px, calc(100dvh - ${top}px - var(--dock-h, 3.75rem) - env(safe-area-inset-bottom, 0px)))`,
    scrollSnapType: 'y mandatory' as const,
    overscrollBehavior: 'contain' as const,
    background: '#010101',
  };
  /** Back to the first card (after a sort change). */
  const toTop = () => {
    box.current?.scrollTo({ top: 0 });
    setActive(0);
  };
  return { box, style, active, toTop };
};
