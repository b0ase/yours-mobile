import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, MessageCirclePlus, RefreshCw, Search, WifiOff, X } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { BchatClient, ChatApiError, defaultHttp, loadSession, saveSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import {
  avatarHue,
  filterRooms,
  isDirectRoom,
  latestCursor,
  listTimeLabel,
  mergeMessages,
  oldestCursor,
  previewText,
  roomInitial,
  roomTitle,
  sortRooms,
  threadItems,
  timeLabel,
  type ChatMessage,
  type ChatRoom,
} from '../chat/messages';

/**
 * Chat tab: native bChat client. Chats list → conversation → back, all inside
 * this tab; the bottom bar stays on the list, the conversation covers it.
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

const Avatar = ({ title, size = 48 }: { title: string; size?: number }) => {
  const hue = avatarHue(title);
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

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ───────────────────────────── Conversation ─────────────────────────────

const Conversation = ({
  client,
  room,
  me,
  online,
  onBack,
  onAuthLost,
}: {
  client: BchatClient;
  room: ChatRoom;
  me: string;
  online: boolean;
  onBack: () => void;
  onAuthLost: () => void;
}) => {
  const title = roomTitle(room, me);
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
      setError(errText(e));
    },
    [onAuthLost],
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
      });
  };

  const items = useMemo(() => threadItems(messages, me), [messages, me]);
  const direct = isDirectRoom(room);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col" style={{ background: BG }}>
      <div
        className="flex items-center gap-3 px-2 pb-2 shrink-0"
        style={{
          paddingTop: 'calc(env(safe-area-inset-top) + 8px)',
          background: 'linear-gradient(180deg, #16140c 0%, #0b0b0b 100%)',
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <button onClick={onBack} className="p-2 rounded-full active:opacity-60" aria-label="Back">
          <ArrowLeft size={22} color={GOLD} />
        </button>
        <Avatar title={title} size={38} />
        <div className="flex-1 min-w-0">
          <div className={`text-[15px] font-semibold text-white ${ELLIPSIS}`}>{title}</div>
          <div className="text-[11px]" style={{ color: MUTED }}>
            {!online
              ? 'waiting for network…'
              : direct
                ? 'direct message'
                : `${room.party_count ?? 0} member${room.party_count === 1 ? '' : 's'} · $${room.ticker}`}
          </div>
        </div>
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
            No messages yet. Say hello.
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
            <div
              key={it.key}
              className={`flex ${it.mine ? 'justify-end' : 'justify-start'} ${it.firstOfGroup ? 'mt-2' : 'mt-[3px]'}`}
            >
              <div
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
                <span className="text-[10px] ml-2 float-right mt-[6px]" style={{ color: it.mine ? '#5c4800' : MUTED }}>
                  {it.message.edited ? 'edited · ' : ''}
                  {it.message.failed ? (
                    <button className="underline text-[#b42318]" onClick={() => send(it.message.body || '', it.message)}>
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
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex items-end gap-2 px-3 pt-2 shrink-0"
        style={{
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 8px)',
          background: '#0b0b0b',
          borderTop: `1px solid ${LINE}`,
        }}
      >
        {/* v2 hook: attachment / voice note / video note buttons go here (rooms/[ticker]/media). */}
        <textarea
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
    </div>
  );
};

// ───────────────────────────── New DM sheet ─────────────────────────────

const NewChat = ({ onOpen, onClose }: { onOpen: (handle: string) => Promise<void>; onClose: () => void }) => {
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    const h = handle.trim().replace(/^\$/, '');
    if (!/^[\w.-]{1,64}$/.test(h)) return setError('Enter a $handle');
    setBusy(true);
    setError('');
    try {
      await onOpen(h);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
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
          <span className="text-white font-semibold">New message</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-2xl px-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
          <span style={{ color: GOLD }} className="font-bold">
            $
          </span>
          <input
            autoFocus
            value={handle.replace(/^\$/, '')}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="handle"
            autoCapitalize="none"
            autoCorrect="off"
            className="flex-1 bg-transparent py-3 text-white outline-none"
          />
        </div>
        {error && <p className="text-xs text-[#F97066] mt-2">{error}</p>}
        <button
          onClick={go}
          disabled={busy}
          className="w-full mt-4 rounded-2xl py-3 font-bold disabled:opacity-50"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          {busy ? 'Opening…' : 'Start chat'}
        </button>
      </div>
    </div>
  );
};

// ───────────────────────────── Chats list ─────────────────────────────

const ChatPage = () => {
  const { apiContext } = useServiceContext();
  const online = useOnline();
  const client = useMemo(() => new BchatClient(defaultHttp(isNative), loadSession()), []);
  const [handle, setHandle] = useState<string | null>(client.handle);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState('');
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [listError, setListError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ChatRoom | null>(null);
  const [composing, setComposing] = useState(false);
  const autoTried = useRef(false);

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

  const authLost = useCallback(() => {
    client.signOut();
    saveSession(null);
    setHandle(null);
    setOpen(null);
    setRooms(null);
  }, [client]);

  // A stored session belongs to one wallet identity; drop it after an account switch.
  useEffect(() => {
    const saved = client.current;
    if (!saved) return;
    walletSigner(apiContext)
      .address()
      .then((a) => a !== saved.address && authLost())
      .catch(() => {});
  }, [client, apiContext, authLost]);

  // Sign in automatically once per visit (the wallet's normal approval applies).
  useEffect(() => {
    if (handle || autoTried.current || !online) return;
    autoTried.current = true;
    void signIn();
  }, [handle, online, signIn]);

  const refresh = useCallback(() => {
    if (!handle || !online) return;
    client
      .rooms()
      .then((r) => {
        setRooms(r);
        setListError('');
      })
      .catch((e) => {
        if (e instanceof ChatApiError && e.status === 401) return authLost();
        setListError(errText(e));
      });
  }, [client, handle, online, authLost]);

  useEffect(refresh, [refresh]);
  usePoll(refresh, LIST_POLL_MS, !!handle && !open);

  const openRoom = (room: ChatRoom) => {
    setRooms((cur) => cur?.map((r) => (r.id === room.id ? { ...r, unread: 0 } : r)) ?? cur);
    setOpen(room);
  };

  const openDirect = async (h: string) => {
    const ticker = await client.openDirect(h);
    const fresh = await client.rooms().catch(() => rooms ?? []);
    setRooms(fresh);
    setComposing(false);
    openRoom(fresh.find((r) => r.ticker === ticker) ?? { id: ticker, ticker, name: `$${handle} ↔ $${h}` });
  };

  const shown = useMemo(
    () => (rooms && handle ? filterRooms(sortRooms(rooms), query, handle) : []),
    [rooms, query, handle],
  );

  return (
    <div
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
      style={{ height: 'calc(75%)', background: BG }}
    >
      <TopNav />
      <div className="w-full pt-16 flex flex-col">
        <div className="flex items-center justify-between px-4 pb-2">
          <h1 className="text-[22px] font-bold text-white">Chats</h1>
          <div className="flex items-center gap-1">
            {handle && (
              <span className="text-[11px] mr-1" style={{ color: MUTED }}>
                ${handle}
              </span>
            )}
            <button
              onClick={refresh}
              disabled={!handle}
              aria-label="Refresh"
              className="p-2 rounded-full active:opacity-60 disabled:opacity-30"
            >
              <RefreshCw size={18} color={MUTED} />
            </button>
            <button
              onClick={() => setComposing(true)}
              disabled={!handle}
              aria-label="New message"
              className="p-2 rounded-full active:opacity-60 disabled:opacity-30"
            >
              <MessageCirclePlus size={22} color={GOLD} />
            </button>
          </div>
        </div>

        {!online && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
            style={{ background: '#1a1408', color: '#e6c76a' }}
          >
            <WifiOff size={14} /> You're offline. Chats will refresh when you reconnect.
          </div>
        )}

        {handle && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <Search size={15} color={MUTED} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
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
              <MessageCirclePlus size={28} color={GOLD} />
            </div>
            <h2 className="text-lg font-bold text-white">bChat</h2>
            <p className="text-xs" style={{ color: MUTED }}>
              Messages with anyone on bitcoinchat.online. Signs in with this wallet's identity key — no password.
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

        {handle && rooms === null && !listError && (
          <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
            Loading chats…
          </div>
        )}
        {handle && listError && rooms === null && (
          <div className="text-center text-xs pt-10 text-[#F97066]">
            {listError}
            <div>
              <button onClick={refresh} className="mt-3 underline" style={{ color: GOLD }}>
                Try again
              </button>
            </div>
          </div>
        )}
        {handle && rooms && rooms.length === 0 && (
          <div className="px-8 pt-14 text-center">
            <p className="text-sm text-white font-semibold">No chats yet</p>
            <p className="text-xs mt-1" style={{ color: MUTED }}>
              Start one with someone's $handle.
            </p>
            <button
              onClick={() => setComposing(true)}
              className="mt-4 rounded-2xl px-5 py-2 text-sm font-bold"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              New message
            </button>
          </div>
        )}
        {handle && rooms && rooms.length > 0 && shown.length === 0 && (
          <div className="text-center text-xs pt-10" style={{ color: MUTED }}>
            No chats match "{query}"
          </div>
        )}

        <ul className="w-full">
          {shown.map((room) => {
            const title = roomTitle(room, handle || '');
            const unread = room.unread ?? 0;
            return (
              <li key={room.id}>
                <button
                  onClick={() => openRoom(room)}
                  className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
                >
                  <Avatar title={title} />
                  <div className="flex-1 min-w-0 pb-[10px] -mb-[10px]" style={{ borderBottom: `1px solid ${LINE}` }}>
                    <div className="flex items-baseline gap-2">
                      <span className={`flex-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>{title}</span>
                      <span className="text-[11px] shrink-0" style={{ color: unread ? GOLD : MUTED }}>
                        {listTimeLabel(room.last_message?.created_at ?? room.updated_at)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-[2px]">
                      <span className={`flex-1 text-[13px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                        {previewText(room, handle || '')}
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
          })}
        </ul>
      </div>

      {composing && <NewChat onOpen={openDirect} onClose={() => setComposing(false)} />}
      {open && handle && (
        <Conversation
          client={client}
          room={open}
          me={handle}
          online={online}
          onAuthLost={authLost}
          onBack={() => {
            setOpen(null);
            refresh();
          }}
        />
      )}
    </div>
  );
};

export default ChatPage;
