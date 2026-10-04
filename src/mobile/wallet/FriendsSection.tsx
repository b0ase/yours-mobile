import { useEffect, useState } from 'react';
import { getBsv21Balances, type Bsv21Balance } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { FriendToken } from './FriendToken';
import { UserPlus } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { requestDm } from '../chat/segmentNav';
import { useContacts } from '../chat/useContacts';
import { ContactRow } from '../chat/ContactViews';
import { filterContacts } from '../chat/contacts';
import { resolveCallee } from '../calls/peer';
import { addFriend } from '../calls/friends';

const f = (u: string, i?: RequestInit) => fetch(u, i);

/**
 * Wallet › Friends (owner, 4 Oct 2026): the one address book (Calls friends, bChat contacts, Feed
 * follows, merged in chat/contacts.ts) with Message · Call · Pay. A friend needs only a name or
 * paymail; a token or room is optional.
 */
export const FriendsSection = () => {
  const contacts = useContacts();
  const { apiContext } = useServiceContext();
  const [held, setHeld] = useState<Bsv21Balance[]>([]);
  useEffect(() => {
    void getBsv21Balances
      .execute(apiContext, {})
      .then(setHeld)
      .catch(() => undefined);
  }, [apiContext]);
  const { handleSelect } = useBottomMenu();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const add = async () => {
    const raw = adding.trim();
    if (!raw) return;
    setBusy(true);
    setMsg('');
    try {
      const peer = await resolveCallee(f, raw);
      await addFriend({ key: peer.key, name: peer.label });
      setAdding('');
      setMsg(`${peer.label} added.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not add that name');
    } finally {
      setBusy(false);
    }
  };

  const shown = filterContacts(contacts, query);
  return (
    <div className="w-[92%] mx-auto flex flex-col gap-3 pb-6">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void add();
        }}
      >
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="Add a friend: name or paymail"
          className="flex-1 min-w-0 rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none"
          autoCapitalize="none"
          autoCorrect="off"
        />
        <button
          type="submit"
          disabled={busy || !adding.trim()}
          aria-label="Add friend"
          className="shrink-0 w-10 rounded-xl border-0 flex items-center justify-center"
          style={{ background: '#F5B800', color: '#000', opacity: busy || !adding.trim() ? 0.4 : 1 }}
        >
          <UserPlus size={16} />
        </button>
      </form>
      {msg && (
        <p className="text-xs m-0" style={{ color: '#98A2B3' }}>
          {msg}
        </p>
      )}
      {contacts.length > 6 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search friends"
          className="rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none"
        />
      )}
      {contacts.length === 0 ? (
        <p className="text-sm text-center py-8 m-0" style={{ color: '#98A2B3' }}>
          No friends yet. Add someone by their name or paymail. People you call, chat with or follow show up here too.
        </p>
      ) : (
        <ul className="m-0 p-0 list-none">
          {shown.map((c) => (
            <ContactRow
              key={c.id}
              c={c}
              busy={false}
              onRemove={null}
              extra={<FriendToken c={c} held={held} />}
              onMessage={(x) => {
                if (!x.handle) return;
                requestDm(x.handle);
                handleSelect(asMenuItem('chat'));
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
