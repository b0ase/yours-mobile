/**
 * Keep the part of the Send screen the user needs in view (owner, 14 Oct 2026: after typing an amount for $bug the
 * BSV screen stayed at the top, Buy prominent and Send hidden below the keyboard).
 *
 * Phone keyboards change the layout after focus: iOS shrinks the visual viewport, Android resizes the page. So we
 * scroll once after layout (next animation frame) and once more when the visual viewport next resizes (the keyboard
 * arriving), with block:'center' so the element sits above the keyboard rather than under it.
 */

type ScrollTarget = Pick<HTMLElement, 'scrollIntoView'>;
type Viewport = Pick<VisualViewport, 'addEventListener' | 'removeEventListener'>;

export type ScrollEnv = {
  raf: (cb: () => void) => unknown;
  viewport: Viewport | null | undefined;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

const browserEnv = (): ScrollEnv => ({
  raf: (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => cb()) : setTimeout(cb, 16)),
  viewport: typeof window !== 'undefined' ? window.visualViewport : null,
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
});

/** How long we keep listening for the keyboard's viewport resize after a scroll request. */
export const KEYBOARD_WAIT_MS = 1200;

/**
 * Scroll `el` to the centre after layout, and again on the next visualViewport resize (keyboard). Returns a cancel
 * function. Never throws (scrollIntoView options are unsupported on very old WebViews: fall back to the plain call).
 */
export const scrollCentered = (el: ScrollTarget | null | undefined, env: ScrollEnv = browserEnv()): (() => void) => {
  if (!el) return () => {};
  const go = () => {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      try {
        el.scrollIntoView();
      } catch {
        /* detached */
      }
    }
  };
  env.raf(go);
  const vv = env.viewport;
  if (!vv) return () => {};
  let done = false;
  const onResize = () => {
    if (done) return;
    done = true;
    vv.removeEventListener('resize', onResize);
    go();
  };
  vv.addEventListener('resize', onResize);
  const timer = env.setTimeout(() => {
    done = true;
    vv.removeEventListener('resize', onResize);
  }, KEYBOARD_WAIT_MS);
  return () => {
    done = true;
    vv.removeEventListener('resize', onResize);
    env.clearTimeout(timer);
  };
};

/**
 * Which field the Send-entry focus should land on: the recipient while it's empty, else the amount (a Contacts › Pay
 * or a scan has already filled the recipient).
 */
export const sendFocusField = (rows: { address: string }[]): 'address' | 'amount' =>
  rows.length > 0 && rows[0].address.trim() ? 'amount' : 'address';

/**
 * Whether an amount edit should bring the Send button into view: only when the amount just became non-zero
 * (typing more digits after that would otherwise keep re-scrolling under the user's thumb).
 */
export const shouldRevealButton = (prevSats: number, nextSats: number): boolean => prevSats <= 0 && nextSats > 0;
