import { createPortal } from 'react-dom';
import { CornerUpLeft, MoreHorizontal, Share2, X } from 'lucide-react';
import type { ReplyRef } from './api';
import { mentionParts, QUICK_REACTIONS } from './social';

/**
 * The pieces of a Facebook / WhatsApp-style bubble (chat/social.ts has the rules): reply quote,
 * $mention chips, reaction chips, the long-press reaction bar, typing row, reply preview and the
 * mention picker. Styling matches ChatPage (gold on near-black).
 */
const GOLD = '#FFD24D';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

export const ReplyQuote = ({ reply, mine, onTap }: { reply: ReplyRef; mine: boolean; onTap?: () => void }) => (
  <button
    type="button"
    onClick={onTap}
    className="block w-full text-left mb-1 px-2 py-1 rounded-lg text-[12px] leading-snug"
    style={{
      background: mine ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)',
      borderLeft: `3px solid ${mine ? '#5c4800' : GOLD}`,
      color: mine ? '#3d3000' : '#c9c3ad',
    }}
  >
    {reply.author && <div className="font-semibold">${reply.author}</div>}
    <div className="line-clamp-2 break-words">{reply.snippet || 'Message'}</div>
  </button>
);

/** Message text with `$handle` mentions drawn as chips (me highlighted). */
export const MessageText = ({ body, mine, me }: { body: string; mine: boolean; me: string }) => (
  <span className="whitespace-pre-wrap break-words">
    {mentionParts(body).map((p, i) =>
      p.mention ? (
        <span
          key={i}
          className="font-semibold rounded px-[2px]"
          style={{
            color: mine ? '#3d2a00' : GOLD,
            background: p.mention === me.replace(/^\$/, '').toLowerCase() ? 'rgba(255,210,77,0.22)' : 'transparent',
          }}
        >
          {p.text}
        </span>
      ) : (
        <span key={i}>{p.text}</span>
      ),
    )}
  </span>
);

export const ReactionChips = ({
  list,
  me,
  mine,
  onToggle,
}: {
  list: { emoji: string; handles: string[] }[];
  me: string;
  mine: boolean;
  onToggle: (emoji: string) => void;
}) => {
  const self = me.replace(/^\$/, '').toLowerCase();
  return (
    <div className={`flex flex-wrap gap-1 -mt-[6px] relative z-[1] ${mine ? 'justify-end pr-2' : 'justify-start pl-[44px]'}`}>
      {list.map((r) => {
        const minePick = r.handles.includes(self);
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => onToggle(r.emoji)}
            title={r.handles.map((h) => `$${h}`).join(', ')}
            aria-label={`${r.emoji} ${r.handles.length}${minePick ? ', including you' : ''}`}
            className="h-[22px] px-[7px] rounded-full text-[12px] flex items-center gap-1"
            style={{
              background: minePick ? '#3a300c' : '#1b1c20',
              border: `1px solid ${minePick ? `${GOLD}88` : LINE}`,
              color: '#f2f2f2',
            }}
          >
            <span>{r.emoji}</span>
            {r.handles.length > 1 && <span style={{ color: MUTED }}>{r.handles.length}</span>}
          </button>
        );
      })}
    </div>
  );
};

/** Long-press: a row of emoji + Reply (+ Share to room for a private $b answer) + More. */
export const ReactionBar = ({
  preview,
  onReact,
  onReply,
  onShare,
  onMore,
  onClose,
}: {
  preview: string;
  onReact: ((emoji: string) => void) | null;
  onReply: (() => void) | null;
  onShare: (() => void) | null;
  onMore: (() => void) | null;
  onClose: () => void;
}) =>
  createPortal(
    <div
      className="fixed inset-0 z-[160] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
      role="dialog"
      aria-label="Message actions"
    >
      <div
        className="w-full max-w-md rounded-t-3xl px-4 pt-4"
        style={{ background: '#0d0e10', borderTop: `1px solid ${LINE}`, paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs mb-3 line-clamp-2" style={{ color: MUTED }}>
          {preview}
        </p>
        {onReact && (
          <div className="flex justify-between mb-3 rounded-full px-2 py-1" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
            {QUICK_REACTIONS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => onReact(e)}
                aria-label={`React ${e}`}
                className="text-[26px] w-11 h-11 rounded-full active:scale-125 transition-transform"
              >
                {e}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-2">
          {onReply && (
            <Row onClick={onReply} icon={<CornerUpLeft size={16} />} label="Reply" />
          )}
          {onShare && <Row onClick={onShare} icon={<Share2 size={16} />} label="Share to room" gold />}
          {onMore && <Row onClick={onMore} icon={<MoreHorizontal size={16} />} label="Report, block…" />}
        </div>
      </div>
    </div>,
    document.body,
  );

const Row = ({ onClick, icon, label, gold }: { onClick: () => void; icon: React.ReactNode; label: string; gold?: boolean }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full rounded-xl py-3 px-4 text-sm font-semibold text-left inline-flex items-center gap-3"
    style={{ background: PANEL, color: gold ? GOLD : '#fff' }}
  >
    {icon} {label}
  </button>
);

export const ReplyPreview = ({ reply, onCancel }: { reply: ReplyRef; onCancel: () => void }) => (
  <div className="flex items-center gap-2 px-3 pt-2 shrink-0" style={{ background: '#0b0b0b', borderTop: `1px solid ${LINE}` }}>
    <CornerUpLeft size={16} color={GOLD} />
    <div className="flex-1 min-w-0 pl-2 text-[12px]" style={{ borderLeft: `3px solid ${GOLD}` }}>
      <div className="font-semibold" style={{ color: GOLD }}>
        Replying to {reply.author ? `$${reply.author}` : 'message'}
      </div>
      <div className="truncate" style={{ color: MUTED }}>
        {reply.snippet}
      </div>
    </div>
    <button type="button" onClick={onCancel} aria-label="Cancel reply" className="p-1">
      <X size={18} color={MUTED} />
    </button>
  </div>
);

export const MentionPicker = ({ handles, avatar, onPick }: { handles: string[]; avatar: (h: string) => React.ReactNode; onPick: (h: string) => void }) => (
  <div className="px-3 pt-2 shrink-0 flex flex-col gap-1" style={{ background: '#0b0b0b', borderTop: `1px solid ${LINE}` }}>
    {handles.map((h) => (
      <button
        key={h}
        type="button"
        onClick={() => onPick(h)}
        className="flex items-center gap-2 px-2 py-1 rounded-lg text-left text-[14px] text-white active:opacity-60"
        style={{ background: PANEL }}
      >
        {avatar(h)} ${h}
      </button>
    ))}
  </div>
);

export const TypingRow = ({ label }: { label: string }) =>
  label ? (
    <div className="px-4 pb-1 text-[12px] italic shrink-0 flex items-center gap-2" style={{ color: MUTED }} aria-live="polite">
      <span className="inline-flex gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-[5px] h-[5px] rounded-full animate-pulse"
            style={{ background: MUTED, animationDelay: `${i * 150}ms` }}
          />
        ))}
      </span>
      {label}
    </div>
  ) : null;

