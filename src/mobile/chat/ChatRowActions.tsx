/**
 * Telegram-style chat rows (chat snappy, wave 1): one SwipeRow wrapper for open-room, token-room
 * and DM rows, with the same actions on swipe, long-press, right-click and keyboard (SwipeRow).
 *
 * - Right swipe: Read / Unread, Pin / Unpin (full swipe = Read / Unread).
 * - Left swipe: Mute / Unmute, Archive / Unarchive, Delete (hide locally) or Leave (open rooms only,
 *   where bit-sign has a leave action). Full swipe = Archive.
 * - Archive, Delete, Leave and Mute show an undo toast like bMail (swipe/undo.tsx); Leave is only
 *   sent to the server once the undo window has passed.
 * - Haptic tick on every commit.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  LogOut,
  Mail,
  MailOpen,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { SwipeRow, type SwipeAction } from '../swipe/SwipeRow';
import { showUndo, UNDO_MS } from '../swipe/undo';
import { haptic } from '../swipe/haptics';
import { loadSession } from './api';
import { PushApi } from '../push/register';
import {
  isArchived,
  isMarked,
  isMuted,
  isPinned,
  setArchived,
  setHidden,
  setMarked,
  setMuted,
  setPinned,
  type ListPrefs,
} from './listPrefs';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';

export type ChatRowInfo = {
  key: string;
  /** The room ticker (server calls). */
  ticker: string;
  title: string;
  /** Latest activity (ms): archive / delete remember it so a newer message brings the chat back. */
  at: number;
  unread: number;
};

export type RowCommands = {
  prefs: ListPrefs;
  update: (fn: (p: ListPrefs) => ListPrefs) => void;
  /** Mark read on the server and zero the local count. */
  markRead: (key: string) => void;
  /** Present only where a leave API exists (open rooms). */
  leave?: (key: string) => Promise<void>;
};

/**
 * Mute also turns this room's server push off (and back to the default, Mentions) so muted chats
 * send no push either. Best-effort: no bChat session or push server error leaves only the local mute.
 */
const syncPush = (ticker: string, muted: boolean) => {
  const bearer = loadSession()?.token;
  if (!bearer) return;
  void new PushApi(bearer).putRoomPref(ticker, muted ? 'off' : 'mentions').catch(() => undefined);
};

const rowActions = (row: ChatRowInfo, c: RowCommands, canLeave: boolean) => {
  const { prefs, update } = c;
  const k = row.key;
  const pinned = isPinned(prefs, k);
  const muted = isMuted(prefs, k);
  const archived = isArchived(prefs, k);
  const unread = row.unread > 0 || isMarked(prefs, k);
  const commit = (fn: () => void) => () => {
    haptic('light');
    fn();
  };
  const read: SwipeAction = unread
    ? {
        id: 'read',
        label: 'Read',
        icon: <MailOpen size={16} />,
        color: '#2E6BE6',
        onPress: commit(() => {
          update((p) => setMarked(p, k, false));
          c.markRead(k);
        }),
      }
    : {
        id: 'read',
        label: 'Unread',
        icon: <Mail size={16} />,
        color: '#2E6BE6',
        onPress: commit(() => update((p) => setMarked(p, k, true))),
      };
  const pin: SwipeAction = {
    id: 'pin',
    label: pinned ? 'Unpin' : 'Pin',
    icon: pinned ? <PinOff size={16} /> : <Pin size={16} />,
    color: '#1F8F4E',
    onPress: commit(() => update((p) => setPinned(archived ? setArchived(p, k, false, row.at) : p, k, !pinned))),
  };
  const mute: SwipeAction = {
    id: 'mute',
    label: muted ? 'Unmute' : 'Mute',
    icon: muted ? <Bell size={16} /> : <BellOff size={16} />,
    color: '#6B7280',
    onPress: commit(() => {
      update((p) => setMuted(p, k, !muted));
      syncPush(row.ticker, !muted);
      showUndo(muted ? `Unmuted ${row.title}` : `Muted ${row.title}`, () => {
        update((p) => setMuted(p, k, muted));
        syncPush(row.ticker, muted);
      });
    }),
  };
  const archive: SwipeAction = {
    id: 'archive',
    label: archived ? 'Unarchive' : 'Archive',
    icon: archived ? <ArchiveRestore size={16} /> : <Archive size={16} />,
    color: '#B7791F',
    removes: true,
    onPress: commit(() => {
      update((p) => setArchived(p, k, !archived, row.at));
      showUndo(archived ? `Unarchived ${row.title}` : `Archived ${row.title}`, () =>
        update((p) => {
          const back = setArchived(p, k, archived, row.at);
          return pinned ? setPinned(back, k, true) : back;
        }),
      );
    }),
  };
  const remove: SwipeAction =
    canLeave && c.leave
      ? {
          id: 'delete',
          label: 'Leave',
          icon: <LogOut size={16} />,
          color: '#B42318',
          removes: true,
          onPress: commit(() => {
            update((p) => setHidden(p, k, true, row.at));
            let undone = false;
            const t = window.setTimeout(() => {
              if (!undone) void c.leave?.(k).catch(() => update((p) => setHidden(p, k, false, row.at)));
            }, UNDO_MS);
            showUndo(`Left ${row.title}`, () => {
              undone = true;
              window.clearTimeout(t);
              update((p) => setHidden(p, k, false, row.at));
            });
          }),
        }
      : {
          id: 'delete',
          label: 'Delete',
          icon: <Trash2 size={16} />,
          color: '#B42318',
          removes: true,
          onPress: commit(() => {
            update((p) => setHidden(p, k, true, row.at));
            showUndo(`Removed ${row.title} from the list`, () => update((p) => setHidden(p, k, false, row.at)));
          }),
        };
  return {
    rightActions: [read, pin],
    leftActions: [mute, archive, remove],
    fullSwipeRight: 'read',
    fullSwipeLeft: 'archive',
  };
};

/** A chat row with Telegram swipe + menu actions. `children` is the row face (solid background). */
export const ChatSwipeRow = ({
  row,
  commands,
  canLeave = false,
  children,
}: {
  row: ChatRowInfo;
  commands: RowCommands;
  canLeave?: boolean;
  children: ReactNode;
}) => {
  const a = rowActions(row, commands, canLeave);
  return (
    <SwipeRow label={row.title} rowId={row.key} {...a}>
      {children}
    </SwipeRow>
  );
};

/** Title-side marks: a muted bell. */
export const MutedMark = ({ muted }: { muted: boolean }) =>
  muted ? <BellOff size={13} color={MUTED} className="shrink-0" aria-label="Muted" /> : null;

/**
 * The right-hand badge: the unread count (gold; grey when muted), an empty dot badge when marked
 * unread by hand, or a pin icon for a pinned chat with nothing new. Fixed height: no layout shift.
 */
export const RowBadge = ({
  unread,
  marked,
  muted,
  pinned,
}: {
  unread: number;
  marked: boolean;
  muted: boolean;
  pinned: boolean;
}) => {
  const bg = muted ? '#3a3d44' : GOLD;
  const fg = muted ? '#e5e7eb' : '#1a1300';
  if (unread > 0 || marked)
    return (
      <span
        className="min-w-[20px] h-5 px-[6px] rounded-full text-[11px] font-bold flex items-center justify-center shrink-0"
        style={{ background: bg, color: fg }}
        aria-label={unread > 0 ? `${unread} unread` : 'Marked unread'}
      >
        {unread > 0 ? (unread > 99 ? '99+' : unread) : ''}
      </span>
    );
  if (pinned)
    return (
      <span className="h-5 flex items-center shrink-0" aria-label="Pinned">
        <Pin size={14} color={MUTED} style={{ transform: 'rotate(45deg)' }} />
      </span>
    );
  return null;
};

/** One collapsible "Archived" row at the top of the list (Telegram). */
export const ArchivedGroup = ({
  count,
  unread,
  children,
  identity,
}: {
  count: number;
  unread: number;
  children: ReactNode;
  identity: string;
}) => {
  const storeKey = `bwallet:chat-archived-open:${identity}`;
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(storeKey) === '1';
    } catch {
      return false;
    }
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    try {
      localStorage.setItem(storeKey, open ? '1' : '0');
    } catch {
      /* no storage */
    }
  }, [open, storeKey]);
  if (!count) return null;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          haptic('light');
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
      >
        <span
          className="rounded-full shrink-0 flex items-center justify-center"
          style={{ width: 48, height: 48, background: '#16181c' }}
        >
          <Archive size={20} color={MUTED} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-semibold text-white">Archived</span>
          <span className="block text-[13px]" style={{ color: MUTED }}>
            {count} chat{count === 1 ? '' : 's'}
          </span>
        </span>
        {unread > 0 && <RowBadge unread={unread} marked={false} muted pinned={false} />}
        {open ? <ChevronDown size={16} color={MUTED} /> : <ChevronRight size={16} color={MUTED} />}
      </button>
      {open && <ul className="w-full">{children}</ul>}
    </li>
  );
};
