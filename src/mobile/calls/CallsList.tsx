import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  Ban,
  Loader2,
  MessageCircle,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Trash2,
  UserPlus,
  Video,
} from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { bareName } from '../names/names';
import { requestDm } from '../chat/segmentNav';
import { useContacts } from '../chat/useContacts';
import { Avatar, ContactRow, SourceBadges } from '../chat/ContactViews';
import { filterContacts, type Contact } from '../chat/contacts';
import { resolveCallee } from './peer';
import { blockCaller, dial, listBlocked, unblockCaller } from './store';
import { useCalls } from './useCalls';
import { busy, formatDuration, shortKey, type ServerCall } from './machine';
import type { BlockEntry } from './api';
import { addFriend, isFriend, refreshFriends } from './friends';
import {
  asFavourite,
  dialSuggestions,
  isFavourite,
  isMissed,
  loadFavourites,
  loadHidden,
  parseDial,
  PHONE_TABS,
  saveFavourites,
  saveHidden,
  toggleFavourite,
  visibleRecents,
  type Favourite,
  type PhoneTab,
  type RecentsFilter,
} from './phone';

const GOLD = '#F5B800';
const CLIP = 'overflow-hidden text-ellipsis whitespace-nowrap';

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

const Pill = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) => (
  <button
    onClick={onClick}
    className="flex-1 rounded-full px-2 py-[6px] text-[12px] font-bold"
    style={on ? { background: GOLD, color: '#1a1300' } : { color: '#8a8f98' }}
  >
    {children}
  </button>
);

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
    <div className="flex items-center gap-3 py-3 border-b border-[#1f2127]" {...hold}>
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

/**
 * Calls as a phone: Favourites | Recents | Contacts | Dial (calls/phone.ts). Used by the Chat
 * tab's Calls segment (feed/ChatSegments.tsx) and by the phone sheet in the top bar, which passes
 * `onLeave` so Message / Pay can close it on their way to another tab.
 */
export const CallsList = ({ onLeave }: { onLeave?: () => void } = {}) => {
  const { recent, ready, error, call } = useCalls();
  const { chromeStorageService } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const owner = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? 'default';
  const contacts = useContacts();
  const [favs, setFavs] = useState<Favourite[]>(() => loadFavourites(owner));
  const [hidden, setHidden] = useState<Set<string>>(() => loadHidden(owner));
  const [tab, setTab] = useState<PhoneTab>(() => (loadFavourites(owner).length ? 'favourites' : 'recents'));
  const [filter, setFilter] = useState<RecentsFilter>('all');
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [problem, setProblem] = useState('');
  const [blocks, setBlocks] = useState<BlockEntry[] | null>(null);
  const [showBlocks, setShowBlocks] = useState(false);
  const [editing, setEditing] = useState(false);
  const inCall = busy(call);

  useEffect(() => {
    setFavs(loadFavourites(owner));
    setHidden(loadHidden(owner));
  }, [owner]);
  useEffect(() => {
    if (ready) void refreshFriends().catch(() => undefined);
  }, [ready]);
  useEffect(() => {
    if (showBlocks)
      void listBlocked()
        .then(setBlocks)
        .catch(() => setBlocks([]));
  }, [showBlocks]);

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
    const label = c.peer_label ?? shortKey(c.peer_key);
    // A label we placed (outgoing) we resolved ourselves; an incoming claim is not verified.
    void dial({
      key: c.peer_key,
      label: c.direction === 'outgoing' ? label : shortKey(c.peer_key),
      verified: c.direction === 'outgoing',
    });
  };
  const block = async (c: ServerCall) => {
    await blockCaller(c.peer_key, c.peer_label ?? undefined).catch((e) => setProblem(String(e?.message ?? e)));
    if (showBlocks) setBlocks(await listBlocked());
  };

  const recents = useMemo(() => visibleRecents(recent, filter, hidden), [recent, filter, hidden]);
  const suggestions = useMemo(() => dialSuggestions(contacts, input), [contacts, input]);

  return (
    <div className="w-full px-4 flex flex-col gap-3">
      <div role="tablist" className="flex rounded-full p-[3px] bg-[#121316] border border-[#1f2127]">
        {PHONE_TABS.map((t) => (
          <Pill
            key={t.id}
            on={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setEditing(false);
              setProblem('');
            }}
          >
            {t.label}
          </Pill>
        ))}
      </div>
      {problem && <p className="text-xs text-[#ff6b6b]">{problem}</p>}
      {inCall && <p className="text-xs text-[#98A2B3]">You are on a call.</p>}

      {tab === 'favourites' && (
        <div className="flex flex-col">
          {favs.length > 0 && (
            <button className="self-end text-xs text-[#8a8f98] underline" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
          {favs.length === 0 && (
            <p className="text-sm text-[#98A2B3] text-center py-8">
              No favourites yet. Star someone in Contacts to pin them here.
            </p>
          )}
          {favs.map((f) => (
            <div key={f.id} className="flex items-center gap-3 py-2 border-b border-[#1f2127]">
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
                    <button aria-label={`Message ${f.name}`} className="p-2" onClick={() => message(f.handle!)}>
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
        </div>
      )}

      {tab === 'recents' && (
        <>
          <div className="flex items-center gap-2">
            <div className="flex w-40 rounded-full p-[3px] bg-[#121316] border border-[#1f2127]">
              <Pill on={filter === 'all'} onClick={() => setFilter('all')}>
                All
              </Pill>
              <Pill on={filter === 'missed'} onClick={() => setFilter('missed')}>
                Missed
              </Pill>
            </div>
            <span className="flex-1" />
            <button className="text-xs text-[#8a8f98] underline" onClick={() => setShowBlocks((v) => !v)}>
              {showBlocks ? 'Hide blocked' : 'Blocked'}
            </button>
            <button className="text-xs text-[#8a8f98] underline" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Done' : 'Edit'}
            </button>
          </div>

          {showBlocks && (
            <div className="rounded-xl border border-[#2b2f36] p-2">
              {blocks === null ? (
                <Loader2 size={16} className="animate-spin" color="#98A2B3" />
              ) : blocks.length === 0 ? (
                <p className="text-xs text-[#98A2B3] px-1">Nobody blocked.</p>
              ) : (
                blocks.map((b) => (
                  <div key={b.key} className="flex items-center justify-between px-1 py-2">
                    <span className={`text-sm text-white ${CLIP}`}>
                      {b.label ? bareName(b.label) : shortKey(b.key)}
                    </span>
                    <button
                      className="text-xs text-[#F5B800]"
                      onClick={async () => {
                        await unblockCaller(b.key).catch(() => undefined);
                        setBlocks(await listBlocked());
                      }}
                    >
                      Unblock
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {!ready && !error && (
            <div className="flex justify-center py-8">
              <Loader2 size={20} className="animate-spin" color="#98A2B3" />
            </div>
          )}
          {error && !ready && <p className="text-xs text-[#ff6b6b]">Calls unavailable: {error}</p>}
          {ready && recents.length === 0 && (
            <p className="text-sm text-[#98A2B3] text-center py-8">
              {filter === 'missed' ? 'No missed calls.' : 'No calls yet. Use Dial to call a bWallet user by name.'}
            </p>
          )}
          <div className="flex flex-col">
            {recents.map((c) => (
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
            ))}
          </div>
          {recents.length > 0 && (
            <p className="text-[10px] text-[#5b6069] text-center">Hold a call to delete it from this device.</p>
          )}
        </>
      )}

      {tab === 'contacts' && (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search contacts"
            className="rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none"
          />
          {contacts.length === 0 && (
            <p className="text-sm text-[#98A2B3] text-center py-8">
              No contacts yet. Calls friends, people you follow in Feed and bChat contacts appear here.
            </p>
          )}
          <ul>
            {filterContacts(contacts, query).map((c) => (
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
            ))}
          </ul>
        </>
      )}

      {tab === 'dial' && (
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
              autoCapitalize="none"
              autoCorrect="off"
              className="flex-1 min-w-0 rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-3 text-sm text-white outline-none"
            />
            <button
              onClick={() => void callName()}
              disabled={!input.trim() || resolving || inCall}
              aria-label="Call"
              className="w-12 rounded-xl flex items-center justify-center disabled:opacity-40"
              style={{ background: GOLD }}
            >
              {resolving ? (
                <Loader2 size={18} className="animate-spin" color="#1a1300" />
              ) : (
                <Phone size={18} color="#1a1300" />
              )}
            </button>
            <button
              onClick={() => void callName(true)}
              disabled={!input.trim() || resolving || inCall}
              aria-label="Video call"
              className="w-12 rounded-xl flex items-center justify-center border border-[#2b2f36] disabled:opacity-40"
            >
              <Video size={18} color={GOLD} />
            </button>
            <button
              onClick={() => void addName()}
              disabled={!input.trim() || resolving}
              aria-label="Add to friends"
              className="w-12 rounded-xl flex items-center justify-center border border-[#2b2f36] disabled:opacity-40"
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
              <Phone size={15} color={GOLD} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default CallsList;
