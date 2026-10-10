/**
 * Re-tapping the tab you are already on (owner, Lounge 10 Oct 2026, like X / Instagram): scrolls the page back
 * to the top; already at the top, it refreshes (the page's own pull-to-refresh, ui/PullToRefresh).
 * Used by the tab bar (tabs/BottomMenu.tsx) and the phone dock (phone/PhoneShell.tsx).
 */

/** Window event asking the on-screen PullToRefresh whose scroller is `detail` to refresh. */
export const PAGE_REFRESH = 'bwallet:page-refresh';

/** What a re-tap does for a scroller at this offset. */
export const retapAction = (scrollTop: number): 'top' | 'refresh' => (scrollTop > 1 ? 'top' : 'refresh');

/** Smooth scroll, or an instant jump with prefers-reduced-motion. */
export const scrollBehavior = (reduce: boolean): ScrollBehavior => (reduce ? 'auto' : 'smooth');

type Box = { scrollTop: number; scrollHeight: number; clientHeight: number; overflowY: string; shown: boolean };

/**
 * Which of a page's elements is its main scroller: among the scrollable, shown ones, the one scrolled furthest
 * (the list you were reading), else the tallest viewport. -1 when none scrolls.
 */
export const pickScroller = (boxes: readonly Box[]): number => {
  let best = -1;
  boxes.forEach((b, i) => {
    if (!b.shown || !/(auto|scroll)/.test(b.overflowY) || b.scrollHeight <= b.clientHeight + 1) return;
    if (best < 0) return void (best = i);
    const o = boxes[best];
    if (b.scrollTop > o.scrollTop || (b.scrollTop === o.scrollTop && b.clientHeight > o.clientHeight)) best = i;
  });
  return best;
};

/** The page on screen: the phone layout's kept page in view, else the app root. */
const pageRoot = (): Element | null =>
  document.querySelector('[data-phone-kept]:not(.bw-page-off)') ?? document.getElementById('root');

const findScroller = (): HTMLElement | null => {
  const root = pageRoot();
  if (!root) return null;
  const els = [...root.querySelectorAll<HTMLElement>('*')].filter((el) => !el.closest('.bw-page-off,[role="dialog"]'));
  const i = pickScroller(
    els.map((el) => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
      shown: el.getClientRects().length > 0,
    })),
  );
  return i < 0 ? null : els[i];
};

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Run after the tab's own reset (inner screens closed), so the scroller found is the tab's main one. */
export const onTabRetap = () => {
  requestAnimationFrame(() => {
    const el = findScroller();
    if (el && retapAction(el.scrollTop) === 'top') {
      el.scrollTo({ top: 0, behavior: scrollBehavior(prefersReducedMotion()) });
      return;
    }
    // At the top (or nothing scrolls): refresh. The PullToRefresh on that scroller, or on the page, picks it up.
    window.dispatchEvent(new CustomEvent(PAGE_REFRESH, { detail: el ?? pageRoot() }));
  });
};
