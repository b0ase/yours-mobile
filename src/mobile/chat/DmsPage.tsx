import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle, Plus, Search, Users, WifiOff, X } from 'lucide-react';
import { isBlocked, onUgcChange } from '../ugc/ugc';
import { syncBlocks } from '../ugc/blocks';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { PullToRefresh } from '../ui/PullToRefresh';
import { SegmentRow, SegmentTitle } from '../feed/ChatSegments';
import { loadFollows } from '../feed/store';
import { getFriends, onFriends, refreshFriends } from '../calls/friends';
import { onDmRequest, onRoomTicker, takeDmRequest, takeRoomTicker } from './segmentNav';
import { BchatClient, ChatApiError, needsHandle, saveSession } from './api';
import { dmsCacheKey, fetchRooms, onRooms, sharedChatClient } from './sharedRooms';
import { readListCache } from '../ui/listCache';
import { afterPaint } from '../ui/afterPaint';
import { useInPeek } from '../phone/pageEl';
import { SkeletonRows } from './SkeletonRows';
import { HandleFlow } from '../names/HandleFlow';
import { walletSigner } from './signer';
import { listTimeLabel, previewText, roomActivity, roomTitle, type ChatRoom } from './messages';
import { ArchivedGroup, ChatSwipeRow, MutedMark, RowBadge, type RowCommands } from './ChatRowActions';
import { arrange, isMarked, isMuted, isPinned, roomKeyOf, setMarked, settle, useListPrefs } from './listPrefs';
import { Avatar, ContactRow, SourceBadges } from './ContactViews';
import { SOURCES_NOTE } from './contactSources';
import { LIST_TYPES, useLive } from './live';
import {
  canMessage,
  contactLine,
  dmRooms,
  filterContacts,
  mergeContacts,
  parseDmTarget,
  type BchatContact,
  type Contact,
} from './contacts';

/**
 * Chat › DMs: 1:1 conversations (bit-sign direct rooms) newest first, plus one Contacts list
 * merging bChat contacts, Calls friends and Feed follows. "New message" picks a contact or takes
 * a $handle / name@bwallet.space. The conversation view itself is ChatPage's, passed in.
 */
const GOLD = '#FFD24D';
const BG = '#010101';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const LIST_POLL_MS = 30_000;
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

export type DmConversationProps = {
  client: BchatClient;
  room: ChatRoom;
  me: string;
  online: boolean;
  onBack: () => void;
  onAuthLost: () => void;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Bottom sheet above the tab bar (z-[100]) and the conversation layer; Back closes it. */
const Sheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full rounded-t-3xl px-5 pt-4 flex flex-col"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          maxHeight: '85vh',
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3 shrink-0">
          <span className="text-white font-semibold">{title}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        <div className="overflow-y-auto min-h-0">{children}</div>
      </div>
    </div>,
    document.body,
  );
};

export const DmsPage = ({
  header,
  Conversation,
}: {
  header: ReactNode;
  Conversation: ComponentType<DmConversationProps>;
}) => {
  const { apiContext } = useServiceContext();
  // Hidden (phone pager peek): no list polling.
  const hidden = useInPeek();
  const client = useMemo(() => sharedChatClient(), []);
  const { chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [handle, setHandle] = useState<string | null>(client.handle);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState('');
  // Cache first, like the room list: the last DMs list shows at once (chat/sharedRooms.ts writes it).
  const [rooms, setRooms] = useState<ChatRoom[] | null>(() => readListCache<ChatRoom>(dmsCacheKey(identityAddress)));
  useEffect(() => onRooms(setRooms), []);
  const [listError, setListError] = useState('');
  const [bchatContacts, setBchatContacts] = useState<BchatContact[]>([]);
  const [friends, setFriends] = useState(getFriends());
  const [open, setOpen] = useState<ChatRoom | null>(null);
  const [sheet, setSheet] = useState<'new' | 'contacts' | null>(null);
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

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

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setAuthError('');
    try {
      const s = await client.signIn(walletSigner(apiContext));
      saveSession(s);
      setHandle(s.handle);
    } catch (e) {
      // A wallet bChat hasn't seen and no handle chosen yet: open Choose your handle right here.
      const need = needsHandle(e);
      if (need) setHandleClaim(need);
      else setAuthError(errText(e));
    } finally {
      setSigningIn(false);
    }
  }, [client, apiContext]);
  const [handleClaim, setHandleClaim] = useState<{ claimToken: string; address: string } | null>(null);
  // After the handle is chosen, finish the sign-in with bit-sign's claim token (falls back to a fresh
  // sign-in, which now finds the chosen name, if the token has expired).
  const finishClaim = useCallback(
    async (paymail: string) => {
      if (!handleClaim) return;
      const name = paymail.split('@')[0];
      const s = await client
        .claimHandle(handleClaim.claimToken, name, handleClaim.address)
        .catch(() => client.signIn(walletSigner(apiContext)));
      saveSession(s);
      setHandle(s.handle);
      setHandleClaim(null);
    },
    [client, apiContext, handleClaim],
  );

  const authLost = useCallback(() => {
    client.signOut();
    saveSession(null);
    setHandle(null);
    setOpen(null);
    setRooms(null);
  }, [client]);

  const refresh = useCallback(
    (force?: unknown) => {
      if (!handle || !online) return;
      fetchRooms(client, identityAddress, force === true ? 0 : undefined)
        .then(() => setListError(''))
        .catch((e) => {
          if (e instanceof ChatApiError && e.status === 401) return authLost();
          setListError(errText(e));
        });
      client
        .contacts()
        .then(setBchatContacts)
        .catch(() => undefined);
    },
    [client, handle, online, authLost, identityAddress],
  );

  useEffect(refresh, [refresh]);
  // Live (chat/live.ts): a room change re-reads the rooms list; the poll drops to 5 min while live.
  const listMs = useLive(
    () => {
      if (handle && online) void fetchRooms(client, identityAddress, 0).catch(() => undefined);
    },
    LIST_POLL_MS,
    { liveMs: 300_000, types: LIST_TYPES, enabled: !!handle && !open && !hidden },
  );
  useEffect(() => {
    if (!handle || open || hidden) return;
    const id = window.setInterval(() => document.visibilityState === 'visible' && refresh(), listMs);
    return () => window.clearInterval(id);
  }, [handle, open, hidden, refresh, listMs]);
  useEffect(() => {
    const off = onFriends(setFriends);
    void refreshFriends().catch(() => undefined);
    return off;
  }, []);

  // Blocked people's DMs are hidden (ugc/ugc.ts); the server also refuses new messages both ways.
  const [blockTick, setBlockTick] = useState(0);
  useEffect(() => onUgcChange(() => setBlockTick((n) => n + 1)), []);
  useEffect(() => {
    if (handle) return afterPaint(() => void syncBlocks(client));
  }, [client, handle]);
  const allDms = useMemo(
    () => (rooms ? dmRooms(rooms).filter((r) => !isBlocked(roomTitle(r, handle || ''))) : null),
    [rooms, handle, blockTick], // eslint-disable-line react-hooks/exhaustive-deps
  );
  // Telegram-style list (listPrefs.ts): pinned first, newest activity, archived in one group.
  const [prefs, updatePrefs] = useListPrefs(handle);
  const arranged = useMemo(
    () => (allDms ? arrange(allDms, prefs, (r) => roomKeyOf(r.ticker), roomActivity) : null),
    [allDms, prefs],
  );
  const dms = arranged?.main ?? null;
  useEffect(() => {
    if (arranged && (arranged.unarchive.length || arranged.unhide.length)) updatePrefs((p) => settle(p, arranged));
  }, [arranged, updatePrefs]);
  const openKey = open ? roomKeyOf(open.ticker) : null;
  useEffect(() => {
    if (openKey) updatePrefs((p) => (isMarked(p, openKey) ? setMarked(p, openKey, false) : p));
  }, [openKey, updatePrefs]);
  const rowCommands: RowCommands = {
    prefs,
    update: updatePrefs,
    markRead: (key) => {
      const r = (rooms ?? []).find((x) => roomKeyOf(x.ticker) === key);
      if (!r) return;
      setRooms((cur) => cur?.map((x) => (x.ticker === r.ticker ? { ...x, unread: 0 } : x)) ?? cur);
      void client.markRead(r.ticker).catch(() => {});
    },
  };
  const contacts = useMemo(
    () => mergeContacts(bchatContacts, friends, sheet ? loadFollows() : [], handle),
    [bchatContacts, friends, sheet, handle],
  );

  const message = async (target: string) => {
    setBusy(true);
    setProblem('');
    try {
      const ticker = await client.openDirect(target);
      const all = await fetchRooms(client, identityAddress, 0);
      const room = all.find((r) => r.ticker === ticker) ?? { id: ticker, ticker, name: null };
      setSheet(null);
      setInput('');
      setOpen(room);
    } catch (e) {
      if (e instanceof ChatApiError && e.status === 401) return authLost();
      setProblem(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const messageTyped = () => {
    const t = parseDmTarget(input);
    if (t.kind === 'invalid') return setProblem(t.reason);
    void message(t.handle);
  };

  const saveTyped = async () => {
    const t = parseDmTarget(input);
    if (t.kind === 'invalid') return setProblem(t.reason);
    try {
      await client.addContact(t.handle);
      setInput('');
      setProblem('');
      setBchatContacts(await client.contacts());
    } catch (e) {
      setProblem(errText(e));
    }
  };

  const remove = async (c: Contact) => {
    if (!c.bchatId) return;
    try {
      await client.removeContact(c.bchatId);
      setBchatContacts(await client.contacts());
    } catch (e) {
      setProblem(errText(e));
    }
  };

  // "Message" from Calls › Contacts / Favourites: open that DM once signed in.
  useEffect(() => {
    if (!handle) return;
    const take = () => {
      const h = takeDmRequest();
      if (h) void message(h);
    };
    take();
    return onDmRequest(take);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  // A tapped push notification (src/mobile/push): open this DM by its room ticker.
  useEffect(() => {
    if (!handle) return;
    const take = () => {
      const t = takeRoomTicker(true);
      if (!t) return;
      void fetchRooms(client, identityAddress)
        .then((all) => {
          setOpen(all.find((r) => r.ticker.toUpperCase() === t) ?? { id: t, ticker: t, name: null });
        })
        .catch((e) => {
          if (e instanceof ChatApiError && e.status === 401) authLost();
        });
    };
    take();
    return onRoomTicker(take);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  const renderDm = (r: ChatRoom) => {
    const title = roomTitle(r, handle || '');
    const unread = r.unread ?? 0;
    const key = roomKeyOf(r.ticker);
    const muted = isMuted(prefs, key);
    return (
      <li key={r.id}>
        <ChatSwipeRow row={{ key, ticker: r.ticker, title, at: roomActivity(r), unread }} commands={rowCommands}>
          <button
            onClick={() => setOpen(r)}
            className="w-full flex items-center gap-3 px-4 py-[10px] text-left active:bg-[#111]"
            style={{ background: BG }}
          >
            <Avatar title={title} />
            <div className="flex-1 min-w-0 pb-[10px] -mb-[10px]" style={{ borderBottom: `1px solid ${LINE}` }}>
              <div className="flex items-baseline gap-2">
                <span className={`flex-1 flex items-center gap-1 text-[15px] font-semibold text-white ${ELLIPSIS}`}>
                  <span className={ELLIPSIS}>{title}</span>
                  <MutedMark muted={muted} />
                </span>
                <span className="text-[11px] shrink-0" style={{ color: unread && !muted ? GOLD : MUTED }}>
                  {listTimeLabel(r.last_message?.created_at ?? r.updated_at)}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-[2px] min-h-5">
                <span className={`flex-1 text-[13px] ${ELLIPSIS}`} style={{ color: MUTED }}>
                  {previewText(r, handle || '')}
                </span>
                <RowBadge unread={unread} marked={isMarked(prefs, key)} muted={muted} pinned={isPinned(prefs, key)} />
              </div>
            </div>
          </button>
        </ChatSwipeRow>
      </li>
    );
  };

  const shownContacts = filterContacts(contacts, sheet === 'new' ? input : query);

  return (
    <div
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
      style={{ height: '100%', background: BG }}
    >
      <PullToRefresh onRefresh={refresh} disabled={!handle} />
      <TopNav />
      <div className="w-full pt-16 flex flex-col">
        <SegmentRow>{header}</SegmentRow>
        <SegmentTitle title="DMs">
          {handle && (
            <>
              <button onClick={() => setSheet('contacts')} className="p-2 rounded-full" aria-label="Contacts">
                <Users size={20} color={GOLD} />
              </button>
              <button onClick={() => setSheet('new')} className="p-2 rounded-full" aria-label="New message">
                <Plus size={22} color={GOLD} />
              </button>
            </>
          )}
        </SegmentTitle>

        {!online && (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
            style={{ background: '#1a1408', color: '#e6c76a' }}
          >
            <WifiOff size={14} /> You're offline. Messages will refresh when you reconnect.
          </div>
        )}

        {!handle && (
          <div className="px-6 pt-16 flex flex-col items-center text-center gap-3">
            <MessageCircle size={28} color={GOLD} />
            <h2 className="text-lg font-bold text-white">Direct messages</h2>
            <p className="text-xs" style={{ color: MUTED }}>
              Private 1:1 chats on bChat. Signs in with this wallet's identity key — no password.
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
            {handleClaim && <HandleFlow onClose={() => setHandleClaim(null)} onClaimed={finishClaim} />}
          </div>
        )}

        {handle && dms === null && !listError && <SkeletonRows label="Loading messages" />}
        {handle && listError && dms === null && (
          <div className="text-center text-xs pt-10 text-[#F97066]">
            {listError}
            <div>
              <button onClick={refresh} className="mt-3 underline" style={{ color: GOLD }}>
                Try again
              </button>
            </div>
          </div>
        )}
        {handle && dms && dms.length === 0 && !arranged?.archived.length && (
          <div className="px-8 pt-14 text-center">
            <p className="text-sm text-white font-semibold">No messages yet</p>
            <p className="text-xs mt-1" style={{ color: MUTED }}>
              Message a contact, a $handle or a name@bwalletx.com.
            </p>
            <button
              onClick={() => setSheet('new')}
              className="mt-4 rounded-2xl px-5 py-2 text-sm font-bold inline-flex items-center gap-2"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <Plus size={15} /> New message
            </button>
          </div>
        )}

        <ul className="w-full">
          {arranged && (
            <ArchivedGroup
              identity={handle || ''}
              count={arranged.archived.length}
              unread={arranged.archived.reduce((n, r) => n + (r.unread ?? 0), 0)}
            >
              {arranged.archived.map(renderDm)}
            </ArchivedGroup>
          )}
          {(dms ?? []).map(renderDm)}
        </ul>
      </div>

      {sheet === 'new' && (
        <Sheet title="New message" onClose={() => setSheet(null)}>
          <div
            className="flex items-center gap-2 rounded-xl px-3"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <Search size={15} color={MUTED} />
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setProblem('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && messageTyped()}
              placeholder="$handle, name@bwalletx.com or a contact"
              autoCapitalize="none"
              autoCorrect="off"
              className="flex-1 bg-transparent py-2 text-sm text-white outline-none"
            />
          </div>
          <div className="flex gap-2 mt-2">
            <button
              onClick={messageTyped}
              disabled={busy || !input.trim()}
              className="flex-1 rounded-xl py-2 text-sm font-bold disabled:opacity-40"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {busy ? 'Opening…' : 'Message'}
            </button>
            <button
              onClick={() => void saveTyped()}
              disabled={busy || !input.trim()}
              className="rounded-xl px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
              style={{ background: PANEL }}
            >
              Save contact
            </button>
          </div>
          {problem && <p className="text-xs mt-2 text-[#F97066]">{problem}</p>}
          <ul className="mt-2">
            {shownContacts.filter(canMessage).map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => c.handle && void message(c.handle)}
                  disabled={busy}
                  className="w-full flex items-center gap-3 py-2 text-left"
                >
                  <Avatar title={c.name} src={c.avatar} size={36} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-[14px] text-white ${ELLIPSIS}`}>{c.name}</div>
                    <div className="text-[11px]" style={{ color: MUTED }}>
                      {contactLine(c)}
                    </div>
                  </div>
                  <SourceBadges c={c} />
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {sheet === 'contacts' && (
        <Sheet title="Contacts" onClose={() => setSheet(null)}>
          <div
            className="flex items-center gap-2 rounded-xl px-3"
            style={{ background: PANEL, border: `1px solid ${LINE}` }}
          >
            <Search size={15} color={MUTED} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search contacts"
              className="flex-1 bg-transparent py-2 text-sm text-white outline-none"
            />
          </div>
          {problem && <p className="text-xs mt-2 text-[#F97066]">{problem}</p>}
          {contacts.length === 0 && (
            <p className="text-xs mt-4 text-center" style={{ color: MUTED }}>
              No contacts yet. People you follow in Feed, your Calls friends and bChat contacts appear here.
            </p>
          )}
          <ul className="mt-1">
            {shownContacts.map((c) => (
              <ContactRow
                key={c.id}
                c={c}
                busy={busy}
                onMessage={(x) => x.handle && void message(x.handle)}
                onRemove={(x) => void remove(x)}
              />
            ))}
          </ul>
          <div className="mt-4 text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>
            Other friend lists
          </div>
          <ul>
            {SOURCES_NOTE.map((s) => (
              <li key={s.name} className="py-2 text-[12px]" style={{ borderBottom: `1px solid ${LINE}` }}>
                <span className="text-white font-semibold">{s.name}</span>
                <span style={{ color: MUTED }}> — {s.note}</span>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      {open && handle && (
        <Conversation
          client={client}
          room={open}
          me={handle}
          online={online}
          onAuthLost={authLost}
          onBack={() => {
            setOpen(null);
            refresh(true);
          }}
        />
      )}
    </div>
  );
};
