import { useEffect, useState } from 'react';
import type { BchatClient } from './api';
import type { ChatRoom } from './messages';
import { audienceCount, parseSpaceState } from '../spaces/model';
import { loungeCardInfo, LOUNGE_TICKER } from './loungeInfo';

/**
 * The bWallet Lounge as a yellow card pinned above every other chat (owner, 10 Oct 2026: "I still
 * want the bWallet Lounge to be a yellow card in chat, pinned to the top"). Not a list row: it can't
 * be unpinned or archived. Shows the last message, unread count and, while its always-open Space is
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
}: {
  client: BchatClient;
  /** The Lounge row from the rooms list, or null when this account isn't a member yet. */
  room: ChatRoom | null;
  me: string;
  /** The last message, as the list would show it. */
  preview: string;
  onOpen: () => void;
  onJoin: () => void;
}) => {
  const [listening, setListening] = useState<number | null>(null);

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
    const id = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [client, me]);

  const info = loungeCardInfo({ unread: room?.unread ?? 0, listening, preview, member: !!room });

  return (
    <div className="px-3 pt-2 pb-1">
      <div
        role="button"
        tabIndex={0}
        aria-label="Open the bWallet Lounge"
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
            <span className="text-[16px] font-extrabold truncate">bWallet Lounge</span>
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
      </div>
    </div>
  );
};
