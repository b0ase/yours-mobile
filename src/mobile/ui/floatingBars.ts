import { useEffect, type RefObject } from 'react';

/**
 * Bottom space reserved for floating bars (the Ask b bar on every Desktop page). A floating bar publishes how far its
 * top sits above the bottom of the window; the layout pads its content by the largest of them through
 * `--float-bar-reserve`, so content always ends above the bar instead of under it (release check, 19 Oct 2026: the
 * bar covered the end of lists before scrolling; PR 302 only fixed this for Add account).
 */
export const FLOAT_RESERVE_VAR = '--float-bar-reserve';
/** Space between the content's end and the bar's top. */
export const FLOAT_GAP_PX = 12;

const reserves = new Map<symbol, number>();

/** The reserve for a bar whose top is `barTop` px from the top of a window `viewportH` px tall (0 when off screen). */
export const reserveFor = (barTop: number, viewportH: number, gap = FLOAT_GAP_PX) =>
  barTop >= viewportH || viewportH <= 0 ? 0 : Math.ceil(viewportH - barTop + gap);

/** The largest published reserve, for the CSS variable. */
export const currentReserve = () => Math.max(0, ...reserves.values());

const apply = (root: {
  style: { setProperty: (k: string, v: string) => void; removeProperty: (k: string) => void };
}) => {
  const r = currentReserve();
  if (r > 0) root.style.setProperty(FLOAT_RESERVE_VAR, `${r}px`);
  else root.style.removeProperty(FLOAT_RESERVE_VAR);
};

/** Publish (or clear, with null) one bar's reserve. Exported for tests. */
export const setReserve = (id: symbol, px: number | null, root = document.documentElement) => {
  if (px == null || px <= 0) reserves.delete(id);
  else reserves.set(id, px);
  apply(root);
};

/** Reserve bottom space for the floating bar `ref` points at for as long as it is mounted. */
export const useFloatingBarReserve = (ref: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const id = Symbol('floating-bar');
    const measure = () => setReserve(id, reserveFor(el.getBoundingClientRect().top, window.innerHeight));
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      setReserve(id, null);
    };
  }, [ref]);
};
