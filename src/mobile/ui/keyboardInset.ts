import { useEffect, useState } from 'react';

/**
 * How much of the layout viewport the on-screen keyboard covers (px). Pure.
 * iOS WKWebView doesn't resize the page for the keyboard; it shrinks the visual viewport instead,
 * so the covered strip is innerHeight - (visualViewport.height + offsetTop). On Android with
 * adjustResize the page itself shrinks and this is ~0. Under 40px is treated as no keyboard
 * (toolbars, rounding).
 */
export const keyboardInset = (innerHeight: number, vvHeight: number, vvOffsetTop: number) => {
  const covered = Math.round(innerHeight - vvHeight - vvOffsetTop);
  return covered >= 40 ? covered : 0;
};

/** Live keyboardInset() from window.visualViewport (0 where unsupported). */
export const useKeyboardInset = () => {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(keyboardInset(window.innerHeight, vv.height, vv.offsetTop));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);
  return inset;
};
