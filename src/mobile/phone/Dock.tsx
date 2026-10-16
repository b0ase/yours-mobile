import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw } from 'lucide-react';
import { useReducedMotion } from 'framer-motion';
import bGlyph from '../brand/bwallet-glyph.svg';
import { B_OUTLINE_D, B_OUTLINE_VIEWBOX } from '../brand/bOutline';
import { useBackClose } from '../backStack';
import { dockKey, isDefaultDock, moveInDock, removeFromDock, resetDock, splitDock, type DockItem } from './dockModel';
import { setAgentNote, setAgentVoice } from '../agent/handoff';
import { voiceNote } from '../agent/voiceText';
import { useHoldToTalk } from '../agent/useHoldToTalk';
import { HoldRing, TalkSheetView } from '../agent/TalkVisuals';
import { DOCK_LONG_PRESS_MS, edgeFade, fadeMask, longPressCancelled } from './gesture';
import { itemIcon, itemLabel } from './icons';
import { useThemedIcon } from '../brand/bappIcons';
import { TabBadge } from '../../components/TabBadge';

/**
 * The phone layout's dock (docs/PHONE-LAYOUT-PLAN.md §5, §14): left slots · the b · right slots, which scroll
 * sideways when there are more, with a fade on the side that has more. A sibling of the page, never inside it,
 * so its sideways scroll can't turn into a page swipe (PhoneShell also ignores touches that start here).
 * The big b in the centre: tap = HOME (the app grid), press and hold = talk to b (HomeButton).
 * Long-press a tile to arrange: tap a tile to pick it, then move it left/right or remove it; + adds; Reset
 * restores the default. An empty dock shows a dashed + tile, so arranging is never out of reach (owner, 15 Oct 2026).
 */
const GOLD = 'var(--bw-accent-hi)';
const MUTED = '#98A2B3';

type Props = {
  items: DockItem[];
  labels: Record<string, string>;
  activeKey: string | null;
  badges: Record<string, string | undefined>;
  /** Accessible names for badged tiles (default "<label>, N unread"). */
  badgeLabels?: Record<string, string | undefined>;
  onOpen: (item: DockItem) => void;
  onHome: () => void;
  /** Open the b agent page (after a hold: with the spoken request, or a note and the keyboard). */
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
  badgeLabel,
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
  badgeLabel?: string;
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
  // The bApp icon set follows the theme pack, like the Apps grid (brand/bappIcons/theme.ts).
  const themed = useThemedIcon(isApp ? item.icon : undefined);
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
        aria-label={
          arranging
            ? `${label}${picked ? ', selected' : ''}. Tap to select for moving`
            : badge
              ? (badgeLabel ?? `${label}, ${badge} unread`)
              : label
        }
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
                { background: 'var(--bw-surface)', boxShadow: picked ? `0 0 0 2px ${GOLD}` : undefined }
              : {
                  background: picked ? `color-mix(in srgb, ${GOLD} 20%, transparent)` : active ? '#2b2f36' : '#17191E',
                  border: `1px solid ${picked ? GOLD : '#2b2f36'}`,
                }
          }
        >
          {isApp && item.icon && !iconFailed ? (
            <img
              src={themed.src}
              alt=""
              draggable={false}
              onError={() => setIconFailed(true)}
              className={`h-10 w-10 rounded-[11px] object-cover${themed.paper ? ' bw-paper-icon' : ''}`}
            />
          ) : (
            <Icon size={isApp ? 18 : 20} color={isApp || active ? GOLD : '#F2F2F0'} />
          )}
          {badge && <TabBadge text={badge} />}
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
 * The big b in the centre (owner, 8 Oct 2026; bChatX's b in bit-sign follows the same spec):
 * tap = HOME (the app grid) · press and hold (B_HOLD_MS) = talk to b: a sheet slides up with sound bars and the
 * live transcript; release = send it to b (/m/ask-b, through its normal send: consent, price, confirm);
 * slide away then release = cancel. No mic / speech here: the hold opens b with the keyboard (as before) and a note.
 * The press is a pure state machine (gesture.ts bHold). iOS WKWebView swallows long presses and may cancel
 * pointer events, so touches drive it where there are any (pointer events for mouse/pen only), the callout and
 * selection are off. A gold ring fills while holding.
 */
export const HomeButton = ({
  onHome,
  onAgent,
  disabled,
}: {
  onHome: () => void;
  onAgent: () => void;
  disabled: boolean;
}) => {
  const focusComposer = () => document.querySelector<HTMLTextAreaElement>('[data-agent-input]')?.focus();
  const { phase, sheet, handlers, listening } = useHoldToTalk({
    disabled,
    onTap: onHome,
    onListen: (ok) => {
      // Owner, 10 Oct 2026: the hold opens b's chat at once; keep holding to talk, the reply lands there.
      onAgent();
      if (!ok) setAgentNote(voiceNote('unavailable', 'web'));
    },
    // Still inside the user's gesture: iOS lets the composer take focus (and show the keyboard) here.
    onUnsupportedRelease: focusComposer,
    onResult: (r) => {
      // b's page is already open (since the hold): the handoff event delivers the message to it.
      if ('text' in r) return setAgentVoice(r.text);
      setAgentNote(r.note);
      window.setTimeout(focusComposer, 50);
    },
  });
  return (
    <>
      {sheet && (
        <TalkSheetView
          sheet={sheet}
          phase={phase}
          idleText="Listening… release to send"
          hint="Let go to send to b · slide away to cancel"
          sendingHint="Sending to b…"
          noteHint="Let go to type to b instead"
        />
      )}
      <button
        type="button"
        disabled={disabled}
        aria-label="Home. Press and hold to talk to b"
        data-testid="dock-b"
        {...handlers}
        // Snug in the bar, centred, ring fully inside (owner, 8 Oct 2026; bChatX copies it).
        className="bw-dock-b relative shrink-0 h-[52px] w-[52px] rounded-full flex items-center justify-center border-0 select-none transition-transform disabled:opacity-40"
        style={{
          background: 'var(--bw-bg)',
          boxShadow: `0 0 0 2px ${GOLD}, 0 6px 18px rgba(0,0,0,0.6)`,
          transform: phase === 'pressing' ? 'scale(0.94)' : listening ? 'scale(1.04)' : undefined,
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <HoldRing phase={phase} />
        <img
          src={bGlyph}
          alt=""
          width={30}
          height={30}
          draggable={false}
          className="bw-dock-b-gold pointer-events-none"
        />
        {/* White theme only (themes.css swaps them): the shared outline b, black on white. */}
        <svg
          className="bw-dock-b-outline pointer-events-none"
          width={30}
          height={30}
          viewBox={B_OUTLINE_VIEWBOX}
          fill="none"
          stroke="#0A0A0A"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d={B_OUTLINE_D} vectorEffect="non-scaling-stroke" />
        </svg>
      </button>
    </>
  );
};

export const Dock = ({
  items,
  labels,
  activeKey,
  badges,
  badgeLabels,
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
  const [confirmReset, setConfirmReset] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const done = () => {
    setArranging(false);
    setPicked(null);
    setConfirmReset(false);
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

  const empty = items.length === 0;
  const atDefault = isDefaultDock(items);
  const addTile = (
    <div className="relative shrink-0 flex justify-center" style={{ width: 74 }}>
      <button
        type="button"
        aria-label="Add to the dock"
        data-testid="dock-add-empty"
        onClick={() => {
          setArranging(true);
          onAdd();
        }}
        className="flex flex-col items-center gap-1 w-full py-1 bg-transparent border-0 select-none"
      >
        <span
          className="flex h-10 w-10 items-center justify-center rounded-2xl"
          style={{ border: `1.5px dashed ${GOLD}` }}
        >
          <Plus size={20} color={GOLD} />
        </span>
        <span className="text-[10px] leading-tight" style={{ color: GOLD, fontWeight: 600 }}>
          Add
        </span>
      </button>
    </div>
  );

  const tile = (item: DockItem, i: number) => {
    const k = dockKey(item);
    return (
      <Tile
        key={k}
        item={item}
        label={itemLabel(item, labels)}
        active={k === activeKey}
        badge={badges[k]}
        badgeLabel={badgeLabels?.[k]}
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
          className="absolute left-0 right-0 z-[101] px-3 pb-2 flex flex-col gap-1.5"
          style={{ bottom: 'var(--dock-h)' }}
          role="toolbar"
          aria-label="Arrange the dock"
        >
          <p
            className="m-0 self-center rounded-full px-3 py-1 text-center text-[11px] leading-tight backdrop-blur-md"
            style={{ color: MUTED, background: 'rgba(23,25,30,0.92)' }}
          >
            {confirmReset && pickedIndex < 0
              ? `Put back ${resetDock()
                  .map((i) => itemLabel(i, labels))
                  .join(', ')}?`
              : 'Tap an icon to move or remove it · Add · Reset · Done'}
          </p>
          <div className="flex items-center gap-2">
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
                {pickedIndex >= 0 ? itemLabel(items[pickedIndex], labels) : ''}
              </span>
              {pickedIndex >= 0 ? (
                // Touch and hold › Remove from Dock: it goes back to the Home grid (owner, round 4).
                <button
                  type="button"
                  onClick={() => {
                    onChange(removeFromDock(items, items[pickedIndex]));
                    setPicked(null);
                  }}
                  className="h-8 rounded-full px-3 flex items-center gap-1 text-[12px] font-bold border-0 bg-[#2b2f36] text-white"
                >
                  <Minus size={14} /> Remove from Dock
                </button>
              ) : confirmReset ? (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="h-8 rounded-full px-3 text-[12px] font-bold border-0 bg-[#2b2f36] text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    data-testid="dock-reset-confirm"
                    onClick={() => {
                      onChange(resetDock());
                      setConfirmReset(false);
                    }}
                    className="h-8 rounded-full px-3 text-[12px] font-bold border-0"
                    style={{ background: GOLD, color: '#010101' }}
                  >
                    Reset
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={onAdd}
                    className="h-8 rounded-full px-3 flex items-center gap-1 text-[12px] font-bold border-0 bg-[#2b2f36] text-white"
                  >
                    <Plus size={14} /> Add
                  </button>
                  <button
                    type="button"
                    aria-label="Reset the dock to default"
                    data-testid="dock-reset"
                    disabled={atDefault}
                    onClick={() => setConfirmReset(true)}
                    className="h-8 rounded-full px-3 flex items-center gap-1 text-[12px] font-bold border-0 bg-[#2b2f36] text-white disabled:opacity-30"
                  >
                    <RotateCcw size={13} /> Reset
                  </button>
                </>
              )}
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
            {empty && addTile}
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
