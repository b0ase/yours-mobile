/**
 * SwipeRow: iOS Mail / Gmail style row actions for any list (bMail, airdrops; ready for chat and coins).
 *
 * - Short swipe LEFT reveals `leftActions` as a tray on the right edge (last item outermost).
 * - Short swipe RIGHT reveals `rightActions` as a tray on the left edge.
 * - A long / fast swipe past ~60% commits `fullSwipeLeft` / `fullSwipeRight` (an action id) with a haptic tick.
 * - Pointer events: touch, mouse and trackpad drag. The axis locks after 10px so vertical scroll is untouched.
 * - One row open at a time; tapping elsewhere or scrolling closes it.
 * - Accessible: every action (plus `moreActions`, e.g. Spam/Block) is in the "…" menu, which shows on hover/focus,
 *   opens on long-press and right-click, and on the ContextMenu key / Shift+F10. Hover also shows the tray icons.
 * - prefers-reduced-motion: no slide animations.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { ACTION_W, dragOffset, isArmed, lockAxis, resolveRelease, type SideSpec } from './gesture';
import { haptic } from './haptics';

export type SwipeAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  color: string;
  onPress: () => void;
  /** The action takes the row out of this list: a full swipe animates it away first. */
  removes?: boolean;
};

export type SwipeRowProps = {
  children: ReactNode;
  /** Revealed by a LEFT swipe (tray on the right edge, outermost last). */
  leftActions?: SwipeAction[];
  /** Revealed by a RIGHT swipe (tray on the left edge). */
  rightActions?: SwipeAction[];
  fullSwipeLeft?: string;
  fullSwipeRight?: string;
  /** Extra actions for the "…" / long-press menu only (Spam, Block…). */
  moreActions?: SwipeAction[];
  /** Accessible name of the row for the menu ("Actions for …"). */
  label: string;
  /** Show a selection checkbox (desktop bulk mode). */
  selected?: boolean;
  onSelect?: (on: boolean) => void;
  /** data-attribute so list keyboard shortcuts can find rows. */
  rowId?: string;
};

const reducedMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

let closeOpenRow: (() => void) | null = null;
const closeOthers = (mine: () => void) => {
  if (closeOpenRow && closeOpenRow !== mine) closeOpenRow();
  closeOpenRow = mine;
};

const LONG_PRESS_MS = 500;

export const SwipeRow = ({
  children,
  leftActions = [],
  rightActions = [],
  fullSwipeLeft,
  fullSwipeRight,
  moreActions = [],
  label,
  selected,
  onSelect,
  rowId,
}: SwipeRowProps) => {
  const wrap = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [gone, setGone] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuAt = (x: number, y: number) => setMenu({ x, y });
  const menuAtRow = () => {
    const r = wrap.current?.getBoundingClientRect();
    menuAt(r ? r.right - 8 : 0, r ? r.top + 8 : 0);
  };
  const g = useRef({
    id: -1,
    x0: 0,
    y0: 0,
    base: 0,
    axis: null as ReturnType<typeof lockAxis>,
    lastX: 0,
    lastT: 0,
    v: 0,
    armed: false,
    moved: false,
    long: 0 as ReturnType<typeof setTimeout> | 0,
  });
  const fullLeft = leftActions.find((a) => a.id === fullSwipeLeft);
  const fullRight = rightActions.find((a) => a.id === fullSwipeRight);
  const L: SideSpec = { count: leftActions.length, hasFull: !!fullLeft };
  const R: SideSpec = { count: rightActions.length, hasFull: !!fullRight };
  const width = () => wrap.current?.offsetWidth || 360;

  const close = useCallback(() => setOffset(0), []);
  // If the action did not take the row away (or it came back), show it again.
  useEffect(() => {
    if (!gone) return;
    const t = setTimeout(() => {
      setGone(false);
      setOffset(0);
    }, 1500);
    return () => clearTimeout(t);
  }, [gone]);
  useEffect(() => {
    if (offset === 0) return;
    closeOthers(close);
    const onScroll = () => close();
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('pointerdown', onDown, true);
      if (closeOpenRow === close) closeOpenRow = null;
    };
  }, [offset, close]);

  const run = (a: SwipeAction, viaFull: boolean) => {
    setMenu(null);
    if (viaFull && a.removes) {
      const w = width();
      if (reducedMotion()) {
        setGone(true);
        a.onPress();
        return;
      }
      setOffset(offset < 0 ? -w : w);
      setTimeout(() => setGone(true), 160);
      setTimeout(() => a.onPress(), 320);
      return;
    }
    setOffset(0);
    a.onPress();
  };

  const clearLong = () => {
    if (g.current.long) clearTimeout(g.current.long);
    g.current.long = 0;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-swipe-ignore]')) return;
    const s = g.current;
    s.id = e.pointerId;
    s.x0 = s.lastX = e.clientX;
    s.y0 = e.clientY;
    s.lastT = e.timeStamp;
    s.base = offset;
    s.axis = null;
    s.v = 0;
    s.moved = false;
    s.armed = false;
    clearLong();
    if (e.pointerType !== 'mouse')
      s.long = setTimeout(() => {
        if (!s.moved && s.id === e.pointerId) {
          s.moved = true; // swallow the click that follows
          haptic('light');
          menuAt(s.x0, s.y0);
        }
      }, LONG_PRESS_MS);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = g.current;
    if (s.id !== e.pointerId) return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    if (!s.axis) {
      s.axis = lockAxis(dx, dy);
      if (!s.axis) return;
      clearLong();
      if (s.axis === 'y') {
        s.id = -1;
        return;
      }
      s.moved = true;
      setDragging(true);
      closeOthers(close);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    const dt = Math.max(1, e.timeStamp - s.lastT);
    s.v = (e.clientX - s.lastX) / dt;
    s.lastX = e.clientX;
    s.lastT = e.timeStamp;
    const w = width();
    const o = dragOffset(s.base + dx, w, L, R);
    const armed = isArmed(o, w, o < 0 ? L : R);
    if (armed !== s.armed) {
      s.armed = armed;
      if (armed) haptic('medium');
    }
    setOffset(o);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = g.current;
    clearLong();
    if (s.id !== e.pointerId) return;
    s.id = -1;
    if (s.axis !== 'x') return;
    setDragging(false);
    const res = resolveRelease({ offset, width: width(), velocity: s.v, left: L, right: R });
    if (res === 'commit-left' && fullLeft) {
      haptic('heavy');
      run(fullLeft, true);
    } else if (res === 'commit-right' && fullRight) {
      haptic('heavy');
      run(fullRight, true);
    } else if (res === 'open-left') setOffset(-leftActions.length * ACTION_W);
    else if (res === 'open-right') setOffset(rightActions.length * ACTION_W);
    else setOffset(0);
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (g.current.moved) {
      g.current.moved = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (offset !== 0 && !(e.target as HTMLElement).closest('[data-swipe-ignore]')) {
      e.preventDefault();
      e.stopPropagation();
      setOffset(0);
    }
  };

  const all = [...rightActions, ...leftActions, ...moreActions].filter(
    (a, i, xs) => xs.findIndex((b) => b.id === a.id) === i,
  );
  const hover = [...rightActions, ...leftActions].filter((a, i, xs) => xs.findIndex((b) => b.id === a.id) === i);
  const anim = dragging || reducedMotion() ? 'none' : 'transform 180ms ease-out';
  const w = wrap.current?.offsetWidth || 360;
  const leftSide = offset < 0;
  const armedNow = dragging && isArmed(offset, w, leftSide ? L : R);

  if (gone) return <div aria-hidden className="bw-swipe-gone" style={{ height: 0, overflow: 'hidden' }} />;

  const trayBtn = (a: SwipeAction, flex: boolean) => (
    <button
      key={a.id}
      type="button"
      data-swipe-ignore
      tabIndex={offset ? 0 : -1}
      onClick={() => run(a, false)}
      className="flex h-full flex-col items-center justify-center gap-1 text-[11px] font-semibold text-white"
      style={{ background: a.color, width: flex ? undefined : ACTION_W, flex: flex ? 1 : undefined }}
    >
      {a.icon}
      <span>{a.label}</span>
    </button>
  );

  return (
    <div
      ref={wrap}
      className="bw-swipe group relative overflow-hidden rounded-xl"
      data-row-id={rowId}
      onContextMenu={(e) => {
        if (!all.length) return;
        e.preventDefault();
        menuAt(e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          menuAtRow();
        }
        if (e.key === 'Escape') {
          setMenu(null);
          setOffset(0);
        }
      }}
    >
      {/* Trays behind the row. */}
      {offset > 0 && (
        <div
          className="absolute inset-y-0 left-0 flex"
          style={{ width: Math.max(offset, rightActions.length * ACTION_W) }}
        >
          {armedNow && fullRight ? trayBtn(fullRight, true) : rightActions.map((a) => trayBtn(a, false))}
        </div>
      )}
      {offset < 0 && (
        <div
          className="absolute inset-y-0 right-0 flex justify-end"
          style={{ width: Math.max(-offset, leftActions.length * ACTION_W) }}
        >
          {armedNow && fullLeft ? trayBtn(fullLeft, true) : leftActions.map((a) => trayBtn(a, false))}
        </div>
      )}
      <div
        className="bw-swipe-face relative"
        style={{ transform: offset ? `translateX(${offset}px)` : undefined, transition: anim, touchAction: 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        {children}
        {onSelect && (
          <label
            data-swipe-ignore
            className={`bw-swipe-check absolute left-1 top-1 flex h-6 w-6 items-center justify-center${selected ? ' is-on' : ''}`}
          >
            <input
              type="checkbox"
              checked={!!selected}
              aria-label={`Select ${label}`}
              onChange={(e) => onSelect(e.target.checked)}
            />
          </label>
        )}
        {all.length > 0 && (
          <div data-swipe-ignore className="bw-swipe-hover absolute right-2 top-2 flex items-center gap-1">
            {hover.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.label}
                aria-label={a.label}
                tabIndex={-1}
                onClick={() => run(a, false)}
                className="bw-swipe-hover-btn flex h-8 w-8 items-center justify-center rounded-lg text-white"
                style={{ background: '#2b2f36' }}
              >
                {a.icon ?? a.label[0]}
              </button>
            ))}
            <button
              type="button"
              aria-label={`Actions for ${label}`}
              aria-haspopup="menu"
              aria-expanded={!!menu}
              onClick={(e) => {
                if (menu) return setMenu(null);
                const r = e.currentTarget.getBoundingClientRect();
                menuAt(r.right, r.bottom + 4);
              }}
              className="bw-swipe-more flex h-8 w-8 items-center justify-center rounded-lg text-white"
              style={{ background: '#2b2f36' }}
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        )}
      </div>
      {menu && (
        <SwipeMenu at={menu} label={label} actions={all} onPick={(a) => run(a, false)} onClose={() => setMenu(null)} />
      )}
    </div>
  );
};

const SwipeMenu = ({
  at,
  label,
  actions,
  onPick,
  onClose,
}: {
  label: string;
  actions: SwipeAction[];
  onPick: (a: SwipeAction) => void;
  onClose: () => void;
  at: { x: number; y: number };
}) => {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector('button')?.focus();
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [onClose]);
  // Fixed, in a portal: rows clip their overflow. Anchored at the "…" button / press point, kept on screen.
  const W = 200;
  const left = Math.max(8, Math.min(at.x - W, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - (actions.length * 44 + 16) - 8));
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={`Actions for ${label}`}
      data-swipe-ignore
      className="fixed z-[290] flex flex-col overflow-hidden rounded-xl py-1 shadow-xl"
      style={{ left, top, width: W, background: '#1d2025', border: '1px solid #2b2f36' }}
      onKeyDown={(e) => {
        const btns = [...(box.current?.querySelectorAll('button') ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          btns[(i + (e.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length]?.focus();
        }
        if (e.key === 'Escape' || e.key === 'Tab') onClose();
      }}
    >
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          role="menuitem"
          onClick={() => onPick(a)}
          className="flex min-h-[44px] items-center gap-2 px-3 text-left text-sm text-white hover:bg-[#2b2f36] focus:bg-[#2b2f36] focus:outline-none"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-md" style={{ background: a.color }}>
            {a.icon}
          </span>
          {a.label}
        </button>
      ))}
    </div>,
    document.body,
  );
};
