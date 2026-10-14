/**
 * The Feed picker: a fixed row of pinned feed icons plus "All feeds" (a grid where feeds are opened
 * and pinned). No scrolling chips. The open feed is the solid gold icon. See feeds.ts.
 */
import { createPortal } from 'react-dom';
import { LayoutGrid, Pin, Sparkles, Users, X, type LucideIcon } from 'lucide-react';
import { useBackClose } from '../backStack';
import { ALL_FEEDS_ICON, feedIcon, type FeedGlyph, type FeedIcon } from './feedIcons';
import { FEEDS, MAX_PINNED, feedDef, type FeedId } from './feeds';

const GOLD = '#FFD24D';
const INK = '#1a1300';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

const GLYPHS: Record<FeedGlyph, LucideIcon> = { following: Users, foryou: Sparkles, all: LayoutGrid };

/**
 * One feed icon on a black tile: a bApp's own art edge to edge, or a gold glyph. The open feed gets a
 * gold ring and glow (the art is never tinted over).
 */
const IconTile = ({ icon, on, size }: { icon: FeedIcon; on: boolean; size: 44 | 40 }) => {
  const Glyph = icon.kind === 'glyph' ? GLYPHS[icon.glyph] : null;
  return (
    <span
      className="relative flex shrink-0 items-center justify-center overflow-hidden"
      style={{
        width: size,
        height: size,
        borderRadius: size === 44 ? 14 : 12,
        background: '#000',
        boxShadow: on ? `0 0 0 2px ${GOLD}, 0 0 14px rgba(255,210,77,0.45)` : 'inset 0 0 0 1px rgba(255,210,77,0.35)',
      }}
    >
      {icon.kind === 'app' ? (
        <img src={icon.src} alt="" draggable={false} className="h-full w-full object-cover" />
      ) : (
        Glyph && <Glyph size={size === 44 ? 20 : 19} color={GOLD} strokeWidth={on ? 2.4 : 1.9} />
      )}
    </span>
  );
};

const Tile = ({ label, icon, on, onClick }: { label: string; icon: FeedIcon; on: boolean; onClick: () => void }) => (
  <button
    onClick={onClick}
    aria-pressed={on}
    aria-label={label}
    className="flex flex-1 min-w-0 flex-col items-center gap-1 py-1 active:opacity-70"
  >
    <IconTile icon={icon} on={on} size={44} />
    <span
      className="max-w-full truncate text-[11px]"
      style={{ color: on ? GOLD : 'rgba(255,210,77,0.7)', fontWeight: on ? 700 : 500 }}
    >
      {label}
    </span>
  </button>
);

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
}) => (
  <div className="flex items-start gap-1 px-3 pb-2" role="tablist" aria-label="Feeds">
    {pins.map((id) => (
      <Tile key={id} label={feedDef(id).label} icon={feedIcon(id)} on={id === current} onClick={() => onPick(id)} />
    ))}
    <Tile label="All feeds" icon={ALL_FEEDS_ICON} on={allOpen || !pins.includes(current)} onClick={onOpenAll} />
  </div>
);

export const AllFeedsSheet = ({
  pins,
  current,
  onPick,
  onTogglePin,
  onClose,
}: {
  pins: FeedId[];
  current: FeedId;
  onPick: (id: FeedId) => void;
  onTogglePin: (id: FeedId) => void;
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
          Tap a feed to open it. Pin up to {MAX_PINNED} to the top row.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {FEEDS.map((f) => {
            const pinned = pins.includes(f.id);
            const on = f.id === current;
            return (
              <div
                key={f.id}
                className="relative rounded-2xl p-3"
                style={{
                  background: on ? '#1a1408' : '#0d0b05',
                  border: `1px solid ${on ? GOLD : 'rgba(255,210,77,0.25)'}`,
                }}
              >
                <button onClick={() => onPick(f.id)} className="flex w-full flex-col items-start gap-2 text-left">
                  <IconTile icon={feedIcon(f.id)} on={on} size={40} />
                  <span className="text-sm font-bold" style={{ color: GOLD }}>
                    {f.label}
                  </span>
                  <span className="text-[11px] leading-snug" style={{ color: MUTED }}>
                    {f.hint}
                  </span>
                </button>
                <button
                  onClick={() => onTogglePin(f.id)}
                  aria-label={pinned ? `Unpin ${f.label}` : `Pin ${f.label}`}
                  aria-pressed={pinned}
                  className="absolute right-2 top-2 rounded-full p-1.5"
                  style={{ background: pinned ? GOLD : 'transparent' }}
                >
                  <Pin size={14} color={pinned ? INK : GOLD} fill={pinned ? INK : 'none'} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
};
