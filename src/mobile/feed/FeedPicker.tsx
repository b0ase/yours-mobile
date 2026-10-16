/**
 * The Feed picker: a left / right scrolling row of feeds (Home, the red / green / blue
 * suite, pinned feeds, then "All feeds"), and the All feeds sheet (bApps, then Other) where feeds are
 * opened and pinned. Each bApp's own colour rings its icon and marks it when open. See feeds.ts.
 * The scroll is made obvious: chips are sized so the last visible one is cut off, the right edge fades,
 * and the open feed is kept scrolled into view.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, House, LayoutGrid, Pin, Sparkles, X, type LucideIcon } from 'lucide-react';
import { useBackClose } from '../backStack';
import { BappIcon } from '../brand/bappIcons';
import { ALL_FEEDS_ICON, feedIcon, type FeedGlyph, type FeedIcon } from './feedIcons';
import { FIXED_ROW, GOLD, feedColor, feedDef, feedGroups, rowFeeds, type FeedId } from './feeds';

const INK = '#1a1300';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

const GLYPHS: Record<FeedGlyph, LucideIcon> = { home: House, foryou: Sparkles, all: LayoutGrid };

/** `#rrggbb` + alpha (0–1) as rgba(). */
const alpha = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/** One feed icon on a black tile, ringed in its bApp's colour (solid ring + glow when open). */
export const IconTile = ({ icon, color, on, size }: { icon: FeedIcon; color: string; on: boolean; size: number }) => {
  const Glyph = icon.kind === 'glyph' ? GLYPHS[icon.glyph] : null;
  return (
    <span
      className="relative flex shrink-0 items-center justify-center overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: '#000',
        boxShadow: on ? `0 0 0 2px ${color}, 0 0 14px ${alpha(color, 0.5)}` : `inset 0 0 0 1.5px ${alpha(color, 0.55)}`,
      }}
    >
      {icon.kind === 'bapp' ? (
        <BappIcon slug={icon.slug} label={icon.label} color={color} size={size} className="h-full w-full" />
      ) : icon.kind === 'app' ? (
        <img src={icon.src} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : icon.kind === 'letter' ? (
        <span style={{ color, fontWeight: 800, fontSize: size * 0.46, lineHeight: 1 }}>{icon.letter}</span>
      ) : (
        Glyph && <Glyph size={Math.round(size * 0.45)} color={color} strokeWidth={on ? 2.4 : 1.9} />
      )}
    </span>
  );
};

const Chip = ({
  label,
  icon,
  color,
  on,
  onClick,
}: {
  label: string;
  icon: FeedIcon;
  color: string;
  on: boolean;
  onClick: () => void;
}) => {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView?.({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [on]);
  return (
    <button
      ref={ref}
      onClick={onClick}
      role="tab"
      aria-selected={on}
      aria-label={label}
      className="flex w-[62px] shrink-0 flex-col items-center gap-1 py-1 active:opacity-70"
    >
      <IconTile icon={icon} color={color} on={on} size={44} />
      <span
        className="max-w-full truncate text-[11px]"
        style={{ color: on ? color : alpha(color, 0.75), fontWeight: on ? 700 : 500 }}
      >
        {label}
      </span>
    </button>
  );
};

export const FeedPicker = ({
  pins,
  current,
  allOpen,
  onPick,
  onOpenAll,
}: {
  pins: FeedId[];
  current: FeedId;
  allOpen: boolean;
  onPick: (id: FeedId) => void;
  onOpenAll: () => void;
}) => {
  const row = rowFeeds(pins);
  return (
    <div className="relative pb-2">
      <div
        className="flex items-start gap-2 overflow-x-auto px-3 pr-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Feeds"
      >
        {row.map((id) => (
          <Chip
            key={id}
            label={feedDef(id).label}
            icon={feedIcon(id)}
            color={feedColor(id)}
            on={id === current}
            onClick={() => onPick(id)}
          />
        ))}
        <Chip
          label="All feeds"
          icon={ALL_FEEDS_ICON}
          color={GOLD}
          on={allOpen || !row.includes(current)}
          onClick={onOpenAll}
        />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10"
        style={{
          background:
            'linear-gradient(to right, rgb(var(--bw-fade-rgb, 0 0 0) / 0), rgb(var(--bw-fade-rgb, 0 0 0) / 0.85))',
        }}
      />
    </div>
  );
};

export const AllFeedsSheet = ({
  pins,
  current,
  onPick,
  onTogglePin,
  onMovePin,
  onClose,
}: {
  pins: FeedId[];
  current: FeedId;
  onPick: (id: FeedId) => void;
  onTogglePin: (id: FeedId) => void;
  onMovePin: (id: FeedId, dir: 1 | -1) => void;
  onClose: () => void;
}) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl p-4 pb-10 max-h-[85vh] overflow-y-auto"
        style={{ background: '#0b0c0e', borderTop: `1px solid ${LINE}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-base font-bold text-white">All feeds</h3>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={18} color={MUTED} />
          </button>
        </div>
        <p className="mb-3 text-xs" style={{ color: MUTED }}>
          Tap a feed to open it. Pin any feed to move it to the front of the top row.
        </p>
        {pins.length > 0 && (
          <section className="mb-4">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
              Pinned
            </h4>
            <ol className="flex flex-col gap-1.5">
              {pins.map((id, i) => {
                const f = feedDef(id);
                return (
                  <li
                    key={id}
                    className="flex items-center gap-3 rounded-xl px-2 py-1.5"
                    style={{ background: '#0d0d0f', border: `1px solid ${alpha(f.color, 0.3)}` }}
                  >
                    <button onClick={() => onPick(id)} className="flex flex-1 items-center gap-3 text-left">
                      <IconTile icon={feedIcon(id)} color={f.color} on={id === current} size={28} />
                      <span className="text-sm font-bold" style={{ color: f.color }}>
                        {f.label}
                      </span>
                    </button>
                    <button
                      onClick={() => onMovePin(id, -1)}
                      disabled={i === 0}
                      aria-label={`Move ${f.label} up`}
                      className="p-1.5 disabled:opacity-30"
                    >
                      <ChevronUp size={16} color={MUTED} />
                    </button>
                    <button
                      onClick={() => onMovePin(id, 1)}
                      disabled={i === pins.length - 1}
                      aria-label={`Move ${f.label} down`}
                      className="p-1.5 disabled:opacity-30"
                    >
                      <ChevronDown size={16} color={MUTED} />
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
        {feedGroups().map((g) => (
          <section key={g.id} className="mb-4">
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
              {g.label}
            </h4>
            <div className="grid grid-cols-2 gap-3">
              {g.feeds.map((f) => {
                const fixed = FIXED_ROW.includes(f.id);
                const pinned = fixed || pins.includes(f.id);
                const on = f.id === current;
                return (
                  <div
                    key={f.id}
                    className="relative rounded-2xl p-3"
                    style={{
                      background: on ? alpha(f.color, 0.12) : '#0d0d0f',
                      border: `1px solid ${on ? f.color : alpha(f.color, 0.3)}`,
                    }}
                  >
                    <button onClick={() => onPick(f.id)} className="flex w-full flex-col items-start gap-2 text-left">
                      <IconTile icon={feedIcon(f.id)} color={f.color} on={on} size={40} />
                      <span className="text-sm font-bold" style={{ color: f.color }}>
                        {f.label}
                      </span>
                      <span className="text-[11px] leading-snug" style={{ color: MUTED }}>
                        {f.hint}
                      </span>
                    </button>
                    {!fixed && (
                      <button
                        onClick={() => onTogglePin(f.id)}
                        aria-label={pinned ? `Unpin ${f.label}` : `Pin ${f.label}`}
                        aria-pressed={pinned}
                        className="absolute right-2 top-2 flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-bold"
                        style={{
                          background: pinned ? GOLD : 'transparent',
                          color: pinned ? INK : MUTED,
                          border: `1px solid ${pinned ? GOLD : alpha(MUTED, 0.5)}`,
                        }}
                      >
                        <Pin size={12} color={pinned ? INK : MUTED} fill={pinned ? INK : 'none'} />
                        {pinned ? 'Pinned' : 'Pin'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
};
