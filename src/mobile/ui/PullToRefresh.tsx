import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from 'framer-motion';
import glyph from '../brand/bwallet-glyph.svg';
import { DECIDE, THRESHOLD, gestureIntent, rubberBand, shouldRefresh } from './pullMath';

/**
 * Pull-to-refresh for a scroll container. Drop `<PullToRefresh onRefresh={…} />` as the FIRST child
 * of the scrollable element: it attaches to its parent, so the screen's markup stays as it is.
 *
 * - Arms only when the touch starts with every scrollable ancestor at the top.
 * - A mostly horizontal drag (Apps pages, carousels) cancels it.
 * - Rubber-band resistance; release past THRESHOLD refreshes, the indicator holds, then snaps back.
 * - overscroll-behavior-y: contain on the container, so the WebView's own glow/bounce stays out of it.
 */

const MIN_SPIN_MS = 500;
const GOLD = '#FFD24D';

const atTop = (from: EventTarget | null, container: HTMLElement): boolean => {
  if (container.scrollTop > 0) return false;
  for (let n = from instanceof Element ? from : null; n && n !== container; n = n.parentElement) {
    if (n.scrollTop > 0) return false;
  }
  return true;
};

type Props = {
  onRefresh: () => unknown;
  /** Off while the screen can't refresh (e.g. signed out). */
  disabled?: boolean;
};

export const PullToRefresh = ({ onRefresh, disabled }: Props) => {
  const reduce = useReducedMotion();
  const anchor = useRef<HTMLSpanElement>(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [top, setTop] = useState(0);
  const [dragging, setDragging] = useState(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  const busy = useRef(false);
  const off = useRef(disabled);
  off.current = disabled;

  useEffect(() => {
    const el = anchor.current?.parentElement;
    if (!el) return;
    const prevOverscroll = el.style.overscrollBehaviorY;
    el.style.overscrollBehaviorY = 'contain';
    let start: { x: number; y: number } | null = null;
    let mode: 'pull' | 'cancel' | 'undecided' = 'undecided';
    let dist = 0;

    const reset = () => {
      start = null;
      mode = 'undecided';
      dist = 0;
      setDragging(false);
    };
    const onStart = (e: TouchEvent) => {
      if (busy.current || off.current || e.touches.length !== 1 || !atTop(e.target, el)) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      mode = 'undecided';
      setTop(Math.max(0, el.getBoundingClientRect().top));
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.touches[0].clientX - start.x;
      const dy = e.touches[0].clientY - start.y;
      if (mode === 'undecided') {
        mode = gestureIntent(dx, dy);
        if (mode === 'cancel') return reset();
        if (mode === 'undecided') return;
        setDragging(true);
      }
      if (el.scrollTop > 0) return reset();
      dist = rubberBand(dy - DECIDE);
      if (e.cancelable) e.preventDefault();
      setPull(dist);
    };
    const onEnd = () => {
      if (!start) return;
      const fire = mode === 'pull' && shouldRefresh(dist);
      reset();
      if (!fire) return setPull(0);
      busy.current = true;
      setRefreshing(true);
      setPull(THRESHOLD);
      const t0 = Date.now();
      void Promise.resolve()
        .then(() => cb.current())
        .catch(() => undefined)
        .then(() => new Promise((r) => setTimeout(r, Math.max(0, MIN_SPIN_MS - (Date.now() - t0)))))
        .then(() => {
          busy.current = false;
          setRefreshing(false);
          setPull(0);
        });
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.style.overscrollBehaviorY = prevOverscroll;
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  const progress = Math.min(1, pull / THRESHOLD);
  const R = 17;
  const C = 2 * Math.PI * R;
  const visible = pull > 0 || refreshing;

  return (
    <>
      <span ref={anchor} hidden />
      {createPortal(
        <div
          aria-hidden={!refreshing}
          role={refreshing ? 'status' : undefined}
          aria-label={refreshing ? 'Refreshing' : undefined}
          className="pointer-events-none fixed left-1/2 z-[60]"
          style={{
            top,
            width: 40,
            height: 40,
            marginLeft: -20,
            opacity: visible ? Math.max(0.25, progress) : 0,
            transform: `translateY(${pull - 44}px)`,
            transition: dragging || reduce ? 'opacity 120ms linear' : 'transform 260ms ease-out, opacity 200ms linear',
          }}
        >
          <div
            className="relative h-full w-full rounded-full"
            style={{
              background: 'rgba(12,12,12,0.92)',
              boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
              border: '1px solid rgba(255,210,77,0.25)',
            }}
          >
            <svg
              width={40}
              height={40}
              viewBox="0 0 40 40"
              className="absolute inset-0"
              style={{
                animation: refreshing && !reduce ? 'bw-ptr-spin 0.9s linear infinite' : undefined,
              }}
            >
              <circle
                cx={20}
                cy={20}
                r={R}
                fill="none"
                stroke={GOLD}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray={`${(refreshing ? 0.7 : progress * 0.85) * C} ${C}`}
                transform="rotate(-90 20 20)"
              />
            </svg>
            <img
              src={glyph}
              alt=""
              className="absolute inset-0 m-auto"
              style={{
                width: 20,
                height: 20,
                transform: reduce ? undefined : `rotate(${progress * 270}deg)`,
                opacity: shouldRefresh(pull) || refreshing ? 1 : 0.7,
              }}
            />
          </div>
          <style>{'@keyframes bw-ptr-spin{to{transform:rotate(360deg)}}'}</style>
        </div>,
        document.body,
      )}
    </>
  );
};
