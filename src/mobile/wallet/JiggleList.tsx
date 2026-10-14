/**
 * iPhone-style reorder for a vertical list (owner, 15 Oct 2026): in jiggle mode every row wiggles and shows a
 * drag handle; drag a handle to move the row, the others slide out of the way, and the list auto-scrolls near
 * the screen edges. Pointer events with touch-action: none on the handle only, so the page still scrolls
 * from the rows. prefers-reduced-motion: no wiggle, handles only.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { haptic } from '../swipe/haptics';
import { moveItem } from './tokenRows';

export type JiggleItem = { id: string; node: ReactNode };

const EDGE = 72;

const scrollParent = (el: HTMLElement | null): HTMLElement | null => {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
};

export const JiggleList = ({
  items,
  editing,
  onReorder,
}: {
  items: JiggleItem[];
  editing: boolean;
  onReorder: (ids: string[]) => void;
}) => {
  const rows = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; dy: number } | null>(null);
  const g = useRef({ startY: 0, startScroll: 0, y: 0, heights: [] as number[], tops: [] as number[], raf: 0 });
  const scroller = useRef<HTMLElement | null>(null);

  useEffect(() => () => cancelAnimationFrame(g.current.raf), []);

  const targetFor = (from: number, dy: number) => {
    const { tops, heights } = g.current;
    const centre = tops[from] + heights[from] / 2 + dy;
    let to = from;
    for (let i = 0; i < tops.length; i++) {
      const mid = tops[i] + heights[i] / 2;
      if (i < from && centre < mid) {
        to = i;
        break;
      }
      if (i > from && centre > mid) to = i;
    }
    return to;
  };

  const update = () => {
    const s = g.current;
    const sc = scroller.current;
    const scrolled = sc ? sc.scrollTop - s.startScroll : 0;
    const dy = s.y - s.startY + scrolled;
    setDrag((d) => (d ? { ...d, dy, to: targetFor(d.from, dy) } : d));
  };
  const autoScroll = () => {
    const s = g.current;
    const sc = scroller.current;
    if (sc) {
      const h = window.innerHeight;
      const step = s.y < EDGE ? -(EDGE - s.y) / 4 : s.y > h - EDGE ? (s.y - (h - EDGE)) / 4 : 0;
      if (step) {
        sc.scrollTop += step;
        update();
      }
    }
    s.raf = requestAnimationFrame(autoScroll);
  };

  const down = (id: string, index: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const s = g.current;
    s.startY = e.clientY;
    s.y = e.clientY;
    s.heights = items.map((it) => rows.current.get(it.id)?.offsetHeight ?? 0);
    s.tops = items.map((it) => rows.current.get(it.id)?.getBoundingClientRect().top ?? 0);
    scroller.current = scrollParent(rows.current.get(id) ?? null);
    s.startScroll = scroller.current?.scrollTop ?? 0;
    haptic('light');
    setDrag({ id, from: index, to: index, dy: 0 });
    cancelAnimationFrame(s.raf);
    s.raf = requestAnimationFrame(autoScroll);
  };
  const move = (e: React.PointerEvent) => {
    if (!drag) return;
    g.current.y = e.clientY;
    update();
  };
  const up = () => {
    cancelAnimationFrame(g.current.raf);
    if (!drag) return;
    const { from, to } = drag;
    setDrag(null);
    if (from !== to) {
      haptic('medium');
      onReorder(moveItem(items, from, to).map((i) => i.id));
    }
  };

  const shiftFor = (i: number) => {
    if (!drag || i === drag.from) return 0;
    const h = g.current.heights[drag.from] ?? 0;
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -h;
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return h;
    return 0;
  };

  return (
    <div className={`bw-jiggle${editing ? ' is-editing' : ''}`}>
      {items.map((it, i) => {
        const dragging = drag?.id === it.id;
        return (
          <div
            key={it.id}
            ref={(el) => {
              if (el) rows.current.set(it.id, el);
              else rows.current.delete(it.id);
            }}
            className={`bw-jiggle-row${dragging ? ' is-drag' : ''}`}
            style={{
              transform: `translateY(${dragging ? drag.dy : shiftFor(i)}px)`,
              transition: dragging ? 'none' : 'transform 160ms ease',
              zIndex: dragging ? 5 : undefined,
              animationDelay: `${(i % 3) * -0.09}s`,
            }}
          >
            <div className="bw-jiggle-body">{it.node}</div>
            {editing && (
              <button
                type="button"
                aria-label="Hold and drag to move"
                className="bw-jiggle-handle"
                onPointerDown={down(it.id, i)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
              >
                <GripVertical size={20} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
