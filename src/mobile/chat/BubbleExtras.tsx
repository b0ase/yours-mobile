import { useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { CornerUpLeft, MoreHorizontal, Pencil, Share2, X, Copy } from 'lucide-react';
import type { BchatClient, ReplyRef } from './api';
import { mentionParts, QUICK_REACTIONS } from './social';
import { shadeVars, type BubbleShade } from './bubbleShades';
import { bigEmojiCount } from './emoji';
import { linkParts, previewPlan } from './linkify';
import { ChatLink, MessagePreview } from './MessageLinks';

/**
 * The pieces of a Facebook / WhatsApp-style bubble (chat/social.ts has the rules): reply quote,
 * $mention chips, reaction chips, the long-press reaction bar, typing row, reply preview and the
 * mention picker. Styling matches ChatPage (gold on near-black).
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

/** `shade`: the quoted sender's warm shade (chat/bubbleShades.ts), so the bar and name wear their colour. */
export const ReplyQuote = ({
  reply,
  mine,
  onTap,
  shade,
}: {
  reply: ReplyRef;
  mine: boolean;
  onTap?: () => void;
  shade?: BubbleShade;
}) => (
  <button
    type="button"
    onClick={onTap}
    className="block w-full text-left mb-1 px-2 py-1 rounded-lg text-[12px] leading-snug"
    style={{
      ...(shade && !mine ? (shadeVars(shade) as CSSProperties) : {}),
      background: mine ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)',
      borderLeft: `3px solid ${mine ? '#5c4800' : shade ? 'var(--bw-shade-ink)' : GOLD}`,
      color: mine ? '#3d3000' : '#c9c3ad',
    }}
  >
    {reply.author && <div className={`font-semibold${shade && !mine ? ' bw-shade-name' : ''}`}>${reply.author}</div>}
    <div className="line-clamp-2 break-words">{reply.snippet || 'Message'}</div>
  </button>
);

/**
 * Message text with http(s) links as real links (chat/MessageLinks.tsx) and `$handle` mentions drawn as chips (me
 * highlighted). Links first, so a `$` inside a URL is never a mention. A message of only 1–3 emoji is drawn large,
 * in the device's own emoji font.
 */
export const MessageText = ({ body, mine, me }: { body: string; mine: boolean; me: string }) => {
  const big = bigEmojiCount(body);
  const self = me.replace(/^\$/, '').toLowerCase();
  return (
    <span
      className="whitespace-pre-wrap break-words"
      style={big ? { fontSize: big === 1 ? 44 : big === 2 ? 36 : 30, lineHeight: 1.15 } : undefined}
    >
      {linkParts(body).map((l, i) =>
        l.href ? (
          <ChatLink key={i} href={l.href} text={l.text} mine={mine} />
        ) : (
          mentionParts(l.text).map((p, j) =>
            p.mention ? (
              <span
                key={`${i}.${j}`}
                className="font-semibold rounded px-[2px]"
                style={{
                  color: mine ? '#3d2a00' : GOLD,
                  background: p.mention === self ? 'rgb(var(--bw-accent-hi-rgb) / 0.22)' : 'transparent',
                }}
              >
                {p.text}
              </span>
            ) : (
              <span key={`${i}.${j}`}>{p.text}</span>
            ),
          )
        ),
      )}
    </span>
  );
};

/**
 * A text message's body: its text, then the preview under its first link (chat/linkify.ts previewPlan). A message that
 * is only a GIPHY link shows just the GIF; if the GIF won't load, its link shows instead.
 */
export const MessageBody = ({
  body,
  mine,
  me,
  encrypted,
  client,
}: {
  body: string;
  mine: boolean;
  me: string;
  /** The room is end-to-end encrypted: no card fetch, GIFs and videos wait for a tap. */
  encrypted: boolean;
  client: Pick<BchatClient, 'unfurl'>;
}) => {
  const [gifFailed, setGifFailed] = useState(false);
  const plan = previewPlan(body, { encrypted });
  const gifOnly = plan.kind === 'gif' && plan.only && !gifFailed;
  return (
    <>
      {!gifOnly && <MessageText body={body} mine={mine} me={me} />}
      {!(plan.kind === 'gif' && gifFailed) && (
        <MessagePreview plan={plan} encrypted={encrypted} client={client} onGifError={() => setGifFailed(true)} />
      )}
    </>
  );
};

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
    <div
      className={`flex flex-wrap gap-1 -mt-[6px] relative z-[1] ${mine ? 'justify-end pr-2' : 'justify-start pl-[44px]'}`}
    >
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
              border: `1px solid ${minePick ? `color-mix(in srgb, ${GOLD} 53%, transparent)` : LINE}`,
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

/** Tap a message: a row of emoji + Reply, Copy text (+ Share to room for a private $b answer), Edit, Report. */
export const ReactionBar = ({
  preview,
  onReact,
  onReply,
  onShare,
  onEdit = null,
  onCopy = null,
  onMore,
  onClose,
}: {
  preview: string;
  onReact: ((emoji: string) => void) | null;
  onReply: (() => void) | null;
  onShare: (() => void) | null;
  /** Your own sent text message: edit it in place. */
  onEdit?: (() => void) | null;
  /** Copy the message text (hold is reply now, so text isn't selected by holding). */
  onCopy?: (() => void) | null;
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
        style={{
          background: '#0d0e10',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs mb-3 line-clamp-2" style={{ color: MUTED }}>
          {preview}
        </p>
        {onReact && (
          <div
            className="flex justify-between mb-3 rounded-full px-2 py-1"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
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
          {onReply && <Row onClick={onReply} icon={<CornerUpLeft size={16} />} label="Reply" />}
          {onCopy && <Row onClick={onCopy} icon={<Copy size={16} />} label="Copy text" />}
          {onShare && <Row onClick={onShare} icon={<Share2 size={16} />} label="Share to room" gold />}
          {onEdit && <Row onClick={onEdit} icon={<Pencil size={16} />} label="Edit" />}
          {onMore && <Row onClick={onMore} icon={<MoreHorizontal size={16} />} label="Report, block…" />}
        </div>
      </div>
    </div>,
    document.body,
  );

const Row = ({
  onClick,
  icon,
  label,
  gold,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  gold?: boolean;
}) => (
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
  <div
    className="flex items-center gap-2 px-3 pt-2 shrink-0"
    style={{ background: '#0b0b0b', borderTop: `1px solid ${LINE}` }}
  >
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

export const MentionPicker = ({
  handles,
  avatar,
  onPick,
}: {
  handles: string[];
  avatar: (h: string) => React.ReactNode;
  onPick: (h: string) => void;
}) => (
  <div
    className="px-3 pt-2 shrink-0 flex flex-col gap-1"
    style={{ background: '#0b0b0b', borderTop: `1px solid ${LINE}` }}
  >
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
    <div
      className="px-4 pb-1 text-[12px] italic shrink-0 flex items-center gap-2"
      style={{ color: MUTED }}
      aria-live="polite"
    >
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
