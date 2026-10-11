import type React from 'react';
import { haptic } from '../swipe/haptics';

/**
 * Message bubble gestures (owner, 11 Oct 2026):
 *   tap         → reactions sheet (emoji row, Reply, Copy text, Edit, Report…)
 *   hold 400 ms → a haptic bump, then reply straight away (quote + keyboard), no extra tap
 *   swipe left  → Report / Block (the message menu)
 *   swipe right → reply too (WhatsApp habit, kept)
 * 400 ms matches hold-to-talk (B_HOLD_MS). A finger that moves more than MOVE_CANCEL_PX before the
 * hold fires is a scroll or a swipe, never a hold or a tap, so vertical scrolling always wins.
 */
export const HOLD_MS = 400;
export const MOVE_CANCEL_PX = 10;
export const SWIPE_MIN_PX = 56;
export const SWIPE_MAX_DY_PX = 30;
/** A click arriving this soon after a touch is the browser's synthetic click: ignore it. */
export const GHOST_CLICK_MS = 700;

export type Gesture = 'tap' | 'swipe-left' | 'swipe-right' | 'none';

/** Pure: what a finished touch was. `held` = the hold already fired (it consumed the touch). */
export const classifyTouch = (dx: number, dy: number, ms: number, held: boolean): Gesture => {
  if (held) return 'none';
  if (Math.abs(dy) < SWIPE_MAX_DY_PX && Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 2) {
    return dx < 0 ? 'swipe-left' : 'swipe-right';
  }
  if (Math.abs(dx) <= MOVE_CANCEL_PX && Math.abs(dy) <= MOVE_CANCEL_PX && ms < HOLD_MS) return 'tap';
  return 'none';
};

/** Links, buttons, images, inputs inside a bubble keep their own taps. */
const interactive = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest('a,button,input,textarea,select,img,video,audio,[data-own-tap]');

export type MessageActions = {
  onTap: (() => void) | null;
  onHold: (() => void) | null;
  onSwipeLeft: (() => void) | null;
  onSwipeRight?: (() => void) | null;
  /** Read by screen readers on the bubble. */
  label?: string;
};

/** Handlers to spread on a bubble. Plain closures (no hooks), so they're safe inside a list. */
export const messageGestures = ({ onTap, onHold, onSwipeLeft, onSwipeRight = null, label }: MessageActions) => {
  let timer: number | undefined;
  let start: { x: number; y: number; at: number } | null = null;
  let held = false;
  let lastTouch = 0;
  const clear = () => window.clearTimeout(timer);
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label ?? 'Message. Activate for reactions and actions',
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (!t || interactive(e.target)) return;
      start = { x: t.clientX, y: t.clientY, at: Date.now() };
      held = false;
      clear();
      if (onHold) {
        timer = window.setTimeout(() => {
          held = true;
          haptic('medium');
          onHold();
        }, HOLD_MS);
      }
    },
    onTouchMove: (e: React.TouchEvent) => {
      const t = e.touches[0];
      if (
        start &&
        t &&
        (Math.abs(t.clientX - start.x) > MOVE_CANCEL_PX || Math.abs(t.clientY - start.y) > MOVE_CANCEL_PX)
      ) {
        clear();
      }
    },
    onTouchEnd: (e: React.TouchEvent) => {
      clear();
      lastTouch = Date.now();
      const s = start;
      start = null;
      const t = e.changedTouches[0];
      if (!s || !t) return;
      const g = classifyTouch(t.clientX - s.x, t.clientY - s.y, Date.now() - s.at, held);
      if (g === 'tap' && onTap) onTap();
      else if (g === 'swipe-left' && onSwipeLeft) onSwipeLeft();
      else if (g === 'swipe-right' && onSwipeRight) onSwipeRight();
    },
    onTouchCancel: () => {
      clear();
      start = null;
    },
    // Mouse and keyboard: a click opens the reactions sheet (it holds Reply, Copy and Report too).
    onClick: (e: React.MouseEvent) => {
      if (Date.now() - lastTouch < GHOST_CLICK_MS || interactive(e.target)) return;
      onTap?.();
    },
    onContextMenu: (e: React.MouseEvent) => {
      if (!onTap) return;
      e.preventDefault();
      onTap();
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && onTap) {
        e.preventDefault();
        onTap();
      }
    },
  };
};
