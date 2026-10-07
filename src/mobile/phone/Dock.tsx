import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import bGlyph from '../brand/bwallet-glyph.svg';
import { useBackClose } from '../backStack';
import { isBWalletX } from '../storeBuild';
import { dockKey, moveInDock, removeFromDock, splitDock, type DockItem } from './dockModel';
import { B_HOLD_MS, B_HOLD_SLOP, DOCK_LONG_PRESS_MS, edgeFade, fadeMask, longPressCancelled } from './gesture';
import { itemIcon, itemLabel } from './icons';

/**
 * The phone layout's dock (docs/PHONE-LAYOUT-PLAN.md §5, §14): left slots · the b · right slots, which scroll
 * sideways when there are more, with a fade on the side that has more. A sibling of the page, never inside it,
 * so its sideways scroll can't turn into a page swipe (PhoneShell also ignores touches that start here).
 * The big b in the centre: tap = HOME (the app grid), touch and hold = the b agent page.
 * Long-press a tile to arrange: tap a tile to pick it, then move it left/right or remove it; + adds.
 */
const GOLD = '#FFD24D';
const MUTED = '#98A2B3';
const FLIP = !isBWalletX();

type Props = {
  items: DockItem[];
  labels: Record<string, string>;
  activeKey: string | null;
  badges: Record<string, string | undefined>;
  onOpen: (item: DockItem) => void;
  onHome: () => void;
  /** Touch and hold the b: the b agent page. */
  onAgent: () => void;
  onChange: (items: DockItem[]) => void;
  onAdd: () => void;
  /** Bumped by the shell on a page change: arranging ends. */
  pageKey: string;
  /** Page dots, shown along the top of the dock (strip pages only). */
  dots?: React.ReactNode;
};

const Tile = ({
  item,
  label,
  active,
  badge,
  arranging,
  picked,
  alt,
  onTap,
  onLongPress,
  onRemove,
}: {
  item: DockItem;
  label: string;
  active: boolean;
  badge?: string;
  arranging: boolean;
  picked: boolean;
  alt: boolean;
  onTap: () => void;
  onLongPress: () => void;
  onRemove: () => void;
}) => {
  const Icon = itemIcon(item);
  const isApp = item.kind === 'app';
  const [iconFailed, setIconFailed] = useState(false);
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  return (
    <div className="relative shrink-0 flex justify-center" style={{ width: 74 }}>
      <button
        type="button"
        aria-label={arranging ? `${label}${picked ? ', selected' : ''}. Tap to select for moving` : label}
        aria-current={active ? 'page' : undefined}
        onPointerDown={(e) => {
          fired.current = false;
          start.current = { x: e.clientX, y: e.clientY };
          clear();
          if (!arranging)
            timer.current = window.setTimeout(() => {
              fired.current = true;
              navigator.vibrate?.(10);
              onLongPress();
            }, DOCK_LONG_PRESS_MS);
        }}
        onPointerMove={(e) => {
          const s = start.current;
          if (s && longPressCancelled(e.clientX - s.x, e.clientY - s.y)) clear();
        }}
        onPointerUp={clear}
        onPointerCancel={clear}
        onPointerLeave={clear}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (fired.current) return void (fired.current = false);
          onTap();
        }}
        className={`flex flex-col items-center gap-1 w-full py-1 bg-transparent border-0 select-none ${arranging ? `bw-jiggle${alt ? ' bw-jiggle-alt' : ''}` : ''}`}
        style={{ WebkitTouchCallout: 'none' }}
      >
        <span
          className={`relative flex h-10 w-10 items-center justify-center ${isApp ? 'rounded-[11px]' : 'rounded-2xl'}`}
          style={
            isApp
              ? // Apps look like their Apps-page tile: the icon fills the rounded square (BrowserPage TileIcon).
                { background: '#17191E', boxShadow: picked ? `0 0 0 2px ${GOLD}` : undefined }
              : {
                  background: picked ? `${GOLD}33` : active ? '#2b2f36' : '#17191E',
                  border: `1px solid ${picked ? GOLD : '#2b2f36'}`,
                }
          }
        >
          {isApp && item.icon && !iconFailed ? (
            <img
              src={item.icon}
              alt=""
              draggable={false}
              onError={() => setIconFailed(true)}
              className="h-10 w-10 rounded-[11px] object-cover"
            />
          ) : (
            <Icon size={isApp ? 18 : 20} color={isApp || active ? GOLD : '#F2F2F0'} />
          )}
          {badge && (
            <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-[#F04438] text-[9px] font-bold text-white flex items-center justify-center">
              {badge}
            </span>
          )}
        </span>
        <span
          className="w-full overflow-hidden text-ellipsis whitespace-nowrap text-center text-[10px] leading-tight"
          style={{ color: active ? GOLD : MUTED, fontWeight: active ? 700 : 500 }}
        >
          {label}
        </span>
      </button>
      {arranging && (
        <button
          type="button"
          aria-label={`Remove ${label} from the dock`}
          onClick={onRemove}
          className="absolute -top-0.5 left-1 h-5 w-5 rounded-full flex items-center justify-center border-0"
          style={{ background: '#3a3d44' }}
        >
          <Minus size={12} color="#fff" />
        </button>
      )}
    </div>
  );
};

/**
 * The big b in the centre. Tap = HOME (the app grid); touch and hold (B_HOLD_MS) = the b agent page (/m/agent).
 * iOS WKWebView swallows long presses (callout, selection, contextmenu) and may cancel pointer events, so the
 * hold runs on touch events where there are any (pointer events only for mouse/pen), the callout and selection
 * are off, and the press is decided here, not by click: a tap never also holds, a hold never also taps.
 * A gold ring fills while holding.
 */
const HomeButton = ({ onHome, onAgent, disabled }: { onHome: () => void; onAgent: () => void; disabled: boolean }) => {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const lastTouch = useRef(0);
  const [pressing, setPressing] = useState(false);
  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
    setPressing(false);
  };
  useEffect(() => stop, []);
  const begin = (x: number, y: number) => {
    if (disabled) return;
    stop();
    held.current = false;
    start.current = { x, y };
    setPressing(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      held.current = true;
      setPressing(false);
      navigator.vibrate?.(15);
      onAgent();
    }, B_HOLD_MS);
  };
  const move = (x: number, y: number) => {
    const s = start.current;
    if (s && longPressCancelled(x - s.x, y - s.y, B_HOLD_SLOP)) stop();
  };
  const end = () => {
    const wasPress = start.current !== null;
    const wasHeld = held.current;
    stop();
    held.current = false;
    if (wasHeld) {
      // Still inside the user's gesture: iOS lets the composer take focus (and show the keyboard) here.
      document.querySelector<HTMLTextAreaElement>('[data-agent-input]')?.focus();
      return;
    }
    if (wasPress) onHome();
  };
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label="Home. Touch and hold to ask b"
      data-testid="dock-b"
      onTouchStart={(e) => {
        lastTouch.current = Date.now();
        const t = e.touches[0];
        if (e.touches.length === 1 && t) begin(t.clientX, t.clientY);
      }}
      onTouchMove={(e) => {
        const t = e.touches[0];
        if (t) move(t.clientX, t.clientY);
      }}
      onTouchEnd={(e) => {
        e.preventDefault(); // no synthetic mouse/click after a touch
        lastTouch.current = Date.now();
        end();
      }}
      onTouchCancel={stop}
      // Pointer events for mouse and pen only: on touch, WKWebView may cancel them mid-hold.
      onPointerDown={(e) =>
        e.pointerType !== 'touch' && Date.now() - lastTouch.current > 800 && begin(e.clientX, e.clientY)
      }
      onPointerMove={(e) => e.pointerType !== 'touch' && move(e.clientX, e.clientY)}
      onPointerUp={(e) => e.pointerType !== 'touch' && Date.now() - lastTouch.current > 800 && end()}
      onPointerLeave={(e) => e.pointerType !== 'touch' && stop()}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => {
        // Keyboard activation only (Enter/Space have detail 0); touch and mouse are handled above.
        if (e.detail === 0) onHome();
      }}
      className="relative shrink-0 -mt-1 h-[52px] w-[52px] rounded-full flex items-center justify-center border-0 select-none transition-transform disabled:opacity-40"
      style={{
        background: FLIP ? '#F5B800' : '#010101',
        boxShadow: `0 0 0 2px ${FLIP ? '#010101' : GOLD}, 0 6px 18px rgba(0,0,0,0.6)`,
        transform: pressing ? 'scale(0.94)' : undefined,
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      {pressing && (
        <svg className="absolute -inset-[5px] pointer-events-none" viewBox="0 0 62 62" aria-hidden>
          <circle
            cx="31"
            cy="31"
            r="29"
            fill="none"
            stroke={FLIP ? '#010101' : GOLD}
            strokeWidth="3"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="100"
            transform="rotate(-90 31 31)"
            className="bw-hold-ring"
            style={{ animationDuration: `${B_HOLD_MS}ms` }}
          />
        </svg>
      )}
      {FLIP ? (
        <svg viewBox="23 8 74 100" width={22} height={30} aria-hidden>
          <mask id="bdock">
            <rect x="0" y="0" width="140" height="140" fill="#fff" />
            <circle cx="60" cy="72" r="15" fill="#000" />
          </mask>
          <g fill="#010101" mask="url(#bdock)">
            <polygon points="45,12 45,76 27,76 27,30" />
            <circle cx="60" cy="72" r="33" />
          </g>
        </svg>
      ) : (
        <img src={bGlyph} alt="" width={30} height={30} draggable={false} className="pointer-events-none" />
      )}
    </button>
  );
};

export const Dock = ({
  items,
  labels,
  activeKey,
  badges,
  onOpen,
  onHome,
  onAgent,
  onChange,
  onAdd,
  pageKey,
  dots,
}: Props) => {
  const reduce = useReducedMotion();
  const [arranging, setArranging] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const done = () => {
    setArranging(false);
    setPicked(null);
  };
  useBackClose(arranging, done);
  // Arranging ends on a page change or when the app goes to the background (same rules as Apps › Home).
  useEffect(() => done(), [pageKey]);
  useEffect(() => {
    if (!arranging) return;
    const onHide = () => document.hidden && done();
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [arranging]);

  const { left, right } = splitDock(items);
  const measure = () => {
    const el = scroller.current;
    if (el) setFade(edgeFade(el.scrollLeft, el.scrollWidth, el.clientWidth));
  };
  useLayoutEffect(measure, [items.length, arranging]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const pickedIndex = picked ? items.findIndex((i) => dockKey(i) === picked) : -1;
  const move = (dir: -1 | 1) => {
    if (pickedIndex < 0) return;
    onChange(moveInDock(items, pickedIndex, pickedIndex + dir));
  };

  const tile = (item: DockItem, i: number) => {
    const k = dockKey(item);
    return (
      <Tile
        key={k}
        item={item}
        label={itemLabel(item, labels)}
        active={k === activeKey}
        badge={badges[k]}
        arranging={arranging}
        picked={picked === k}
        alt={i % 2 === 1}
        onTap={() => (arranging ? setPicked(picked === k ? null : k) : onOpen(item))}
        onLongPress={() => {
          setArranging(true);
          setPicked(k);
        }}
        onRemove={() => {
          onChange(removeFromDock(items, item));
          if (picked === k) setPicked(null);
        }}
      />
    );
  };

  return (
    <>
      {arranging && (
        <div
          className="absolute left-0 right-0 z-[101] px-3 pb-2 flex items-center gap-2"
          style={{ bottom: 'var(--dock-h)' }}
          role="toolbar"
          aria-label="Arrange the dock"
        >
          <div
            className="flex-1 flex items-center gap-1.5 rounded-2xl px-2 py-1.5 backdrop-blur-md"
            style={{ background: 'rgba(23,25,30,0.92)', border: '1px solid #2b2f36' }}
          >
            <button
              type="button"
              aria-label="Move left"
              disabled={pickedIndex <= 0}
              onClick={() => move(-1)}
              className="h-8 w-8 rounded-full flex items-center justify-center bg-[#2b2f36] border-0 disabled:opacity-30"
            >
              <ChevronLeft size={16} color="#fff" />
            </button>
            <button
              type="button"
              aria-label="Move right"
              disabled={pickedIndex < 0 || pickedIndex >= items.length - 1}
              onClick={() => move(1)}
              className="h-8 w-8 rounded-full flex items-center justify-center bg-[#2b2f36] border-0 disabled:opacity-30"
            >
              <ChevronRight size={16} color="#fff" />
            </button>
            <span className="flex-1 min-w-0 text-[11px] leading-tight" style={{ color: MUTED }}>
              {pickedIndex >= 0 ? `Move ${itemLabel(items[pickedIndex], labels)}` : 'Tap an item to move it'}
            </span>
            <button
              type="button"
              onClick={onAdd}
              className="h-8 rounded-full px-3 flex items-center gap-1 text-[12px] font-bold border-0 bg-[#2b2f36] text-white"
            >
              <Plus size={14} /> Add
            </button>
          </div>
          <button
            type="button"
            onClick={done}
            className="rounded-full px-4 py-2 text-[13px] font-bold border-0"
            style={{ background: GOLD, color: '#010101' }}
          >
            Done
          </button>
        </div>
      )}
      <nav
        aria-label="Dock"
        data-phone-dock
        className="absolute bottom-0 left-0 right-0 z-[100] flex flex-col"
        style={{ height: 'var(--dock-h)', background: '#0A0B0D', borderTop: '1px solid #1C1C1E' }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="h-4 shrink-0">{dots}</div>
        <div className="flex-1 min-h-0 flex items-center px-1">
          <div className="flex-1 flex items-center justify-around min-w-0">
            {left.map((it, i) => tile(it, i))}
            {left.length === 0 && arranging && (
              <span className="text-[10px]" style={{ color: MUTED }}>
                Empty
              </span>
            )}
          </div>
          <HomeButton onHome={onHome} onAgent={onAgent} disabled={arranging} />
          <div
            ref={scroller}
            onScroll={measure}
            className="bw-dock-scroll flex-1 min-w-0 flex items-center overflow-x-auto overflow-y-hidden"
            style={{
              touchAction: 'pan-x',
              overscrollBehaviorX: 'contain',
              scrollSnapType: 'x proximity',
              scrollBehavior: reduce ? 'auto' : 'smooth',
              maskImage: fadeMask(fade),
              WebkitMaskImage: fadeMask(fade),
              justifyContent: right.length <= 2 ? 'space-around' : undefined,
            }}
          >
            {right.map((it, i) => (
              <div key={dockKey(it)} style={{ scrollSnapAlign: 'start' }}>
                {tile(it, left.length + i)}
              </div>
            ))}
          </div>
        </div>
      </nav>
    </>
  );
};
