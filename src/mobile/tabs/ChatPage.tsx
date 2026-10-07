import { IssuerBadge } from '../issuer/IssuerBadge';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBackClose } from '../backStack';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowUp,
  Coins,
  Info,
  Lock,
  Plus,
  ShieldCheck,
  MessageCircle,
  Search,
  Settings,
  ShoppingCart,
  Trophy,
  UserPlus,
  WifiOff,
  X,
} from 'lucide-react';
import { sendBsv, sendBsv21 } from '@1sat/actions';
import { TopNav } from '../../components/TopNav';
import { useInPeek } from '../phone/pageEl';
import { readListCache, writeListCache } from '../ui/listCache';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { BchatClient, ChatApiError, defaultHttp, loadSession, saveSession } from '../chat/api';
import { avatarFor, B_AVATAR, pendingBQuestions, useAvatars } from '../chat/avatars';
import { walletSigner } from '../chat/signer';
import { proveHoldings, walletHoldings } from '../chat/holdings';
import { onTokenNav, requestMarketToken, takeChatRoom } from '../chat/nav';
import { onRoomTicker, takeRoomTicker } from '../chat/segmentNav';
import { RoomBell } from '../push/RoomBell';
import { APP_NAME, MARKET_ENABLED, STORE_ROOM_NOTE, marketLabel, tokenRoomsEnabled } from '../storeBuild';

/** Store build: token rooms are listed but never opened, joined or bought into (storeBuild.ts). */
const ROOMS = tokenRoomsEnabled();
import {
  amountLabel,
  buildTokenRoomList,
  holdLine,
  parseGateRefusal,
  parseInvitee,
  parseLookup,
  parseTokenKey,
  personalOfRoom,
  type GateRefusal,
  type Holding,
  type TokenGate,
  type TokenRoomEntry,
  type TokenRoomLookup,
} from '../chat/tokenRooms';
import { addToInviteList, inviteLine, inviteState, loadInviteList } from '../chat/invites';
import { knownPersonal, rememberPersonal, tickerLabel } from '../names/personalToken';
import { retryPersonalRoom } from '../names/claimPersonal';
import { ownTokens, recheckPendingIndexing } from '../tokens/pendingIndexing';
import { setupLabel, useRoomSetup } from '../tokens/useRoomSetup';
import type { OwnToken } from '../tokens/indexFund';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getErrorMessage } from '../../utils/tools';
import { asMenuItem, TAB_TAP } from './tabs';
import { useRoomIcon } from '../chat/roomIcon';
import { ChatTabs, SegmentRow, SegmentTitle } from '../feed/ChatSegments';
import { useChatDisplayName } from '../feed/chatDisplayName';
import {
  avatarHue,
  latestCursor,
  listTimeLabel,
  mergeMessages,
  oldestCursor,
  previewText,
  roomInitial,
  roomTitle,
  threadItems,
  timeLabel,
  type ChatMessage,
  type ChatRoom,
} from '../chat/messages';
import {
  claimCheck,
  loadSeen,
  markSeen,
  parseBounties,
  parseSpec,
  rewardLabel,
  saveSeen,
  showPay,
  sortBounties,
  transferLabel,
  unseenForMe,
  type Bounty,
  type PayoutSpec,
} from '../chat/bounties';
import { PullToRefresh } from '../ui/PullToRefresh';
import { DmsPage, type DmConversationProps } from '../chat/DmsPage';
import { UserSafetyButton } from '../ugc/UserSafety';
import { setBlocked, syncBlocks } from '../ugc/blocks';
import { blockedHandles, onUgcChange } from '../ugc/ugc';
import {
  browseList,
  byActivity,
  isOpenRoom,
  isStaff,
  openInfo,
  parsePublicRooms,
  withoutBlocked,
  type PublicRoom,
} from '../chat/openRooms';
import { MessageMenu, NewRoomSheet, OpenRoomSheet } from '../chat/OpenRoomSheets';
import { longPress, useRoomCard } from '../chat/roomCard';
import { RoomSettingsSheet } from '../chat/RoomSettingsSheet';
import { celebrateSend } from '../../components/sent/sent';

/**
 * Chat › Chatrooms: open rooms (no token, every build) + token rooms (docs/TOKEN-ROOMS.md); 1:1 DMs + contacts live in the DMs
 * segment (chat/DmsPage.tsx, owner reversal of the earlier no-DMs rule). The list is one room per
 * BSV-21 token / 1Sat collection this wallet holds at or above the room minimum — buy a token
 * and its room appears; sell it and the room goes.
 * Rooms list → conversation → back, all inside this tab; the conversation covers the bottom bar.
 * Talks to bitcoinchat.online's API with a session the wallet gets by signing
 * bChat's wallet-login challenge (../chat/api.ts). Live updates by polling
 * (4s in an open conversation, 30s on the list) until realtime lands in v2.
 */
const GOLD = '#FFD24D';
const BG = '#010101';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const LIST_POLL_MS = 30_000;
const THREAD_POLL_MS = 4_000;
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

const useOnline = () => {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
};

/** Runs `fn` every `ms` while the page is visible. */
const usePoll = (fn: () => void, ms: number, enabled: boolean) => {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => document.visibilityState === 'visible' && ref.current();
    const id = window.setInterval(tick, ms);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [ms, enabled]);
};

const Avatar = ({
  title,
  size = 48,
  roomKey,
  src,
}: {
  title: string;
  size?: number;
  roomKey?: string | null;
  /** A picture to use as is: a room's metadata.icon, a person's avatar. */
  src?: string | null;
}) => {
  const hue = avatarHue(title);
  // Token / collection rooms show the token's icon; letter tile when there is none or it fails.
  const tokenIcon = useRoomIcon(src ? null : roomKey);
  const icon = src || tokenIcon;
  const [broken, setBroken] = useState<string | null>(null);
  if (icon && broken !== icon)
    return (
      <img
        src={icon}
        alt=""
        onError={() => setBroken(icon)}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size, background: '#16181c' }}
      />
    );
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        color: `hsl(${hue} 70% 82%)`,
        background: `linear-gradient(145deg, hsl(${hue} 35% 26%), hsl(${hue} 30% 14%))`,
        border: `1px solid hsl(${hue} 30% 30% / 0.6)`,
      }}
    >
      {roomInitial(title)}
    </div>
  );
};

/** A room's own picture (metadata.icon, https only), e.g. the bWallet Lounge's (owner, 6 Oct 2026). */
const roomIcon = (room: ChatRoom): string | null => {
  const icon = (room.metadata as { icon?: unknown } | null | undefined)?.icon;
  return typeof icon === 'string' && /^https:\/\//.test(icon) ? icon : null;
};
/** Official rooms (metadata.open.official) show how to ask $b. */
const isOfficialRoom = (room: ChatRoom) =>
  Boolean((room.metadata as { open?: { official?: boolean } } | null | undefined)?.open?.official);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────────── Conversation ─────────────────────────────

const Conversation = ({
  client,
  room,
  me,
  online,
  onBack,
  onAuthLost,
  entry,
  onLocked,
  onInvite,
  onBans,
  onBounties,
  peer = null,
  openRoom = null,
  hidden,
  onMessageMenu = null,
  bell = true,
}: {
  client: BchatClient;
  room: ChatRoom;
  me: string;
  online: boolean;
  onBack: () => void;
  onAuthLost: () => void;
  entry: TokenRoomEntry | null;
  /** The server refused: you no longer hold enough (or never did). */
  onLocked: (refusal: GateRefusal) => void;
  onInvite: (() => void) | null;
  /** Room admin: the ban list. */
  onBans: (() => void) | null;
  /** Null hides the Bounties button (1:1 DMs). */
  onBounties: (() => void) | null;
  /** A 1:1's other person: shows Report / Block (Apple 1.2). */
  peer?: string | null;
  /** Open rooms (no token): the info button, and read-only once closed. */
  openRoom?: { closed: boolean; visibility: 'public' | 'invite'; onInfo: () => void } | null;
  /** Message ids removed by a moderator in this session. */
  hidden?: ReadonlySet<string>;
  /** Long-press a message: report / block / delete. */
  onMessageMenu?: ((m: ChatMessage) => void) | null;
  /** Push bell (All / Mentions / Off). Off for DMs, which always notify. */
  bell?: boolean;
}) => {
  const bountyBadge = useBountyBadge(client, room.ticker, me);
  const title = entryTitle(entry, room) ?? roomTitle(room, me);
  useBackClose(true, onBack);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const prependAnchor = useRef<number | null>(null);
  const localSeq = useRef(0);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ChatApiError && e.status === 401) return onAuthLost();
      const refusal = e instanceof ChatApiError && e.status === 403 ? parseGateRefusal(e.data) : null;
      if (refusal) return onLocked(refusal);
      setError(errText(e));
    },
    [onAuthLost, onLocked],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    client
      .latestPage(room.ticker)
      .then((p) => {
        if (!live) return;
        setMessages(mergeMessages([], p.messages));
        setHasMore(p.hasMore);
        setError('');
        void client.markRead(room.ticker).catch(() => {});
      })
      .catch((e) => live && fail(e))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [client, room.ticker, fail]);

  const poll = useCallback(() => {
    const cursor = latestCursor(messages);
    if (!cursor || !online) return;
    client
      .since(room.ticker, cursor)
      .then((fresh) => {
        if (!fresh.length) return;
        setMessages((cur) => mergeMessages(cur, fresh));
        void client.markRead(room.ticker).catch(() => {});
      })
      .catch(() => {});
  }, [client, room.ticker, messages, online]);
  usePoll(poll, THREAD_POLL_MS, !loading);

  const loadOlder = useCallback(() => {
    const before = oldestCursor(messages);
    if (!before || !hasMore || loadingOlder) return;
    setLoadingOlder(true);
    prependAnchor.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null;
    client
      .page(room.ticker, { before })
      .then((p) => {
        setMessages((cur) => mergeMessages(cur, p.messages));
        setHasMore(p.hasMore);
      })
      .catch(fail)
      .finally(() => setLoadingOlder(false));
  }, [client, room.ticker, messages, hasMore, loadingOlder, fail]);

  // Keep position when older messages are prepended; otherwise follow the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prependAnchor.current !== null) {
      el.scrollTop = el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120) loadOlder();
  };

  const send = (text: string, existing?: ChatMessage) => {
    const body = text.trim();
    if (!body) return;
    const localId = existing?.localId ?? `l${Date.now()}-${++localSeq.current}`;
    const optimistic: ChatMessage = {
      id: `local:${localId}`,
      localId,
      author_handle: me,
      kind: 'text',
      body,
      created_at: new Date().toISOString(),
      pending: true,
    };
    stickToBottom.current = true;
    setMessages((cur) => cur.filter((m) => m.localId !== localId).concat(optimistic));
    if (!existing) setDraft('');
    client
      .send(room.ticker, body)
      .then((saved) => setMessages((cur) => (saved ? mergeMessages(cur, [saved]) : cur)))
      .catch((e) => {
        setMessages((cur) => cur.map((m) => (m.localId === localId ? { ...m, failed: true } : m)));
        if (e instanceof ChatApiError && e.status === 401) onAuthLost();
        const refusal = e instanceof ChatApiError && e.status === 403 ? parseGateRefusal(e.data) : null;
        if (refusal) onLocked(refusal);
      });
  };

  // Blocked people's messages are hidden here (ugc/ugc.ts, synced with bit-sign's
  // bchat_user_blocks); re-filter when the block list changes.
  const [blockTick, setBlockTick] = useState(0);
  useEffect(() => onUgcChange(() => setBlockTick((n) => n + 1)), []);
  const items = useMemo(() => {
    const shown = withoutBlocked(messages, new Set(blockedHandles()));
    return threadItems(hidden?.size ? shown.filter((m) => !hidden.has(m.id)) : shown, me);
  }, [messages, me, hidden, blockTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const direct = false;
  const members = room.party_count ?? entry?.members ?? 0;
  // Bubble avatars (chat/avatars.ts) and "$b is thinking…" under /b questions not yet answered.
  useAvatars(
    client,
    messages.map((m) => m.author_handle),
  );
  const waitingForB = pendingBQuestions(messages);
  const composer = useRef<HTMLTextAreaElement>(null);
  const askB = () => {
    setDraft((d) => (/^\/b(\s|$)/i.test(d) ? d : `/b ${d}`));
    requestAnimationFrame(() => composer.current?.focus());
  };

  // Phone layout: Chat stays mounted off to the side (phone/pager.tsx); the open room hides with it.
  const offScreen = useInPeek();
  // Sits between TopNav (3.5rem) and the tab bar (3.75rem) so both stay usable; sheets (z-[150]) still clear it.
  return createPortal(
    <div
      className="fixed left-0 right-0 z-[110] flex flex-col"
      style={{
        display: offScreen ? 'none' : undefined,
        top: 'calc(var(--wallet-inset-top, 0px) + 3.5rem)',
        bottom: 'calc(env(safe-area-inset-bottom) + var(--dock-h, 3.75rem))',
        background: BG,
      }}
    >
      <div
        className="flex items-center gap-3 px-2 pb-2 shrink-0"
        style={{
          paddingTop: 8,
          background: 'linear-gradient(180deg, #16140c 0%, #0b0b0b 100%)',
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <button onClick={onBack} className="p-2 rounded-full active:opacity-60" aria-label="Back">
          <ArrowLeft size={22} color={GOLD} />
        </button>
        <Avatar title={title} size={38} roomKey={entry?.key} src={roomIcon(room)} />
        <div className="flex-1 min-w-0">
          <div className={`text-[15px] font-semibold text-white ${ELLIPSIS}`}>{title}</div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            {!online
              ? 'waiting for network…'
              : entry
                ? `${entry.gate.key.startsWith('coll:') ? entry.gate.symbol : `$${entry.gate.symbol}`} · ${members} holder${members === 1 ? '' : 's'} · you hold ${amountLabel(entry.holding.amountRaw, entry.gate)}`
                : openRoom
                  ? `${members} member${members === 1 ? '' : 's'} · ${openRoom.visibility === 'public' ? 'Public' : 'Invite only'}${openRoom.closed ? ' · Closed' : ''}`
                  : `${members} member${members === 1 ? '' : 's'} · $${room.ticker}`}
          </div>
          {entry && entry.key.startsWith('bsv21:') && <IssuerBadge tokenId={entry.holding.id} compact />}
        </div>
        {peer && <UserSafetyButton client={client} handle={peer} onBlocked={onBack} />}
        {bell && <RoomBell ticker={room.ticker} />}
        {openRoom && (
          <button onClick={openRoom.onInfo} className="p-2 rounded-full active:opacity-60" aria-label="Room info">
            <Info size={20} color={GOLD} />
          </button>
        )}
        {onBans && (
          <button onClick={onBans} className="p-2 rounded-full active:opacity-60" aria-label="Room settings">
            <Settings size={18} color={MUTED} />
          </button>
        )}
        {onBounties && (
          <button onClick={onBounties} className="relative p-2 rounded-full active:opacity-60" aria-label="Bounties">
            <Trophy size={20} color={GOLD} />
            {bountyBadge > 0 && (
              <span
                className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold flex items-center justify-center"
                style={{ background: '#F97066', color: '#fff' }}
              >
                {bountyBadge}
              </span>
            )}
          </button>
        )}
        {onInvite && (
          <button onClick={onInvite} className="p-2 rounded-full active:opacity-60" aria-label="Invite">
            <UserPlus size={20} color={GOLD} />
          </button>
        )}
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-2"
        style={{ background: 'radial-gradient(120% 60% at 50% 0%, #15130b 0%, #050505 60%)' }}
      >
        {loadingOlder && (
          <div className="text-center text-[11px] py-2" style={{ color: MUTED }}>
            Loading earlier messages…
          </div>
        )}
        {hasMore === false && messages.length > 0 && (
          <div className="text-center text-[11px] py-2" style={{ color: MUTED }}>
            Beginning of conversation
          </div>
        )}
        {loading && (
          <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
            Loading…
          </div>
        )}
        {!loading && error && (
          <div className="text-center text-xs pt-10 text-[#F97066]">
            {error}
            <div>
              <button onClick={onBack} className="mt-3 underline" style={{ color: GOLD }}>
                Back to chats
              </button>
            </div>
          </div>
        )}
        {!loading && !error && messages.length === 0 && (
          <div className="text-center text-xs pt-16" style={{ color: MUTED }}>
            No messages yet. Start the first scene.
          </div>
        )}
        {items.map((it) =>
          it.type === 'day' ? (
            <div key={it.key} className="flex justify-center my-3">
              <span className="text-[11px] px-3 py-1 rounded-full" style={{ background: '#1a1a1a', color: '#c9c3ad' }}>
                {it.label}
              </span>
            </div>
          ) : it.message.kind === 'event' ? (
            <div key={it.key} className="flex justify-center my-2">
              <span
                className="text-[11px] px-3 py-1 rounded-xl text-center max-w-[85%]"
                style={{ background: '#141414', color: MUTED }}
              >
                {it.message.body || 'Room update'}
              </span>
            </div>
          ) : (
            <Fragment key={it.key}>
              <div
                className={`flex items-end gap-2 ${it.mine ? 'justify-end' : 'justify-start'} ${it.firstOfGroup ? 'mt-2' : 'mt-[3px]'}`}
              >
                {/* Avatars on other people's messages, on the first of a run; a spacer keeps the run aligned. */}
                {!it.mine &&
                  (it.firstOfGroup ? (
                    <Avatar
                      title={it.message.author_handle || '?'}
                      size={28}
                      src={avatarFor(it.message.author_handle)}
                    />
                  ) : (
                    <div className="shrink-0" style={{ width: 28 }} />
                  ))}
                <div
                  {...(onMessageMenu && !it.message.pending ? longPress(() => onMessageMenu(it.message)) : {})}
                  className="max-w-[80%] px-3 py-[7px] text-[15px] leading-snug"
                  style={{
                    borderRadius: 18,
                    borderBottomRightRadius: it.mine ? 6 : 18,
                    borderBottomLeftRadius: it.mine ? 18 : 6,
                    background: it.mine ? 'linear-gradient(160deg, #FFD24D 0%, #E9B21A 100%)' : PANEL,
                    color: it.mine ? '#1a1300' : '#f2f2f2',
                    border: it.mine ? 'none' : `1px solid ${LINE}`,
                    opacity: it.message.pending && !it.message.failed ? 0.75 : 1,
                  }}
                >
                  {!it.mine && !direct && it.firstOfGroup && it.message.author_handle && (
                    <div
                      className="text-[12px] font-semibold mb-[2px]"
                      style={{ color: `hsl(${avatarHue(it.message.author_handle)} 70% 72%)` }}
                    >
                      ${it.message.author_handle}
                    </div>
                  )}
                  <span className="whitespace-pre-wrap break-words">{it.message.body}</span>
                  <span
                    className="text-[10px] ml-2 float-right mt-[6px]"
                    style={{ color: it.mine ? '#5c4800' : MUTED }}
                  >
                    {it.message.edited ? 'edited · ' : ''}
                    {it.message.failed ? (
                      <button
                        className="underline text-[#b42318]"
                        onClick={() => send(it.message.body || '', it.message)}
                      >
                        failed · retry
                      </button>
                    ) : it.message.pending ? (
                      'sending…'
                    ) : (
                      timeLabel(it.message.created_at)
                    )}
                  </span>
                </div>
              </div>
              {waitingForB.has(it.message.id) && (
                <div className="flex items-end gap-2 justify-start mt-2" aria-live="polite">
                  <Avatar title="b" size={28} src={B_AVATAR} />
                  <div
                    className="px-3 py-[7px] text-[14px] italic"
                    style={{
                      borderRadius: 18,
                      borderBottomLeftRadius: 6,
                      background: PANEL,
                      color: MUTED,
                      border: `1px solid ${LINE}`,
                    }}
                  >
                    $b is thinking…
                  </div>
                </div>
              )}
            </Fragment>
          ),
        )}
      </div>

      {openRoom?.closed ? (
        <div
          className="px-4 pt-3 text-center text-xs shrink-0"
          style={{
            paddingBottom: 12,
            background: '#0b0b0b',
            color: MUTED,
            borderTop: `1px solid ${LINE}`,
          }}
        >
          This room is closed. You can read it, but no one can post.
        </div>
      ) : (
        <>
          {isOfficialRoom(room) && (
            <div
              className="px-4 pt-2 text-[12px] shrink-0"
              style={{ background: '#0b0b0b', color: MUTED, borderTop: `1px solid ${LINE}` }}
            >
              {/* Two lines (owner, 6 Oct 2026). */}
              <div>
                Questions? Tap <b style={{ color: GOLD }}>/b</b> and ask $b, the {APP_NAME} assistant.
              </div>
              <div>Just /b shows what it can do.</div>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
            className="flex items-end gap-2 px-3 pt-2 shrink-0"
            style={{
              paddingBottom: 8,
              background: '#0b0b0b',
              borderTop: `1px solid ${LINE}`,
            }}
          >
            {/* v2 hook: attachment / voice note / video note buttons go here (rooms/[ticker]/media). */}
            <button
              type="button"
              onClick={askB}
              aria-label={`Ask $b, the ${APP_NAME} assistant`}
              className="h-10 px-3 rounded-full flex items-center justify-center shrink-0 font-bold text-[14px]"
              style={{ background: '#1a1608', color: GOLD, border: `1px solid ${GOLD}55` }}
            >
              /b
            </button>
            <textarea
              ref={composer}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !isNative) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              rows={1}
              maxLength={4000}
              placeholder={online ? 'Message' : 'Offline'}
              className="flex-1 resize-none rounded-2xl px-4 py-[9px] text-[15px] text-white outline-none max-h-32"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="Send"
              className="h-10 w-10 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
              style={{ background: GOLD }}
            >
              <ArrowUp size={20} color="#1a1300" strokeWidth={2.6} />
            </button>
          </form>
        </>
      )}
    </div>,
    document.body,
  );
};

// ───────────────────────────── Sheets ─────────────────────────────

const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  useBackClose(true, onClose);
  // Portal to body + z above BottomMenu (z-[100]): sheets must also clear the room view (z-[110]).
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold">{title}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

/** A room you can't enter: "Hold 1 $FILM to join" + Buy in Market. */
const LockedRoom = ({
  gate,
  heldRaw,
  members,
  onBuy,
  onClose,
}: {
  gate: TokenGate;
  heldRaw: string | null;
  members: number | null;
  onBuy: () => void;
  onClose: () => void;
}) => (
  <Sheet title={gate.key.startsWith('coll:') ? gate.symbol : `$${gate.symbol} room`} onClose={onClose}>
    <div className="flex flex-col items-center text-center gap-2 pb-2">
      <div
        className="h-14 w-14 rounded-2xl flex items-center justify-center"
        style={{ background: '#1a1408', border: '1px solid #3a2f0c' }}
      >
        <Lock size={24} color={GOLD} />
      </div>
      <p className="text-base font-bold text-white">{holdLine(gate)}</p>
      <p className="text-xs" style={{ color: MUTED }}>
        {members !== null ? `${members} holder${members === 1 ? '' : 's'} in this room. ` : ''}
        {heldRaw && heldRaw !== '0'
          ? `You hold ${amountLabel(heldRaw, gate)}.`
          : 'Holding the token is your membership.'}
      </p>
      {MARKET_ENABLED && ROOMS && (
        <button
          onClick={onBuy}
          className="mt-2 w-full rounded-2xl py-3 font-bold flex items-center justify-center gap-2"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          <ShoppingCart size={16} /> Buy in Market
        </button>
      )}
    </div>
  </Sheet>
);

/**
 * Invite = send the room token. Resolves $handle → their proven receive address (bit-sign), then
 * asks the wallet to send exactly the room minimum. Nothing is sent until the user confirms here,
 * and the wallet's own approval for the transaction still applies.
 */
const InviteSheet = ({
  client,
  ticker,
  entry,
  onClose,
}: {
  client: BchatClient;
  ticker: string;
  entry: TokenRoomEntry;
  onClose: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<{ label: string; address: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const amount = amountLabel(entry.gate.minRaw, entry.gate);

  const resolve = async () => {
    const who = parseInvitee(input);
    if (!who) return setError('Enter a $handle or a BSV address');
    setError('');
    if ('address' in who) return setTarget({ label: `${who.address.slice(0, 8)}…`, address: who.address });
    setBusy('Looking up…');
    try {
      const address = await client.inviteAddress(ticker, who.handle);
      setTarget({ label: `$${who.handle}`, address });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const send = async () => {
    if (!target) return;
    setBusy('Sending…');
    setError('');
    try {
      const res = await sendBsv21.execute(apiContext, {
        tokenId: entry.holding.id,
        recipients: [{ amount: BigInt(entry.gate.minRaw), destination: { address: target.address } }],
      });
      if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
      const shown = celebrateSend(res, {
        amount: { kind: 'token', display: amount, ticker: '' },
        recipients: [target.label],
        title: 'Invite sent!',
      });
      if (!shown) addSnackbar(`Invited ${target.label} — sent ${amount}`, 'success');
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <Sheet title="Invite to this room" onClose={onClose}>
      {!target ? (
        <>
          <p className="text-xs mb-3" style={{ color: MUTED }}>
            An invite is the room token: you send {amount} and they're in.
          </p>
          <div
            className="flex items-center gap-2 rounded-2xl px-3"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && resolve()}
              placeholder="$handle or address"
              autoCapitalize="none"
              autoCorrect="off"
              className="flex-1 bg-transparent py-3 text-white outline-none"
            />
          </div>
          <button
            onClick={resolve}
            disabled={!!busy || !input.trim()}
            className="w-full mt-4 rounded-2xl py-3 font-bold disabled:opacity-50"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy || 'Next'}
          </button>
        </>
      ) : (
        <>
          <div className="rounded-2xl p-4 text-sm" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
            <div className="flex justify-between">
              <span style={{ color: MUTED }}>Send</span>
              <span className="text-white font-semibold">{amount}</span>
            </div>
            <div className="flex justify-between mt-2">
              <span style={{ color: MUTED }}>To</span>
              <span className="text-white font-semibold">{target.label}</span>
            </div>
            <div className="text-[11px] mt-2 break-all" style={{ color: MUTED }}>
              {target.address}
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => setTarget(null)}
              disabled={!!busy}
              className="flex-1 rounded-2xl py-3 font-bold text-white"
              style={{ background: PANEL }}
            >
              Back
            </button>
            <button
              onClick={send}
              disabled={!!busy}
              className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {busy || `Send ${amount}`}
            </button>
          </div>
        </>
      )}
      {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
    </Sheet>
  );
};

/**
 * Room admin: ban a $handle or an address. Membership = holds the token AND not banned; the
 * server enforces it on every read/post, so a banned holder is out on their next request.
 */
const BansSheet = ({ client, ticker, onClose }: { client: BchatClient; ticker: string; onClose: () => void }) => {
  const [bans, setBans] = useState<{ handle: string | null; address: string | null }[] | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    client
      .bans(ticker)
      .then(setBans)
      .catch((e) => setError(errText(e)));
  }, [client, ticker]);
  useEffect(load, [load]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setInput('');
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const who = parseInvitee(input);
  return (
    <Sheet title="Banned from this room" onClose={onClose}>
      <p className="text-xs mb-3" style={{ color: MUTED }}>
        A banned handle or address can't read or post here, even holding the token.
      </p>
      <div
        className="flex items-center gap-2 rounded-2xl px-3"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="$handle or address"
          autoCapitalize="none"
          autoCorrect="off"
          className="flex-1 bg-transparent py-3 text-white outline-none"
        />
      </div>
      <button
        onClick={() => who && act(() => client.ban(ticker, 'address' in who ? who.address : `$${who.handle}`))}
        disabled={busy || !who}
        className="w-full mt-3 rounded-2xl py-3 font-bold disabled:opacity-50"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        Ban
      </button>
      <ul className="mt-3 flex flex-col gap-2">
        {bans?.length === 0 && (
          <li className="text-xs" style={{ color: MUTED }}>
            Nobody is banned.
          </li>
        )}
        {bans?.map((b) => {
          const target = b.handle ? `$${b.handle}` : (b.address ?? '');
          return (
            <li key={target} className="flex items-center justify-between text-sm text-white">
              <span className={ELLIPSIS}>{target}</span>
              <button
                onClick={() => act(() => client.unban(ticker, target))}
                disabled={busy}
                className="text-xs underline"
                style={{ color: GOLD }}
              >
                Unban
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
    </Sheet>
  );
};

// ───────────────────────────── Bounties ─────────────────────────────

/** Count of my bounties that turned merged / paid since I last opened the Bounties sheet. */
const useBountyBadge = (client: BchatClient, ticker: string, me: string) => {
  const [count, setCount] = useState(0);
  const check = useCallback(() => {
    client
      .bounties(ticker)
      .then((d) => setCount(unseenForMe(ticker, parseBounties(d), me, loadSeen()).length))
      .catch(() => undefined);
  }, [client, ticker, me]);
  useEffect(() => {
    check();
    window.addEventListener('bwallet:bounties-seen', check);
    return () => window.removeEventListener('bwallet:bounties-seen', check);
  }, [check]);
  usePoll(check, LIST_POLL_MS, true);
  return count;
};

const STATUS_COLOR: Record<string, string> = {
  open: '#32D583',
  claimed: '#FFD24D',
  merged: '#53B1FD',
  paid: '#8a8f98',
};

/**
 * Bounties sheet: open / claimed / merged / paid, with reward. Claim = paste the PR URL. Pay
 * (room admin / treasury holder) = fetch the server's transfer spec, confirm here, and the wallet
 * sends it with its normal approval; the txid is posted back and the bounty becomes paid.
 */
const BountiesSheet = ({
  client,
  room,
  entry,
  me,
  onClose,
}: {
  client: BchatClient;
  room: ChatRoom;
  entry: TokenRoomEntry | null;
  me: string;
  onClose: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [bounties, setBounties] = useState<Bounty[] | null>(null);
  const [error, setError] = useState('');
  const [claiming, setClaiming] = useState<Bounty | null>(null);
  const [prUrl, setPrUrl] = useState('');
  const [agent, setAgent] = useState('');
  const [paying, setPaying] = useState<PayoutSpec | null>(null);
  const [busy, setBusy] = useState('');
  const token = entry && entry.key.startsWith('bsv21:') ? { symbol: entry.gate.symbol, dec: entry.gate.dec } : null;
  const isAdmin = String((room as { created_by_handle?: unknown }).created_by_handle ?? '') === me;

  const load = useCallback(async () => {
    try {
      const list = sortBounties(parseBounties(await client.bounties(room.ticker)));
      setBounties(list);
      saveSeen(markSeen(room.ticker, list, loadSeen()));
      window.dispatchEvent(new Event('bwallet:bounties-seen'));
    } catch (e) {
      setError(errText(e));
      setBounties([]);
    }
  }, [client, room.ticker]);
  useEffect(() => {
    load();
  }, [load]);

  const claim = async () => {
    if (!claiming) return;
    const why = claimCheck(claiming, me, prUrl);
    if (why) return setError(why);
    setBusy('Claiming…');
    setError('');
    try {
      await client.claimBounty(room.ticker, claiming.bounty_no, prUrl, agent);
      addSnackbar(`Claimed #${claiming.bounty_no}`, 'success');
      setClaiming(null);
      setPrUrl('');
      setAgent('');
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const startPay = async (b: Bounty) => {
    setBusy('Preparing…');
    setError('');
    try {
      const spec = parseSpec(await client.bountyPayoutSpec(room.ticker, b.bounty_no));
      if (!spec) throw new Error('The server returned no payable transfer');
      setPaying(spec);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const pay = async () => {
    if (!paying) return;
    setBusy('Sending…');
    setError('');
    let confirmed = false;
    let lastTxid = '';
    try {
      for (const t of paying.transfers) {
        const res =
          t.type === 'bsv21'
            ? await sendBsv21.execute(apiContext, {
                tokenId: t.tokenId,
                recipients: [{ amount: BigInt(t.amountRaw), destination: { address: t.address } }],
              })
            : await sendBsv.execute(apiContext, { requests: [{ address: t.address, satoshis: t.sats }] });
        if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
        lastTxid = res.txid;
        // Record the FIRST broadcast at once, so a failure on a later leg can never lead to paying twice.
        if (!confirmed) {
          await client.confirmBountyPayout(room.ticker, paying.bountyNo, res.txid);
          confirmed = true;
        }
      }
      const shown = celebrateSend(lastTxid, {
        amount: { kind: 'token', display: paying.transfers.map(transferLabel).join(' + '), ticker: '' },
        recipients: [`$${paying.claimant}`],
        title: 'Paid!',
      });
      if (!shown) addSnackbar(`Paid #${paying.bountyNo} to $${paying.claimant}`, 'success');
      setPaying(null);
      await load();
    } catch (e) {
      setError(confirmed ? `Recorded as paid, but a later transfer failed: ${errText(e)}` : errText(e));
      if (confirmed) await load();
    } finally {
      setBusy('');
    }
  };

  if (paying) {
    return (
      <Sheet title={`Pay bounty #${paying.bountyNo}`} onClose={onClose}>
        <div className="rounded-2xl p-4 text-sm" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
          {paying.transfers.map((t, i) => (
            <div key={i} className="flex justify-between mt-1">
              <span style={{ color: MUTED }}>Send</span>
              <span className="text-white font-semibold">{transferLabel(t)}</span>
            </div>
          ))}
          <div className="flex justify-between mt-2">
            <span style={{ color: MUTED }}>To</span>
            <span className="text-white font-semibold">${paying.claimant}</span>
          </div>
          <div className="text-[11px] mt-2 break-all" style={{ color: MUTED }}>
            {paying.transfers[0].address}
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => setPaying(null)}
            disabled={!!busy}
            className="flex-1 rounded-2xl py-3 font-bold text-white"
            style={{ background: PANEL }}
          >
            Back
          </button>
          <button
            onClick={pay}
            disabled={!!busy}
            className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy || 'Pay'}
          </button>
        </div>
        {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
      </Sheet>
    );
  }

  if (claiming) {
    return (
      <Sheet title={`Claim #${claiming.bounty_no}`} onClose={onClose}>
        <p className="text-xs mb-3" style={{ color: MUTED }}>
          {claiming.title} — {rewardLabel(claiming, token)}. Paid to your proven receive address when the PR merges.
        </p>
        <input
          autoFocus
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
          placeholder="https://github.com/owner/repo/pull/123"
          autoCapitalize="none"
          autoCorrect="off"
          className="w-full rounded-2xl px-3 py-3 bg-transparent text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
        <input
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          placeholder="Agent (optional, e.g. claude)"
          autoCapitalize="none"
          className="w-full mt-2 rounded-2xl px-3 py-3 bg-transparent text-white outline-none"
          style={{ background: PANEL, border: `1px solid ${LINE}` }}
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => setClaiming(null)}
            disabled={!!busy}
            className="flex-1 rounded-2xl py-3 font-bold text-white"
            style={{ background: PANEL }}
          >
            Back
          </button>
          <button
            onClick={claim}
            disabled={!!busy || !prUrl.trim()}
            className="flex-1 rounded-2xl py-3 font-bold disabled:opacity-50"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy || 'Claim'}
          </button>
        </div>
        {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
      </Sheet>
    );
  }

  return (
    <Sheet title="Bounties" onClose={onClose}>
      <div className="max-h-[60vh] overflow-y-auto flex flex-col gap-2">
        {bounties === null && (
          <p className="text-xs" style={{ color: MUTED }}>
            Loading…
          </p>
        )}
        {bounties?.length === 0 && !error && (
          <p className="text-xs" style={{ color: MUTED }}>
            No bounties in this room yet.
          </p>
        )}
        {bounties?.map((b) => (
          <div key={b.bounty_no} className="rounded-2xl p-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase" style={{ color: STATUS_COLOR[b.status] ?? MUTED }}>
                {b.status}
              </span>
              <span className={`flex-1 text-sm text-white ${ELLIPSIS}`}>
                #{b.bounty_no} {b.title}
              </span>
            </div>
            <div className="text-xs mt-1" style={{ color: GOLD }}>
              {rewardLabel(b, token)}
            </div>
            {b.claimed_by && (
              <div className="text-[11px] mt-1" style={{ color: MUTED }}>
                ${b.claimed_by}
                {b.agent_label ? ` via ${b.agent_label}` : ''}
                {b.github_pr_url ? ` · ${b.github_pr_url.replace('https://github.com/', '')}` : ''}
              </div>
            )}
            {b.status === 'open' && b.created_by !== me && (
              <button
                onClick={() => {
                  setError('');
                  setClaiming(b);
                }}
                className="mt-2 w-full rounded-xl py-2 text-sm font-bold"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                Claim with PR
              </button>
            )}
            {showPay(b, me, isAdmin) && (
              <button
                onClick={() => startPay(b)}
                disabled={!!busy}
                className="mt-2 w-full rounded-xl py-2 text-sm font-bold disabled:opacity-50"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                {busy || 'Pay'}
              </button>
            )}
          </div>
        ))}
      </div>
      {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
    </Sheet>
  );
};

/** "$BOASE ✓" for a verified personal token, else the room name / "$SYM". */
const entryTitle = (entry: TokenRoomEntry | null, room: ChatRoom | null): string | null => {
  if (!entry) return room?.name || null;
  if (entry.key.startsWith('coll:')) return room?.name || entry.gate.symbol;
  const label = tickerLabel(entry.gate.symbol, entry.holding.id, knownPersonal());
  return label.endsWith('✓') ? label : room?.name || label;
};

// ───────────────────────────── Token rooms list ─────────────────────────────

const LOOKUP_TTL_MS = 5 * 60_000;

const ListLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="px-4 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wider" style={{ color: MUTED }}>
    {children}
  </div>
);

/** A joined open room (no token) in "Your rooms". */
const OpenRoomRow = ({ room, me, onOpen }: { room: ChatRoom; me: string; onOpen: () => void }) => {
  const info = openInfo(room);
  const unread = room.unread ?? 0;
  const title = room.name || `$${room.ticker}`;
  return (
    <li>
      <button onClick={onOpen} className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]">
        <Avatar title={title} src={roomIcon(room)} />
        <div className="flex-1 min-w-0 pb-[10px] -mb-[10px]" style={{ borderBottom: `1px solid ${LINE}` }}>
          <div className="flex items-baseline gap-2">
            <span className={`flex-1 flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
              <span className={ELLIPSIS}>{title}</span>
              {info?.official && <ShieldCheck size={14} color={GOLD} className="shrink-0" />}
              {info?.visibility === 'invite' && <Lock size={12} color={MUTED} className="shrink-0" />}
            </span>
            <span className="text-[11px] shrink-0" style={{ color: unread ? GOLD : MUTED }}>
              {listTimeLabel(room.last_message?.created_at ?? room.updated_at)}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-[2px]">
            <span className={`flex-1 text-[13px] ${ELLIPSIS}`} style={{ color: MUTED }}>
              {info?.closed ? 'Closed' : previewText(room, me)}
            </span>
            {unread > 0 && (
              <span
                className="min-w-[20px] h-5 px-[6px] rounded-full text-[11px] font-bold flex items-center justify-center shrink-0"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </div>
        </div>
      </button>
    </li>
  );
};

/**
 * One of the user's own tokens whose room isn't set up yet (incl. the personal $NAME token): shown in
 * "Your rooms" as not open, with the shared paid setup (tokens/useRoomSetup). Hidden once open or
 * paid, and while the indexer doesn't answer. Not rendered in a store build (ROOMS).
 */
const SetupRoomRow = ({ token, onDone }: { token: OwnToken; onDone: () => void }) => {
  const s = useRoomSetup(token.tokenId, token.ticker, { onDone });
  if (!s.total || (!s.needs && !s.msg)) return null;
  const title = `$${token.ticker}`;
  return (
    <li className="flex items-center gap-3 px-4 py-[10px]">
      <Avatar title={title} roomKey={`bsv21:${token.tokenId}`} />
      <div className="flex-1 min-w-0">
        <div className={`flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
          <span className={ELLIPSIS}>{title}</span>
          <Lock size={12} color={MUTED} className="shrink-0" />
        </div>
        <div className="text-[13px] line-clamp-2" style={{ color: MUTED }}>
          {s.msg || 'Not open yet. Setting up lists it in other wallets and the Market and opens this room.'}
        </div>
      </div>
      {s.needs && (
        <button
          onClick={s.start}
          disabled={s.busy}
          className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold disabled:opacity-40"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          {setupLabel(s.total.totalSats, s.rate, 'Set up your room')}
        </button>
      )}
      {s.sheet}
    </li>
  );
};

/**
 * Chat › Chatrooms: "Your rooms" (joined open + token rooms), "Public rooms" (open rooms anyone
 * can join, docs/TOKEN-ROOMS.md › Open rooms), "+ New room", and Token rooms (full build only).
 * `header` is the Chat tab's Chatrooms | DMs | Calls switch.
 */
const RoomsPage = ({ header }: { header: React.ReactNode }) => {
  const myName = useChatDisplayName();
  const { apiContext } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const online = useOnline();
  const client = useMemo(() => new BchatClient(defaultHttp(isNative), loadSession()), []);
  const [handle, setHandle] = useState<string | null>(client.handle);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState('');

  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [lookups, setLookups] = useState<Record<string, TokenRoomLookup>>({});
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<{ room: ChatRoom; entry: TokenRoomEntry | null } | null>(null);
  const [locked, setLocked] = useState<{ gate: TokenGate; heldRaw: string | null; members: number | null } | null>(
    null,
  );
  const [inviting, setInviting] = useState(false);
  const [banning, setBanning] = useState(false);
  // Token room settings / rules: only the token's issuer can change them (RoomSettingsSheet).
  const [roomSettings, setRoomSettings] = useState(false);
  const [showBounties, setShowBounties] = useState(false);
  const [opening, setOpening] = useState('');
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  // Open rooms (no token): every build, store build included.
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [newRoom, setNewRoom] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [msgMenu, setMsgMenu] = useState<ChatMessage | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const openTicker = open && isOpenRoom(open.room) ? open.room.ticker : null;
  const { card, reload: reloadCard } = useRoomCard(client, openTicker);
  const { chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  // Cache first (owner round 6): the last room list shows at once; the live list replaces it quietly.
  const [rooms, setRooms] = useState<ChatRoom[] | null>(() => readListCache<ChatRoom>(`chat:rooms:${identityAddress}`));
  const autoTried = useRef(false);
  const proved = useRef<Set<string>>(new Set());
  const lookedAt = useRef<Map<string, number>>(new Map());

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setAuthError('');
    try {
      const s = await client.signIn(walletSigner(apiContext));
      saveSession(s);
      setHandle(s.handle);
    } catch (e) {
      setAuthError(errText(e));
    } finally {
      setSigningIn(false);
    }
  }, [client, apiContext]);

  // Tapping the Chat tab inside a room goes back to the room list.
  useEffect(() => {
    const onTap = (e: Event) => {
      if ((e as CustomEvent).detail === 'chat') setOpen(null);
    };
    window.addEventListener(TAB_TAP, onTap);
    return () => window.removeEventListener(TAB_TAP, onTap);
  }, []);

  const authLost = useCallback(() => {
    client.signOut();
    saveSession(null);
    setHandle(null);
    setOpen(null);
    setRooms(null);
  }, [client]);

  useEffect(() => {
    const saved = client.current;
    if (!saved) return;
    walletSigner(apiContext)
      .address()
      .then((a) => a !== saved.address && authLost())
      .catch(() => {});
  }, [client, apiContext, authLost]);

  useEffect(() => {
    if (handle || autoTried.current || !online) return;
    autoTried.current = true;
    void signIn();
  }, [handle, online, signIn]);

  /** Prove this wallet's token keys to bChat (once per key per visit; signatures only). */
  const prove = useCallback(
    async (key?: string) => {
      const tag = key ?? '*';
      if (proved.current.has(tag)) return;
      proved.current.add(tag);
      await proveHoldings(apiContext, client, key).catch(() => proved.current.delete(tag));
    },
    [apiContext, client],
  );

  // Once signed in: link the wallet's keys so bChat can see what it holds.
  useEffect(() => {
    if (handle) void prove();
  }, [handle, prove]);

  // Invite lists (local, per handle) and a personal room still waiting for the indexer.
  useEffect(() => {
    if (!handle) return;
    setIgnored(loadInviteList(handle, 'ignored'));
    void syncBlocks(client);
    setAccepted(loadInviteList(handle, 'accepted'));
    if (identityAddress) void retryPersonalRoom(apiContext, identityAddress, client).then((t) => t && refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, identityAddress]);

  const refresh = useCallback(() => {
    if (!handle || !online) return;
    void walletHoldings(apiContext)
      .then(setHoldings)
      .catch(() => setHoldings([]));
    client
      .openRooms()
      .then((d) => setPublicRooms(parsePublicRooms(d)))
      .catch(() => {});
    client
      .rooms()
      .then((r) => {
        setRooms(r);
        writeListCache(`chat:rooms:${identityAddress}`, r, 100);
        setListError('');
      })
      .catch((e) => {
        if (e instanceof ChatApiError && e.status === 401) return authLost();
        setListError(errText(e));
      });
  }, [client, apiContext, handle, online, authLost, identityAddress]);

  useEffect(refresh, [refresh]);
  usePoll(refresh, LIST_POLL_MS, !!handle && !open);

  // Rooms you hold the token for but are not in yet: ask bChat whether they exist.
  useEffect(() => {
    if (!handle || !holdings || !rooms) return;
    const mine = new Set(
      buildTokenRoomList(holdings, rooms)
        .filter((e) => e.status === 'member')
        .map((e) => e.key),
    );
    const now = Date.now();
    const todo = holdings
      .map((h) => `${h.kind}:${h.id}`)
      .filter((k) => !mine.has(k) && now - (lookedAt.current.get(k) ?? 0) > LOOKUP_TTL_MS)
      .slice(0, 20);
    todo.forEach((k) => lookedAt.current.set(k, now));
    void Promise.all(
      todo.map((k) =>
        client
          .tokenRoom(k)
          .then((d) => parseLookup(d))
          .catch(() => null),
      ),
    ).then((found) => {
      const ok = found.filter((l): l is TokenRoomLookup => !!l);
      ok.forEach(
        (l) => l.personal?.tokenId && rememberPersonal({ name: l.personal.name, tokenId: l.personal.tokenId }),
      );
      const add = Object.fromEntries(ok.map((l) => [l.key, l]));
      if (Object.keys(add).length) setLookups((cur) => ({ ...cur, ...add }));
    });
  }, [client, handle, holdings, rooms]);

  const entries = useMemo(
    () => (holdings && rooms ? buildTokenRoomList(holdings, rooms, lookups) : null),
    [holdings, rooms, lookups],
  );
  const personalOf = useCallback(
    (e: TokenRoomEntry) => (e.room ? personalOfRoom(e.room) : null) ?? lookups[e.key]?.personal ?? null,
    [lookups],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    return (entries ?? [])
      .map((e) => ({ e, invite: inviteState(e, personalOf(e), handle || '', { ignored, accepted }) }))
      .filter(({ invite }) => invite !== 'hidden')
      .filter(
        ({ e }) => !q || e.gate.symbol.toLowerCase().includes(q) || (e.room?.name ?? '').toLowerCase().includes(q),
      );
  }, [entries, query, personalOf, handle, ignored, accepted]);

  const ignoreInvite = (key: string) => handle && setIgnored(addToInviteList(handle, 'ignored', key));
  const acceptInvite = (e: TokenRoomEntry) => {
    if (handle) setAccepted(addToInviteList(handle, 'accepted', e.key));
    void openEntry(e);
  };

  const q = query.trim().toLowerCase().replace(/^\$/, '');
  const myOpen = useMemo(
    () => (rooms ?? []).filter(isOpenRoom).filter((r) => !q || `${r.name ?? ''} ${r.ticker}`.toLowerCase().includes(q)),
    [rooms, q],
  );
  const browse = useMemo(
    () => browseList(publicRooms, new Set((rooms ?? []).map((r) => r.ticker.toUpperCase())), query),
    [publicRooms, rooms, query],
  );
  const tokenMine = shown.filter(({ e }) => e.status === 'member');
  const tokenOther = shown.filter(({ e }) => e.status !== 'member');
  const yours = useMemo(() => {
    const at = (r: ChatRoom | null) => Date.parse(r?.last_message?.created_at ?? r?.updated_at ?? '') || 0;
    const list: ({ kind: 'open'; room: ChatRoom } | { kind: 'token'; item: (typeof shown)[number] })[] = [
      ...[...myOpen].sort(byActivity).map((room) => ({ kind: 'open' as const, room })),
      ...(ROOMS ? tokenMine.map((item) => ({ kind: 'token' as const, item })) : []),
    ];
    return list.sort(
      (a, b) => at(b.kind === 'open' ? b.room : b.item.e.room) - at(a.kind === 'open' ? a.room : a.item.e.room),
    );
  }, [myOpen, tokenMine]);

  const openOpenRoom = (room: ChatRoom) => {
    setRooms((cur) => cur?.map((r) => (r.ticker === room.ticker ? { ...r, unread: 0 } : r)) ?? cur);
    setHidden(new Set());
    setOpen({ room, entry: null });
  };
  const stubRoom = (ticker: string, name: string, extra: Partial<ChatRoom> = {}): ChatRoom => ({
    id: ticker,
    ticker,
    name,
    party_count: 1,
    metadata: { kind: 'open', open: {} },
    ...extra,
  });
  const joinPublic = async (r: PublicRoom) => {
    setOpening(r.ticker);
    try {
      await client.joinOpenRoom({ ticker: r.ticker });
      openOpenRoom(
        stubRoom(r.ticker, r.name, {
          party_count: r.memberCount + 1,
          metadata: { kind: 'open', open: { visibility: 'public', description: r.description, official: r.official } },
        }),
      );
      refresh();
    } catch (e) {
      if (e instanceof ChatApiError && e.status === 401) return authLost();
      setListError(errText(e));
    } finally {
      setOpening('');
    }
  };
  const blockUser = (target: string) => void setBlocked(client, target, true);

  const buy = (key: string) => {
    const ref = parseTokenKey(key);
    setLocked(null);
    if (!ref || !MARKET_ENABLED) return;
    requestMarketToken(ref);
    handleSelect(asMenuItem('market'));
  };

  const openEntry = useCallback(
    async (entry: TokenRoomEntry) => {
      if (!ROOMS) return setListError(STORE_ROOM_NOTE);
      setOpening(entry.key);
      try {
        await prove(entry.key);
        let room = entry.room;
        if (!room) {
          const ticker = await client.startTokenRoom(entry.key);
          room = { id: ticker, ticker, name: null, party_count: 1 };
        }
        setRooms((cur) => cur?.map((r) => (r.ticker === room!.ticker ? { ...r, unread: 0 } : r)) ?? cur);
        setOpen({ room, entry });
      } catch (e) {
        if (e instanceof ChatApiError && e.status === 401) return authLost();
        const refusal = e instanceof ChatApiError ? parseGateRefusal(e.data) : null;
        if (refusal)
          setLocked({ gate: refusal.gate, heldRaw: refusal.heldRaw, members: refusal.room?.members ?? null });
        else setListError(errText(e));
      } finally {
        setOpening('');
      }
    },
    [client, prove, authLost],
  );

  // "Open room" from a Wallet / Market token page.
  useEffect(() => {
    if (!handle) return;
    const take = async () => {
      const key = takeChatRoom();
      if (!key) return;
      const held = (holdings ?? (await walletHoldings(apiContext).catch(() => []))).filter(
        (h) => `${h.kind}:${h.id}` === key,
      );
      await prove(key);
      const look = parseLookup(await client.tokenRoom(key).catch(() => null));
      const list = buildTokenRoomList(held, rooms ?? [], look ? { [key]: look } : {});
      if (list[0]) return void openEntry(list[0]);
      // Not held (or below the minimum): show the lock with the room's real terms.
      const gate = look?.gate ?? { key, symbol: held[0]?.symbol ?? 'TOKEN', dec: held[0]?.dec ?? 0, minRaw: '1' };
      setLocked({ gate, heldRaw: look?.heldRaw ?? held[0]?.amountRaw ?? null, members: look?.room?.members ?? null });
    };
    void take();
    return onTokenNav(() => void take());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  // A tapped push notification (src/mobile/push): open the room by ticker once the lists have loaded.
  const [pushTicker, setPushTicker] = useState<string | null>(null);
  useEffect(() => {
    if (!handle) return;
    const take = () => {
      const t = takeRoomTicker(false);
      if (t) setPushTicker(t);
    };
    take();
    return onRoomTicker(take);
  }, [handle]);
  useEffect(() => {
    if (!pushTicker || !rooms) return;
    const room = rooms.find((r) => r.ticker.toUpperCase() === pushTicker);
    if (!room) return setPushTicker(null);
    if (isOpenRoom(room)) {
      setPushTicker(null);
      return openOpenRoom(room);
    }
    const e = entries?.find((x) => x.room?.ticker.toUpperCase() === pushTicker);
    if (e) {
      setPushTicker(null);
      void openEntry(e);
    } else if (entries) {
      setPushTicker(null);
      setOpen({ room, entry: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushTicker, rooms, entries]);

  /** One token room row (unchanged from the token-only list). */
  const renderTokenRow = ({ e, invite }: (typeof shown)[number]) => {
    const title = entryTitle(e, e.room) ?? `$${e.gate.symbol}`;
    const personal = personalOf(e);
    if (invite === 'invite' && personal && ROOMS) {
      return (
        <li key={e.key} className="flex items-center gap-3 px-4 py-[10px]">
          <Avatar title={e.gate.symbol} roomKey={e.key} />
          <div className="flex-1 min-w-0">
            <div className={`text-[15px] font-semibold text-white ${ELLIPSIS}`}>{inviteLine(personal)}</div>
            <div className={`text-[12px] ${ELLIPSIS}`} style={{ color: MUTED }}>
              {title} · {e.members ?? 0} holder{e.members === 1 ? '' : 's'}
            </div>
          </div>
          <button
            onClick={() => acceptInvite(e)}
            disabled={!!opening}
            className="rounded-xl px-3 py-1 text-xs font-bold"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            Join
          </button>
          <button
            onClick={() => ignoreInvite(e.key)}
            className="rounded-xl px-3 py-1 text-xs font-bold text-white"
            style={{ background: PANEL }}
          >
            Ignore
          </button>
        </li>
      );
    }
    const unread = e.status === 'member' ? (e.room?.unread ?? 0) : 0;
    const sub = !ROOMS
      ? STORE_ROOM_NOTE
      : e.status === 'start'
        ? "Tap to open the holders' room"
        : e.status === 'join'
          ? `${e.members ?? 0} holder${e.members === 1 ? '' : 's'} · tap to join`
          : e.room
            ? previewText(e.room, handle || '')
            : '';
    return (
      <li key={e.key}>
        <button
          onClick={() => void openEntry(e)}
          disabled={!!opening || !ROOMS}
          className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
        >
          <Avatar title={e.gate.symbol} roomKey={e.key} />
          <div className="flex-1 min-w-0 pb-[10px] -mb-[10px]" style={{ borderBottom: `1px solid ${LINE}` }}>
            <div className="flex items-baseline gap-2">
              <span className={`flex-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>{title}</span>
              <span className="text-[11px] shrink-0" style={{ color: unread ? GOLD : MUTED }}>
                {opening === e.key
                  ? 'opening…'
                  : e.room
                    ? listTimeLabel(e.room.last_message?.created_at ?? e.room.updated_at)
                    : ''}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-[2px]">
              <span
                className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-[10px] font-bold"
                style={{ background: '#2a2208', color: GOLD, border: '1px solid #3a2f0c' }}
              >
                <Coins size={10} /> {amountLabel(e.holding.amountRaw, e.gate)}
              </span>
              <span className={`flex-1 text-[13px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                {sub}
              </span>
              {unread > 0 && (
                <span
                  className="min-w-[20px] h-5 px-[6px] rounded-full text-[11px] font-bold flex items-center justify-center shrink-0"
                  style={{ background: GOLD, color: '#1a1300' }}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </div>
          </div>
        </button>
      </li>
    );
  };

  return (
    <div
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
      style={{ height: '100%', background: BG }}
    >
      <PullToRefresh onRefresh={refresh} disabled={!handle} />
      <TopNav />
      <div className="w-full pt-16 flex flex-col">
        <SegmentRow>{header}</SegmentRow>
        <SegmentTitle title="Chatrooms">
          {handle && (
            <span className="mr-1 flex flex-col items-end leading-tight">
              <span className="text-[12px] font-semibold text-white">{myName || `$${handle}`}</span>
              {myName && (
                <span className="text-[10px]" style={{ color: MUTED }}>
                  ${handle}
                </span>
              )}
            </span>
          )}
        </SegmentTitle>

        {!online && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
            style={{ background: '#1a1408', color: '#e6c76a' }}
          >
            <WifiOff size={14} /> You're offline. Chatrooms will refresh when you reconnect.
          </div>
        )}

        {handle && (rooms?.length ?? 0) + publicRooms.length > 4 && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <Search size={15} color={MUTED} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chatrooms"
              className="flex-1 bg-transparent py-2 text-sm text-white outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} aria-label="Clear">
                <X size={14} color={MUTED} />
              </button>
            )}
          </div>
        )}

        {!handle && (
          <div className="px-6 pt-16 flex flex-col items-center text-center gap-3">
            <div
              className="h-16 w-16 rounded-2xl flex items-center justify-center"
              style={{ background: 'linear-gradient(145deg,#2a2208,#0d0b04)', border: '1px solid #3a2f0c' }}
            >
              <MessageCircle size={28} color={GOLD} />
            </div>
            <h2 className="text-lg font-bold text-white">Chatrooms</h2>
            <p className="text-xs" style={{ color: MUTED }}>
              {ROOMS
                ? 'Join public rooms, start your own, and chat with the holders of every token you own.'
                : 'Join public rooms or start your own.'}{' '}
              Signs in to bChat with this wallet's identity key — no password.
            </p>
            <button
              onClick={signIn}
              disabled={signingIn || !online}
              className="mt-2 rounded-2xl px-6 py-3 text-sm font-bold disabled:opacity-50"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {signingIn ? 'Signing in…' : 'Sign in with wallet'}
            </button>
            {authError && <p className="text-xs text-[#F97066]">{authError}</p>}
          </div>
        )}

        {handle && (
          <div className="px-4 pb-1 flex">
            <button
              onClick={() => setNewRoom(true)}
              className="rounded-2xl px-4 py-2 text-sm font-bold inline-flex items-center gap-1"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <Plus size={16} strokeWidth={2.6} /> New room
            </button>
          </div>
        )}
        {handle && rooms === null && !listError && (
          <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
            Loading chatrooms…
          </div>
        )}
        {handle && listError && (
          <div className="text-center text-xs pt-4 px-6 text-[#F97066]">
            {listError}
            <div>
              <button onClick={refresh} className="mt-2 underline" style={{ color: GOLD }}>
                Try again
              </button>
            </div>
          </div>
        )}

        {handle && rooms && (
          <>
            <ListLabel>Your rooms</ListLabel>
            {yours.length === 0 && (
              <p className="px-4 pb-2 text-xs" style={{ color: MUTED }}>
                You haven’t joined any rooms yet. Pick a public room below or start your own.
              </p>
            )}
            <ul className="w-full">
              {ROOMS &&
                ownTokens(identityAddress).map((t) => (
                  <SetupRoomRow
                    key={t.tokenId}
                    token={t}
                    onDone={() => {
                      void recheckPendingIndexing(apiContext, identityAddress);
                      // The indexer lists it within about a second; then the room opens like any other.
                      setTimeout(() => {
                        if (identityAddress)
                          void retryPersonalRoom(apiContext, identityAddress, client).then((r) => r && refresh());
                        refresh();
                      }, 5000);
                    }}
                  />
                ))}
              {yours.map((y) =>
                y.kind === 'open' ? (
                  <OpenRoomRow key={y.room.ticker} room={y.room} me={handle} onOpen={() => openOpenRoom(y.room)} />
                ) : (
                  renderTokenRow(y.item)
                ),
              )}
            </ul>

            <ListLabel>Public rooms</ListLabel>
            {browse.length === 0 && (
              <p className="px-4 pb-2 text-xs" style={{ color: MUTED }}>
                {query ? 'No public rooms match.' : 'No other public rooms right now. Start one.'}
              </p>
            )}
            <ul className="w-full">
              {browse.map((r) => (
                <li key={r.ticker} className="flex items-center gap-3 px-4 py-[10px]">
                  <Avatar title={r.name} />
                  <div className="flex-1 min-w-0">
                    <div className={`flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
                      <span className={ELLIPSIS}>{r.name}</span>
                      {r.official && <ShieldCheck size={14} color={GOLD} className="shrink-0" />}
                    </div>
                    <div className={`text-[12px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                      {r.memberCount} member{r.memberCount === 1 ? '' : 's'}
                      {r.description ? ` · ${r.description}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => void joinPublic(r)}
                    disabled={!!opening}
                    className="rounded-xl px-3 py-1 text-xs font-bold disabled:opacity-50"
                    style={{ background: GOLD, color: '#1a1300' }}
                  >
                    {opening === r.ticker ? '…' : 'Join'}
                  </button>
                </li>
              ))}
            </ul>

            {/* Token rooms: full build only. The store build hides the section entirely (storeBuild.ts). */}
            {ROOMS && (
              <>
                <ListLabel>Token rooms</ListLabel>
                {entries === null && (
                  <div className="text-center text-xs py-4" style={{ color: MUTED }}>
                    Loading token rooms…
                  </div>
                )}
                {entries && entries.length === 0 && (
                  <div className="px-8 pt-4 pb-6 text-center">
                    <p className="text-sm text-white font-semibold">No token rooms yet</p>
                    <p className="text-xs mt-1" style={{ color: MUTED }}>
                      Buy a token in Market to join its chatroom.
                    </p>
                    {MARKET_ENABLED && (
                      <button
                        onClick={() => handleSelect(asMenuItem('market'))}
                        className="mt-4 rounded-2xl px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
                        style={{ background: GOLD, color: '#1a1300' }}
                      >
                        <ShoppingCart size={15} /> {marketLabel()}
                      </button>
                    )}
                  </div>
                )}
                {entries && entries.length > 0 && tokenOther.length === 0 && (
                  <p className="px-4 pb-2 text-xs" style={{ color: MUTED }}>
                    You’re in every token room you hold. They’re under Your rooms.
                  </p>
                )}
                <ul className="w-full">{tokenOther.map(renderTokenRow)}</ul>
              </>
            )}
          </>
        )}
      </div>

      {locked && (
        <LockedRoom
          gate={locked.gate}
          heldRaw={locked.heldRaw}
          members={locked.members}
          onBuy={() => buy(locked.gate.key)}
          onClose={() => setLocked(null)}
        />
      )}
      {open && handle && (
        <Conversation
          client={client}
          room={open.room}
          entry={open.entry}
          me={handle}
          online={online}
          onAuthLost={authLost}
          onInvite={open.entry && open.entry.key.startsWith('bsv21:') ? () => setInviting(true) : null}
          onBans={!openTicker && open.entry ? () => setRoomSettings(true) : null}
          onBounties={openTicker ? null : () => setShowBounties(true)}
          openRoom={
            openTicker
              ? {
                  closed: card?.closed ?? openInfo(open.room)?.closed ?? false,
                  visibility: card?.visibility ?? openInfo(open.room)?.visibility ?? 'public',
                  onInfo: () => setShowInfo(true),
                }
              : null
          }
          hidden={hidden}
          onMessageMenu={setMsgMenu}
          onLocked={(r) => {
            setOpen(null);
            setLocked({ gate: r.gate, heldRaw: r.heldRaw, members: r.room?.members ?? null });
            refresh();
          }}
          onBack={() => {
            setOpen(null);
            refresh();
          }}
        />
      )}
      {newRoom && handle && (
        <NewRoomSheet
          client={client}
          onClose={() => setNewRoom(false)}
          onDone={(r) => {
            setNewRoom(false);
            openOpenRoom(stubRoom(r.ticker, r.name));
            refresh();
          }}
        />
      )}
      {showInfo && open && card && handle && (
        <OpenRoomSheet
          client={client}
          card={card}
          me={handle}
          onClose={() => setShowInfo(false)}
          onChanged={reloadCard}
          onLeft={() => {
            setShowInfo(false);
            setOpen(null);
            refresh();
          }}
        />
      )}
      {msgMenu && open && handle && (
        <MessageMenu
          client={client}
          ticker={open.room.ticker}
          message={msgMenu}
          me={handle}
          canDelete={!!openTicker && isStaff(card) && !card?.closed}
          onDeleted={() => setHidden((cur) => new Set(cur).add(msgMenu.id))}
          onBlock={blockUser}
          onClose={() => setMsgMenu(null)}
        />
      )}
      {roomSettings && open?.entry && (
        <RoomSettingsSheet
          client={client}
          ctx={apiContext}
          ticker={open.room.ticker}
          entry={open.entry}
          onBans={() => {
            setRoomSettings(false);
            setBanning(true);
          }}
          onClose={() => setRoomSettings(false)}
        />
      )}
      {banning && open && <BansSheet client={client} ticker={open.room.ticker} onClose={() => setBanning(false)} />}
      {showBounties && open && handle && (
        <BountiesSheet
          client={client}
          room={open.room}
          entry={open.entry}
          me={handle}
          onClose={() => setShowBounties(false)}
        />
      )}
      {inviting && open?.entry && (
        <InviteSheet client={client} ticker={open.room.ticker} entry={open.entry} onClose={() => setInviting(false)} />
      )}
    </div>
  );
};

/** A 1:1 conversation for the DMs segment: the same view, without token-room extras. */
const DmConversation = (p: DmConversationProps) => (
  <Conversation
    {...p}
    entry={null}
    onLocked={() => p.onBack()}
    onInvite={null}
    onBans={null}
    onBounties={null}
    bell={false}
    peer={/↔/.test(p.room.name || '') ? roomTitle(p.room, p.me).replace(/^\$/, '') : null}
  />
);

const ChatPage = () => (
  <ChatTabs
    rooms={(header) => <RoomsPage header={header} />}
    dms={(header) => <DmsPage header={header} Conversation={DmConversation} />}
  />
);

export default ChatPage;
