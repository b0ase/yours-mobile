/**
 * Run non-essential work after the first paint: requestIdleCallback when the platform has it
 * (timeout so it still runs on a busy page), otherwise a short setTimeout. Returns a cancel.
 */
export const afterPaint = (fn: () => void, timeout = 1500): (() => void) => {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(fn, { timeout });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(fn, 200);
  return () => window.clearTimeout(id);
};
