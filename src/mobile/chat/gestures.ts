import type React from 'react';

/**
 * Bubble gestures: long-press (500 ms, or right-click) opens the reaction bar; a swipe right
 * (>= 56 px, mostly horizontal) replies, WhatsApp-style. Plain closures, safe inside a list.
 */
export const bubbleGestures = (onLong: (() => void) | null, onSwipe: (() => void) | null) => {
  let timer: number | undefined;
  let start: { x: number; y: number } | null = null;
  const clear = () => window.clearTimeout(timer);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY };
      clear();
      if (onLong) timer = window.setTimeout(onLong, 500);
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (start && (Math.abs(t.clientX - start.x) > 8 || Math.abs(t.clientY - start.y) > 8)) clear();
    },
    onTouchEnd: (e: React.TouchEvent) => {
      clear();
      const s = start;
      start = null;
      const t = e.changedTouches[0];
      if (onSwipe && s && t && t.clientX - s.x >= 56 && Math.abs(t.clientY - s.y) < 30) onSwipe();
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (!onLong) return;
      e.preventDefault();
      onLong();
    },
  };
};
