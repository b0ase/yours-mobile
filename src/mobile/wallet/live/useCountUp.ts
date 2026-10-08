import { useEffect, useRef, useState } from 'react';
import { COUNT_MS, tween } from './liveLogic';

const reduced = () => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
};

/**
 * The balance as shown: counts from the old value to the new one over COUNT_MS (instantly with reduced motion),
 * and reports which way it last moved so the card can flash green (+) or red (−). The first value never animates.
 */
export const useCountUp = (
  target: number,
  /** False while no real balance is known: the first known balance appears without counting from 0. */
  enabled = true,
): { value: number; dir: 'up' | 'down' | null; flashKey: number } => {
  const [value, setValue] = useState(target);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const shown = useRef(target);
  const frame = useRef<number | null>(null);
  const wasEnabled = useRef(enabled);

  useEffect(() => {
    const from = shown.current;
    const live = wasEnabled.current && enabled;
    wasEnabled.current = enabled;
    if (from === target) return;
    if (!live) {
      shown.current = target;
      setValue(target);
      return;
    }
    setDir(target > from ? 'up' : 'down');
    setFlashKey((k) => k + 1);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (reduced() || typeof requestAnimationFrame !== 'function') {
      shown.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const step = (t: number) => {
      const p = (t - start) / COUNT_MS;
      const v = tween(from, target, p);
      shown.current = v;
      setValue(v);
      frame.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [target, enabled]);

  return { value, dir, flashKey };
};
