import { useEffect, useState } from 'react';
import { Ban, Loader2, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, UserPlus, X } from 'lucide-react';
import { resolveCallee } from './peer';
import { blockCaller, dial, listBlocked, unblockCaller } from './store';
import { useCalls } from './useCalls';
import { busy, formatDuration, shortKey, type ServerCall } from './machine';
import type { BlockEntry } from './api';
import { addFriend, getFriends, isFriend, onFriends, refreshFriends, removeFriend, type Friend } from './friends';

const GOLD = '#F5B800';

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
  const missed = c.direction === 'incoming' && !c.answered_at && c.status !== 'ringing';
  if (missed) return <PhoneMissed size={16} color="#ff6b6b" />;
  return c.direction === 'incoming' ? (
    <PhoneIncoming size={16} color="#98A2B3" />
  ) : (
    <PhoneOutgoing size={16} color="#98A2B3" />
  );
};

/**
 * Calls: "Call a name" + Friends (tap to call) + recent calls (tap to call back) + block list. Used by the Chat tab's
 * Calls segment (feed/ChatSegments.tsx) and by the phone sheet in the top bar.
 */
export const CallsList = () => {
  const { recent, ready, error, call } = useCalls();
  const [input, setInput] = useState('');
  const [resolving, setResolving] = useState(false);
  const [problem, setProblem] = useState('');
  const [blocks, setBlocks] = useState<BlockEntry[] | null>(null);
  const [showBlocks, setShowBlocks] = useState(false);
  const [friends, setFriends] = useState<Friend[]>(getFriends);
  const [editing, setEditing] = useState(false);
  const inCall = busy(call);

  useEffect(() => onFriends(setFriends), []);
  useEffect(() => {
    if (ready) void refreshFriends().catch(() => undefined);
  }, [ready]);

  useEffect(() => {
    if (showBlocks)
      void listBlocked()
        .then(setBlocks)
        .catch(() => setBlocks([]));
  }, [showBlocks]);

  const resolveInput = async () => {
    if (!input.trim() || resolving) return null;
    setProblem('');
    setResolving(true);
    try {
      return await resolveCallee((u, i) => fetch(u, i), input);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not find that name');
      return null;
    } finally {
      setResolving(false);
    }
  };

  const callName = async () => {
    const peer = await resolveInput();
    if (!peer) return;
    setInput('');
    void dial(peer);
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

  const callFriend = (f: Friend) => {
    if (!inCall) void dial({ key: f.key, label: f.name, verified: true });
  };

  const nameOf = (c: ServerCall) =>
    friends.find((f) => f.key === c.peer_key)?.name ?? c.peer_label ?? shortKey(c.peer_key);

  const callBack = (c: ServerCall) => {
    if (inCall) return;
    const friend = friends.find((f) => f.key === c.peer_key);
    if (friend) return callFriend(friend);
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

  return (
    <div className="w-full px-4 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void callName()}
            placeholder="Call a $handle, paymail or name"
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
            onClick={() => void addName()}
            disabled={!input.trim() || resolving}
            aria-label="Add to friends"
            className="w-12 rounded-xl flex items-center justify-center border border-[#2b2f36] disabled:opacity-40"
          >
            <UserPlus size={18} color={GOLD} />
          </button>
        </div>
        {problem && <p className="text-xs text-[#ff6b6b]">{problem}</p>}
        {inCall && <p className="text-xs text-[#98A2B3]">You are on a call.</p>}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[#8a8f98]">Friends</span>
        {friends.length > 0 && (
          <button className="text-xs text-[#8a8f98] underline" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
      </div>
      {friends.length === 0 ? (
        <p className="text-xs text-[#98A2B3]">Add friends by name above, or after a call.</p>
      ) : (
        <div className="flex flex-col">
          {friends.map((f) => (
            <div key={f.key} className="flex items-center gap-3 py-2">
              {f.avatar ? (
                <img src={f.avatar} alt="" className="w-9 h-9 rounded-full object-cover" />
              ) : (
                <div className="w-9 h-9 rounded-full bg-[#2b2f36] flex items-center justify-center text-sm font-bold text-white">
                  {f.name.replace(/^\$/, '').slice(0, 1).toUpperCase()}
                </div>
              )}
              <button className="flex-1 min-w-0 text-left" onClick={() => callFriend(f)} disabled={inCall || editing}>
                <div className="text-sm font-semibold text-white truncate">{f.name}</div>
                <div className="text-[11px] font-mono text-[#98A2B3]">{shortKey(f.key)}</div>
              </button>
              {editing ? (
                <button
                  aria-label={`Remove ${f.name}`}
                  className="p-2"
                  onClick={() => void removeFriend(f.key).catch(() => undefined)}
                >
                  <X size={16} color="#ff6b6b" />
                </button>
              ) : (
                <button aria-label={`Call ${f.name}`} className="p-2" onClick={() => callFriend(f)} disabled={inCall}>
                  <Phone size={16} color={GOLD} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[#8a8f98]">Recent</span>
        <button className="text-xs text-[#8a8f98] underline" onClick={() => setShowBlocks((v) => !v)}>
          {showBlocks ? 'Hide blocked' : 'Blocked callers'}
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
                <span className="text-sm text-white truncate">{b.label ?? shortKey(b.key)}</span>
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
      {ready && recent.length === 0 && (
        <p className="text-sm text-[#98A2B3] text-center py-8">No calls yet. Call a bWallet user by name above.</p>
      )}
      <div className="flex flex-col">
        {recent.map((c) => (
          <div key={c.id} className="flex items-center gap-3 py-3 border-b border-[#1f2127]">
            <Icon c={c} />
            <button className="flex-1 min-w-0 text-left" onClick={() => callBack(c)} disabled={inCall}>
              <div className="text-sm font-semibold text-white truncate">{nameOf(c)}</div>
              <div className="text-[11px] text-[#98A2B3]">
                {describe(c)} · {when(c.created_at)}
              </div>
            </button>
            {!isFriend(c.peer_key) && (
              <button
                aria-label="Add to friends"
                className="p-2"
                onClick={() =>
                  void addFriend({ key: c.peer_key, name: c.peer_label ?? shortKey(c.peer_key) }).catch((e) =>
                    setProblem(e instanceof Error ? e.message : String(e)),
                  )
                }
              >
                <UserPlus size={15} color="#8a8f98" />
              </button>
            )}
            {c.direction === 'incoming' && (
              <button aria-label="Block caller" className="p-2" onClick={() => void block(c)}>
                <Ban size={15} color="#8a8f98" />
              </button>
            )}
            <button aria-label="Call back" className="p-2" onClick={() => callBack(c)} disabled={inCall}>
              <Phone size={16} color={GOLD} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CallsList;
