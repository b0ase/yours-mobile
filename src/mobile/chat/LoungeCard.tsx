import { useEffect, useState } from 'react';
import { PinOff } from 'lucide-react';
import type { BchatClient } from './api';
import type { ChatRoom } from './messages';
import { audienceCount, parseSpaceState } from '../spaces/model';
import { HELP_DESK_NAME, loungeCardInfo, LOUNGE_TICKER } from './loungeInfo';
import { useLive } from './live';

/**
 * The bWallet Help Desk (ticker LOUNGE; was the bWallet Lounge) as a yellow card pinned above every
 * other chat (owner, 10 Oct 2026). Not a list row and can't be archived; the pin icon unpins it on this
 * device only (helpDeskPin.ts), after which it's an ordinary row until pinned again. Shows the last message, unread count and, while its always-open Space is
 * live, "Live · N listening" with Join (tap Join → the Space; tap the card → the room).
 */
const INK = '#0B0A08';
const POLL_MS = 20_000;

export const LoungeCard = ({
  client,
  room,
  me,
  preview,
  onOpen,
  onJoin,
  onUnpin,
}: {
  client: BchatClient;
  /** The Lounge row from the rooms list, or null when this account isn't a member yet. */
  room: ChatRoom | null;
  me: string;
  /** The last message, as the list would show it. */
  preview: string;
  onOpen: () => void;
  onJoin: () => void;
  /** Unpin on this device: the card goes and the room becomes an ordinary row. */
  onUnpin?: () => void;
}) => {
  const [listening, setListening] = useState<number | null>(null);
  const [bump, setBump] = useState(0);
  // Live (chat/live.ts): a Lounge room/member change re-reads the Space; 5 min poll while live.
  const pollMs = useLive(() => setBump((n) => n + 1), POLL_MS, {
    liveMs: 300_000,
    types: ['room.update', 'member.join', 'member.leave', 'member.update'],
    room: LOUNGE_TICKER,
  });

  useEffect(() => {
    let live = true;
    const load = () =>
      client
        .space(LOUNGE_TICKER)
        .then((d) => {
          if (!live) return;
          const st = parseSpaceState(d, me);
          // A space in the reply means it's live now; the audience is everyone not on stage.
          setListening(st.space ? audienceCount(st) : null);
        })
        .catch(() => undefined);
    void load();
    const id = setInterval(load, pollMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [client, me, pollMs, bump]);

  const info = loungeCardInfo({ unread: room?.unread ?? 0, listening, preview, member: !!room });

  return (
    <div className="px-3 pt-2 pb-1">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open the ${HELP_DESK_NAME}`}
        onClick={onOpen}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
        className="w-full flex items-center gap-3 rounded-2xl px-4 py-3 text-left cursor-pointer active:opacity-90"
        style={{ background: '#F5C542', color: INK, boxShadow: '0 6px 24px rgba(245,197,66,0.18)' }}
      >
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          style={{ background: INK }}
          aria-hidden="true"
        >
          <svg viewBox="23 8 74 100" width="22" height="22">
            <mask id="lounge-card-b">
              <rect width="140" height="140" fill="#fff" />
              <circle cx="60" cy="72" r="15" fill="#000" />
            </mask>
            <g fill="#F5C542" mask="url(#lounge-card-b)">
              <polygon points="45,12 45,76 27,76 27,30" />
              <circle cx="60" cy="72" r="33" />
            </g>
          </svg>
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-[16px] font-extrabold truncate">{HELP_DESK_NAME}</span>
            {info.badge && (
              <span
                className="min-w-[20px] h-5 px-[6px] rounded-full text-[11px] font-bold flex items-center justify-center shrink-0"
                style={{ background: INK, color: '#F5C542' }}
              >
                {info.badge}
              </span>
            )}
          </span>
          <span className="block text-[13px] truncate" style={{ color: '#3a2f12' }}>
            {info.line}
          </span>
          {info.live && (
            <span className="mt-1 inline-flex items-center gap-1.5 text-[12px] font-bold">
              <span className="h-2 w-2 rounded-full" style={{ background: '#B42318' }} aria-hidden="true" />
              {info.live}
            </span>
          )}
        </span>
        {info.live && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onJoin();
            }}
            className="shrink-0 rounded-full px-4 py-2 text-[13px] font-bold"
            style={{ background: INK, color: '#F5C542' }}
          >
            Join
          </button>
        )}
        {onUnpin && (
          <button
            type="button"
            aria-label={`Unpin the ${HELP_DESK_NAME}`}
            title="Unpin (this device only)"
            onClick={(e) => {
              e.stopPropagation();
              onUnpin();
            }}
            className="shrink-0 rounded-full p-2"
            style={{ color: INK, opacity: 0.7 }}
          >
            <PinOff size={16} />
          </button>
        )}
      </div>
    </div>
  );
};
