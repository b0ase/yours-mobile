import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Grid3x3,
  Loader2,
  MessageCircle,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Search,
  Star,
  Store,
  Trash2,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { PAID_CALLS_ENABLED } from '../storeBuild';
import { asMenuItem } from '../tabs/tabs';
import { bareName } from '../names/names';
import { requestDm } from '../chat/segmentNav';
import { useContacts } from '../chat/useContacts';
import { Avatar, ContactRow, SourceBadges } from '../chat/ContactViews';
import { type Contact } from '../chat/contacts';
import { resolveCallee, verifyCaller } from './peer';
import { blockCaller, dial, listBlocked, unblockCaller } from './store';
import { useCalls } from './useCalls';
import { busy, formatDuration, isShortKey, shortKey, type ServerCall } from './machine';
import type { BlockEntry } from './api';
import { fetchDirectory, loadMyProfile, type PeerBPhone } from './bphone';
import { rateShort, type BPhoneProfile } from './rateCard';
import { addFriend, isFriend, refreshFriends } from './friends';
import {
  asFavourite,
  dialSuggestions,
  isFavourite,
  isMissed,
  loadFavourites,
  loadHidden,
  parseDial,
  phoneTabsFor,
  RECENTS_FILTERS,
  searchCalls,
  searchEmpty,
  saveFavourites,
  saveHidden,
  toggleFavourite,
  visibleRecents,
  type Favourite,
  type PhoneTab,
  type RecentsFilter,
} from './phone';

const GOLD = '#F5B800';
const GREEN = '#22c55e';
const CLIP = 'overflow-hidden text-ellipsis whitespace-nowrap';
// bPhone screens are bWalletX only: the store bundle carries neither (Rollup drops the dead branch).
const BPhoneSettings = PAID_CALLS_ENABLED ? lazy(() => import('./BPhoneSettings')) : null;
const Directory = PAID_CALLS_ENABLED ? lazy(() => import('./Directory')) : null;
const TABS = phoneTabsFor(PAID_CALLS_ENABLED);

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const describe = (c: ServerCall) => {
  if (c.status === 'ended' && c.answered_at && c.ended_at) {
    return formatDuration(Date.parse(c.ended_at) - Date.parse(c.answered_at));
  }
  if (c.status === 'missed' || (c.direction === 'incoming' && c.status === 'cancelled')) return 'Missed';
  if (c.status === 'declined') return 'Declined';
  if (c.status === 'cancelled') return 'Cancelled';
  if (c.status === 'ringing') return 'Ringing';
  if (c.status === 'active') return 'In progress';
  return 'Ended';
};

const Icon = ({ c }: { c: ServerCall }) => {
  if (isMissed(c)) return <PhoneMissed size={16} color="#ff6b6b" />;
  return c.direction === 'incoming' ? (
    <PhoneIncoming size={16} color="#98A2B3" />
  ) : (
    <PhoneOutgoing size={16} color="#98A2B3" />
  );
};

/** Press-and-hold (or right-click) on a row. */
const useLongPress = (fn: () => void, ms = 550) => {
  const t = useRef<number | null>(null);
  const clear = () => {
    if (t.current !== null) window.clearTimeout(t.current);
    t.current = null;
  };
  return {
    onTouchStart: () => {
      clear();
      t.current = window.setTimeout(fn, ms);
    },
    onTouchEnd: clear,
    onTouchMove: clear,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      fn();
    },
  };
};

const RecentRow = ({
  c,
  name,
  inCall,
  editing,
  onCall,
  onDelete,
  onAdd,
  onBlock,
}: {
  c: ServerCall;
  name: string;
  inCall: boolean;
  editing: boolean;
  onCall: () => void;
  onDelete: () => void;
  onAdd: (() => void) | null;
  onBlock: (() => void) | null;
}) => {
  const hold = useLongPress(onDelete);
  return (
    <div className="bw-mail-card flex items-center gap-3 px-3 py-2 mb-2 min-h-[56px]" {...hold}>
      {editing ? (
        <button aria-label="Delete from recents" className="p-1" onClick={onDelete}>
          <Trash2 size={16} color="#ff6b6b" />
        </button>
      ) : (
        <Icon c={c} />
      )}
      <button className="flex-1 min-w-0 text-left" onClick={onCall} disabled={inCall || editing}>
        <div className={`text-sm font-semibold ${CLIP} ${isMissed(c) ? 'text-[#ff6b6b]' : 'text-white'}`}>{name}</div>
        <div className="text-[11px] text-[#98A2B3]">
          {c.direction === 'incoming' ? 'Incoming' : 'Outgoing'} · {describe(c)} · {when(c.created_at)}
        </div>
      </button>
      {!editing && onAdd && (
        <button aria-label="Add to friends" className="p-2" onClick={onAdd}>
          <UserPlus size={15} color="#8a8f98" />
        </button>
      )}
      {!editing && onBlock && (
        <button aria-label="Block caller" className="p-2" onClick={onBlock}>
          <Ban size={15} color="#8a8f98" />
        </button>
      )}
      {!editing && (
        <button aria-label="Call back" className="p-2" onClick={onCall} disabled={inCall}>
          <Phone size={16} color={GOLD} />
        </button>
      )}
    </div>
  );
};

/** The yellow card on top: my own bPhone rate and whether I'm listed. Opens bPhone settings. */
const BPhoneCard = ({ profile, onOpen }: { profile: BPhoneProfile | null; onOpen: () => void }) => {
  const rate = profile?.rate ?? null;
  const listed = !!profile?.listing.listed;
  return (
    <button
      onClick={onOpen}
      aria-label="bPhone settings"
      className="bw-mail-card bw-mail-hero w-full px-4 py-4 flex items-center gap-3 text-left text-white"
    >
      <span
        className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
        style={{ background: 'rgba(255,210,77,0.12)', border: '1px solid rgba(255,210,77,0.35)' }}
      >
        <Phone size={17} color={GOLD} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[11px] font-bold uppercase tracking-[0.08em] text-[#98A2B3]">bPhone</span>
        <span className={`block text-[17px] font-bold ${CLIP}`} style={{ color: GOLD }}>
          {profile === null ? 'Loading…' : rate ? `Your rate: ${rateShort(rate)}` : 'Free calls · set a price'}
        </span>
      </span>
      {rate && (
        <span
          className="shrink-0 rounded-full px-2 py-[3px] text-[11px] font-bold flex items-center gap-1"
          style={{ background: 'rgba(0,0,0,0.45)', color: listed ? GREEN : '#a3a8b1' }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: listed ? GREEN : '#5b6069' }} />
          {listed ? 'On' : 'Off'}
        </span>
      )}
      <ChevronRight size={18} className="shrink-0 opacity-70" />
    </button>
  );
};

const GroupTitle = ({ children }: { children: ReactNode }) => (
  <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#6b7079] pt-2 pb-1">{children}</div>
);

const TAB_ICON = { recents: Clock, contacts: Users, services: Store, keypad: Grid3x3 } as const;

/** The bottom tab bar inside Calls. Keypad is the green round button on the far right. */
const TabBar = ({ tab, onTab }: { tab: PhoneTab; onTab: (t: PhoneTab) => void }) => (
  <nav
    role="tablist"
    aria-label="Calls"
    className="bw-mail-bar shrink-0 -mx-4 px-4 pt-2 pb-2 flex items-center gap-1 border-t border-[#1f2127]"
  >
    {TABS.map((t) => {
      const I = TAB_ICON[t.id];
      const on = tab === t.id;
      if (t.id === 'keypad')
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            aria-label="Keypad"
            onClick={() => onTab(t.id)}
            className="shrink-0 ml-1 w-12 h-12 rounded-full flex items-center justify-center"
            style={{
              background: GREEN,
              boxShadow: on ? `0 0 0 3px rgba(34,197,94,0.3)` : '0 4px 14px rgba(34,197,94,0.25)',
            }}
          >
            <I size={20} color="#04210f" />
          </button>
        );
      return (
        <button
          key={t.id}
          role="tab"
          aria-selected={on}
          onClick={() => onTab(t.id)}
          className="flex-1 min-w-0 flex flex-col items-center gap-[2px] py-1"
          style={{ color: on ? GOLD : '#6b7079' }}
        >
          <I size={19} />
          <span className="text-[11px] font-semibold">{t.label}</span>
        </button>
      );
    })}
  </nav>
);

/**
 * Calls as a phone (calls/phone.ts): the bPhone card and one search box on top, then Recents |
 * Contacts | Services | Keypad from a bottom tab bar. Used by the Chat tab's Calls segment
 * (feed/ChatSegments.tsx) and by the phone sheet in the top bar, which passes `onLeave` so
 * Message / Pay can close it on their way to another tab. Store build: no card, no Services.
 */
/**
 * Fill from where the view starts down to the viewport bottom, less `bottomInset` (the app's
 * main nav + safe area), so the Calls tab bar always sits at the bottom, even for short lists.
 */
const useFillHeight = (bottomInset: string) => {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const scroller = el.parentElement?.closest('.overflow-y-auto') as HTMLElement | null;
      setTop(el.getBoundingClientRect().top + (scroller?.scrollTop ?? 0));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  return { ref, style: { height: `calc(100dvh - ${Math.round(top)}px - ${bottomInset})` } };
};

/** In the full-screen phone sheet (covers the main nav). */
const SHEET_INSET = 'calc(env(safe-area-inset-bottom, 0px) + 24px)';

export const CallsList = ({
  onLeave,
  bottomInset = SHEET_INSET,
}: { onLeave?: () => void; bottomInset?: string } = {}) => {
  const fill = useFillHeight(bottomInset);
  const { recent, ready, error, call } = useCalls();
  const { chromeStorageService, apiContext } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const owner = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? 'default';
  const contacts = useContacts();
  const [favs, setFavs] = useState<Favourite[]>(() => loadFavourites(owner));
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(owner));
  const [tab, setTab] = useState<PhoneTab>('recents');
  const [filter, setFilter] = useState<RecentsFilter>('all');
  const [filterMenu, setFilterMenu] = useState(false);
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [problem, setProblem] = useState('');
  const [blocks, setBlocks] = useState<BlockEntry[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [settings, setSettings] = useState(false);
  const [mine, setMine] = useState<BPhoneProfile | null>(null);
  const [services, setServices] = useState<PeerBPhone[] | null>(null);
  const [servicesError, setServicesError] = useState('');
  const inCall = busy(call);
  const wallet = apiContext?.wallet;

  useEffect(() => {
    setFavs(loadFavourites(owner));
    setHidden(loadHidden(owner));
  }, [owner]);
  useEffect(() => {
    if (ready) void refreshFriends().catch(() => undefined);
  }, [ready]);
  useEffect(() => {
    if (filter === 'blocked')
      void listBlocked()
        .then(setBlocks)
        .catch(() => setBlocks([]));
  }, [filter]);
  // bPhone: my own card and the Services directory (bWalletX only; the store build never asks).
  useEffect(() => {
    if (!PAID_CALLS_ENABLED || !wallet || settings) return;
    let live = true;
    void (async () => {
      const { publicKey } = await wallet.getPublicKey({ identityKey: true });
      const p = await loadMyProfile((u, i) => fetch(u, i), publicKey.toLowerCase());
      if (live) setMine(p);
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet, settings]);
  useEffect(() => {
    if (!PAID_CALLS_ENABLED) return;
    let live = true;
    fetchDirectory((u, i) => fetch(u, i))
      .then((l) => live && setServices(l))
      .catch((e) => live && setServicesError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const setAndSaveFavs = (next: Favourite[]) => {
    setFavs(next);
    saveFavourites(owner, next);
  };
  const hide = (id: string) => {
    const next = new Set(hidden).add(id);
    setHidden(next);
    saveHidden(owner, next);
  };
  const message = (handle: string) => {
    requestDm(handle);
    handleSelect(asMenuItem('chat'));
    onLeave?.();
  };
  const callKey = (key: string, label: string, video = false) => {
    if (!inCall) void dial({ key, label, verified: true }, { video });
  };
  const switchTab = (t: PhoneTab) => {
    setTab(t);
    setEditing(false);
    setProblem('');
    setQuery('');
    setFilterMenu(false);
  };

  const resolveInput = async () => {
    const t = parseDial(input);
    if (t.kind === 'empty' || resolving) return null;
    if (t.kind === 'number') {
      setProblem(t.reason);
      return null;
    }
    setProblem('');
    setResolving(true);
    try {
      return await resolveCallee((u, i) => fetch(u, i), t.raw);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not find that name');
      return null;
    } finally {
      setResolving(false);
    }
  };
  const callName = async (video = false) => {
    const peer = await resolveInput();
    if (!peer) return;
    setInput('');
    void dial(peer, { video });
  };
  const addName = async () => {
    const peer = await resolveInput();
    if (!peer) return;
    try {
      await addFriend({ key: peer.key, name: peer.label });
      setInput('');
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not add the friend');
    }
  };

  const known = (key: string): Contact | undefined => contacts.find((x) => x.identityKey === key);
  const nameOf = (c: ServerCall) => bareName(known(c.peer_key)?.name ?? c.peer_label ?? shortKey(c.peer_key));
  const callBack = (c: ServerCall) => {
    if (inCall) return;
    const k = known(c.peer_key);
    if (k) return callKey(c.peer_key, k.name);
    // A label we placed (outgoing) we resolved ourselves. An incoming claim is checked (the name
    // must resolve to this key) so a call back shows the NAME, not "02cbe7…6ed8".
    if (c.direction === 'outgoing' && c.peer_label && !isShortKey(c.peer_label)) {
      void dial({ key: c.peer_key, label: c.peer_label, verified: true });
      return;
    }
    void verifyCaller((u, i) => fetch(u, i), c.peer_key, c.peer_label).then((peer) =>
      dial(peer.verified ? peer : { key: c.peer_key, label: shortKey(c.peer_key), verified: false }),
    );
  };
  const block = async (c: ServerCall) => {
    await blockCaller(c.peer_key, c.peer_label ?? undefined).catch((e) => setProblem(String(e?.message ?? e)));
    if (filter === 'blocked') setBlocks(await listBlocked());
  };

  const recents = useMemo(() => visibleRecents(recent, filter, hidden), [recent, filter, hidden]);
  const suggestions = useMemo(() => dialSuggestions(contacts, input), [contacts, input]);
  const results = useMemo(
    () =>
      searchCalls(query, {
        contacts,
        recents: visibleRecents(recent, 'all', hidden),
        services: PAID_CALLS_ENABLED ? (services ?? []) : [],
        nameOf,
      }),
    // nameOf reads contacts, already a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, contacts, recent, hidden, services],
  );
  const favIds = new Set(favs.map((f) => f.id));
  const spinner = <Loader2 size={20} className="animate-spin self-center" color="#98A2B3" />;

  const recentRow = (c: ServerCall) => (
    <RecentRow
      key={c.id}
      c={c}
      name={nameOf(c)}
      inCall={inCall}
      editing={editing}
      onCall={() => callBack(c)}
      onDelete={() => hide(c.id)}
      onAdd={
        isFriend(c.peer_key)
          ? null
          : () =>
              void addFriend({ key: c.peer_key, name: c.peer_label ?? shortKey(c.peer_key) }).catch((e) =>
                setProblem(e instanceof Error ? e.message : String(e)),
              )
      }
      onBlock={c.direction === 'incoming' ? () => void block(c) : null}
    />
  );
  const contactRow = (c: Contact) => (
    <ContactRow
      key={c.id}
      c={c}
      busy={false}
      onMessage={(x) => x.handle && message(x.handle)}
      onRemove={null}
      fav={{
        on: isFavourite(favs, c.id),
        toggle: () => setAndSaveFavs(toggleFavourite(favs, asFavourite(c))),
      }}
      onLeave={onLeave}
    />
  );

  if (settings && BPhoneSettings)
    return (
      <div className="w-full px-4 flex flex-col gap-3" style={{ paddingBottom: bottomInset }}>
        <button
          onClick={() => setSettings(false)}
          className="self-start flex items-center gap-1 text-[13px] font-semibold"
          style={{ color: GOLD }}
        >
          <ChevronLeft size={16} /> Calls
        </button>
        <Suspense fallback={spinner}>
          <BPhoneSettings onLeave={onLeave} />
        </Suspense>
      </div>
    );

  return (
    <div ref={fill.ref} className="w-full px-4 flex flex-col gap-3 min-h-0" style={fill.style}>
      {PAID_CALLS_ENABLED && <BPhoneCard profile={wallet ? mine : EMPTY_CARD} onOpen={() => setSettings(true)} />}

      <label className="bw-mail-seg flex items-center gap-2 rounded-xl px-3 py-2.5 min-h-[44px]">
        <Search size={16} color="#6b7079" className="shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={PAID_CALLS_ENABLED ? 'Search people and services' : 'Search people'}
          aria-label={PAID_CALLS_ENABLED ? 'Search people and services' : 'Search people'}
          autoCapitalize="none"
          autoCorrect="off"
          className="flex-1 min-w-0 bg-transparent text-sm text-white outline-none placeholder:text-[#6b7079]"
        />
        {query && (
          <button aria-label="Clear search" onClick={() => setQuery('')} className="p-0.5">
            <X size={15} color="#8a8f98" />
          </button>
        )}
      </label>

      {problem && <p className="text-xs text-[#ff6b6b]">{problem}</p>}
      {inCall && <p className="text-xs text-[#98A2B3]">You are on a call.</p>}

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden -mx-4 px-4 flex flex-col">
        {query.trim() ? (
          <div className="flex flex-col">
            {searchEmpty(results) && (
              <p className="text-sm text-[#98A2B3] text-center py-8">Nothing found for “{query.trim()}”.</p>
            )}
            {results.people.length > 0 && (
              <>
                <GroupTitle>People</GroupTitle>
                <ul>{results.people.map(contactRow)}</ul>
              </>
            )}
            {results.recents.length > 0 && (
              <>
                <GroupTitle>Recents</GroupTitle>
                {results.recents.map(recentRow)}
              </>
            )}
            {results.services.length > 0 && (
              <>
                <GroupTitle>Services</GroupTitle>
                {results.services.map((p) => {
                  const name = bareName(p.name ?? p.paymail ?? '') || p.key.slice(0, 10);
                  return (
                    <button
                      key={p.key}
                      className="bw-mail-card flex items-center gap-3 px-3 py-2 mb-2 text-left"
                      onClick={() => switchTab('services')}
                    >
                      <Avatar title={name} src={p.avatar} size={40} />
                      <span className="flex-1 min-w-0">
                        <span className={`block text-sm font-semibold text-white ${CLIP}`}>{name}</span>
                        <span className={`block text-[11px] text-[#98A2B3] ${CLIP}`}>{p.profile.listing.title}</span>
                      </span>
                      <span className="text-[13px] font-bold shrink-0" style={{ color: GOLD }}>
                        {p.profile.rate ? rateShort(p.profile.rate) : 'Free'}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        ) : (
          <>
            {tab === 'recents' && (
              <>
                <div className="relative flex items-center gap-2 pb-1">
                  <button
                    onClick={() => setFilterMenu((v) => !v)}
                    aria-haspopup="menu"
                    aria-expanded={filterMenu}
                    className="flex items-center gap-1 rounded-full px-3 py-[5px] text-[12px] font-semibold border border-[#2b2f36] text-white"
                  >
                    {RECENTS_FILTERS.find((x) => x.id === filter)?.label}
                    <ChevronDown size={14} color="#8a8f98" />
                  </button>
                  {filterMenu && (
                    <div
                      role="menu"
                      className="absolute left-0 top-full mt-1 z-20 w-36 rounded-xl border border-[#2b2f36] bg-[#17191E] py-1 shadow-xl"
                    >
                      {RECENTS_FILTERS.map((x) => (
                        <button
                          key={x.id}
                          role="menuitemradio"
                          aria-checked={filter === x.id}
                          onClick={() => {
                            setFilter(x.id);
                            setFilterMenu(false);
                            setEditing(false);
                          }}
                          className="w-full text-left px-3 py-2 text-[13px]"
                          style={{ color: filter === x.id ? GOLD : '#fff' }}
                        >
                          {x.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <span className="flex-1" />
                  {filter !== 'blocked' && recents.length > 0 && (
                    <button className="text-xs text-[#8a8f98] underline" onClick={() => setEditing((v) => !v)}>
                      {editing ? 'Done' : 'Edit'}
                    </button>
                  )}
                </div>

                {filter === 'blocked' ? (
                  blocks === null ? (
                    spinner
                  ) : blocks.length === 0 ? (
                    <p className="text-sm text-[#98A2B3] text-center py-8">Nobody blocked.</p>
                  ) : (
                    blocks.map((b) => (
                      <div key={b.key} className="bw-mail-card flex items-center justify-between px-3 py-3 mb-2">
                        <span className={`text-sm text-white ${CLIP}`}>
                          {b.label ? bareName(b.label) : shortKey(b.key)}
                        </span>
                        <button
                          className="text-xs font-semibold"
                          style={{ color: GOLD }}
                          onClick={async () => {
                            await unblockCaller(b.key).catch(() => undefined);
                            setBlocks(await listBlocked());
                          }}
                        >
                          Unblock
                        </button>
                      </div>
                    ))
                  )
                ) : (
                  <>
                    {!ready && !error && <div className="flex justify-center py-8">{spinner}</div>}
                    {error && !ready && <p className="text-xs text-[#ff6b6b]">Calls unavailable: {error}</p>}
                    {ready && recents.length === 0 && (
                      <p className="text-sm text-[#98A2B3] text-center py-8">
                        {filter === 'missed'
                          ? 'No missed calls.'
                          : 'No calls yet. Use the keypad to call a bWallet user by name.'}
                      </p>
                    )}
                    <div className="flex flex-col">{recents.map(recentRow)}</div>
                    {recents.length > 0 && (
                      <p className="text-[10px] text-[#5b6069] text-center pt-2">
                        Hold a call to delete it from this device.
                      </p>
                    )}
                  </>
                )}
              </>
            )}

            {tab === 'contacts' && (
              <>
                {favs.length > 0 && (
                  <>
                    <div className="flex items-center justify-between">
                      <GroupTitle>
                        <span className="inline-flex items-center gap-1">
                          <Star size={11} fill={GOLD} color={GOLD} /> Favourites
                        </span>
                      </GroupTitle>
                      <button className="text-xs text-[#8a8f98] underline" onClick={() => setEditing((v) => !v)}>
                        {editing ? 'Done' : 'Edit'}
                      </button>
                    </div>
                    {favs.map((f) => (
                      <div key={f.id} className="bw-mail-card flex items-center gap-3 px-3 py-2 mb-2">
                        <Avatar title={f.name} src={f.avatar} size={40} />
                        <button
                          className="flex-1 min-w-0 text-left"
                          disabled={editing || inCall || !f.identityKey}
                          onClick={() => f.identityKey && callKey(f.identityKey, f.name)}
                        >
                          <div className={`text-sm font-semibold text-white ${CLIP}`}>{bareName(f.name)}</div>
                          <div className="text-[11px] text-[#98A2B3]">{f.handle ? `$${f.handle}` : ''}</div>
                        </button>
                        {editing ? (
                          <button
                            aria-label={`Remove ${f.name} from favourites`}
                            className="p-2"
                            onClick={() => setAndSaveFavs(favs.filter((x) => x.id !== f.id))}
                          >
                            <Trash2 size={16} color="#ff6b6b" />
                          </button>
                        ) : (
                          <>
                            {f.handle && (
                              <button
                                aria-label={`Message ${f.name}`}
                                className="p-2"
                                onClick={() => message(f.handle!)}
                              >
                                <MessageCircle size={16} color={GOLD} />
                              </button>
                            )}
                            {f.identityKey && (
                              <button
                                aria-label={`Call ${f.name}`}
                                className="p-2"
                                disabled={inCall}
                                onClick={() => callKey(f.identityKey!, f.name)}
                              >
                                <Phone size={16} color={GOLD} />
                              </button>
                            )}
                            {f.identityKey && (
                              <button
                                aria-label={`Video call ${f.name}`}
                                className="p-2"
                                disabled={inCall}
                                onClick={() => callKey(f.identityKey!, f.name, true)}
                              >
                                <Video size={16} color={GOLD} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                    <GroupTitle>All contacts</GroupTitle>
                  </>
                )}
                {contacts.length === 0 && (
                  <p className="text-sm text-[#98A2B3] text-center py-8">
                    No contacts yet. Calls friends, people you follow in Feed and bChat contacts appear here. Star
                    someone to pin them to the top.
                  </p>
                )}
                <ul>{contacts.filter((c) => !favIds.has(c.id)).map(contactRow)}</ul>
              </>
            )}

            {tab === 'services' && Directory && (
              <Suspense fallback={spinner}>
                <Directory
                  list={services}
                  error={servicesError}
                  onListServices={() => setSettings(true)}
                  onLeave={onLeave}
                />
              </Suspense>
            )}

            {tab === 'keypad' && (
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <input
                    value={input}
                    onChange={(e) => {
                      setInput(e.target.value);
                      setProblem('');
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && void callName()}
                    placeholder="$handle, paymail, name or @number"
                    aria-label="Who to call"
                    autoCapitalize="none"
                    autoCorrect="off"
                    className="flex-1 min-w-0 rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-3 text-sm text-white outline-none"
                  />
                  <button
                    onClick={() => void callName()}
                    disabled={!input.trim() || resolving || inCall}
                    aria-label="Call"
                    className="w-12 shrink-0 rounded-xl flex items-center justify-center disabled:opacity-40"
                    style={{ background: GREEN }}
                  >
                    {resolving ? (
                      <Loader2 size={18} className="animate-spin" color="#04210f" />
                    ) : (
                      <Phone size={18} color="#04210f" />
                    )}
                  </button>
                  <button
                    onClick={() => void callName(true)}
                    disabled={!input.trim() || resolving || inCall}
                    aria-label="Video call"
                    className="w-12 shrink-0 rounded-xl flex items-center justify-center border border-[#2b2f36] disabled:opacity-40"
                  >
                    <Video size={18} color={GOLD} />
                  </button>
                  <button
                    onClick={() => void addName()}
                    disabled={!input.trim() || resolving}
                    aria-label="Add to friends"
                    className="w-12 shrink-0 rounded-xl flex items-center justify-center border border-[#2b2f36] disabled:opacity-40"
                  >
                    <UserPlus size={18} color={GOLD} />
                  </button>
                </div>
                {suggestions.map((c) => (
                  <button
                    key={c.id}
                    className="flex items-center gap-3 py-2 text-left"
                    disabled={inCall}
                    onClick={() => c.identityKey && callKey(c.identityKey, c.name)}
                  >
                    <Avatar title={c.name} src={c.avatar} size={36} />
                    <span className={`flex-1 min-w-0 text-sm text-white ${CLIP}`}>{bareName(c.name)}</span>
                    <SourceBadges c={c} />
                    <Phone size={15} color={GREEN} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <TabBar tab={tab} onTab={switchTab} />
    </div>
  );
};

/** No wallet unlocked yet (or a preview): show the free state rather than a spinner. */
const EMPTY_CARD: BPhoneProfile = {
  v: 1,
  rate: null,
  listing: { listed: false, title: '', about: '', category: 'other', hours: [], timezone: 'UTC', booking: false },
  updatedAt: 0,
};

export default CallsList;
