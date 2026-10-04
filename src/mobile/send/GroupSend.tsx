import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Users } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useContacts } from '../chat/useContacts';
import { filterContacts, type Contact } from '../chat/contacts';
import { Avatar } from '../chat/ContactViews';
import { destinationFor, parseRecipient, resolveRecipient } from '../names/names';

export type GroupRecipient = { id: string; address: string; amountInput: string };

/**
 * Group send (owner, 4 Oct 2026): blast a set number of tokens to many people. "Each gets N" fills
 * every recipient's amount; "Add friends" adds people from the address book; the running total
 * shows people × N against the balance and the parent disables Send when it doesn't fit.
 */
export const GroupSendBar = ({
  recipients,
  setRecipients,
  total,
  max,
  fmt,
  ticker,
  newRecipient,
}: {
  recipients: GroupRecipient[];
  setRecipients: (fn: (prev: GroupRecipient[]) => GroupRecipient[]) => void;
  /** Sum of every recipient's amount, in atomic units (null if any amount can't be read). */
  total: bigint | null;
  max: bigint;
  fmt: (atomic: bigint) => string;
  ticker: string;
  newRecipient: () => GroupRecipient;
}) => {
  const [each, setEach] = useState('');
  const [picking, setPicking] = useState(false);
  const people = recipients.filter((r) => r.address.trim()).length;
  const over = total !== null && total > max;

  const applyEach = (v: string) => {
    setEach(v);
    if (v) setRecipients((prev) => prev.map((r) => ({ ...r, amountInput: v })));
  };

  const [note, setNote] = useState('');
  // Tokens go to each person's ordinals address: resolve every paymail first (same lookup as NameInput).
  const addPeople = async (list: Contact[]) => {
    setPicking(false);
    setNote(`Looking up ${list.length}…`);
    const found: string[] = [];
    const missed: string[] = [];
    await Promise.all(
      list.map(async (c) => {
        try {
          if (c.paymail) {
            const d = destinationFor(await resolveRecipient((u, i) => fetch(u, i), parseRecipient(c.paymail)), 'token');
            if (d.ok) return void found.push(d.to);
          } else if (c.address) return void found.push(c.address);
        } catch {
          /* falls through to missed */
        }
        missed.push(c.name);
      }),
    );
    setRecipients((prev) => {
      const have = new Set(prev.map((r) => r.address.trim()));
      const base = prev.filter((r) => r.address.trim() || r.amountInput);
      const added = [...new Set(found)].filter((a) => !have.has(a)).map((a) => ({ ...newRecipient(), address: a, amountInput: each }));
      const next = [...base, ...added];
      return next.length ? next : prev;
    });
    setNote(missed.length ? `Added ${found.length}. Can't receive tokens: ${missed.join(', ')}.` : `Added ${found.length}.`);
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl p-3" style={{ background: '#101114', border: '1px solid #2b2f36' }}>
      <div className="flex items-center gap-2">
        <span className="text-xs shrink-0" style={{ color: '#98A2B3' }}>
          Each gets
        </span>
        <input
          value={each}
          onChange={(e) => applyEach(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          placeholder="amount"
          className="w-24 min-w-0 rounded-lg bg-[#17191E] border border-[#2b2f36] px-2 py-1.5 text-sm text-white outline-none"
        />
        <span className="text-xs" style={{ color: '#98A2B3' }}>
          ${ticker}
        </span>
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold border-0 cursor-pointer"
          style={{ background: '#F5B80022', color: '#F5B800' }}
        >
          <Users size={13} /> Add friends
        </button>
      </div>
      {total !== null && total > 0n && (
        <p className="text-xs m-0" style={{ color: over ? '#FDA29B' : '#98A2B3' }}>
          {people} {people === 1 ? 'person' : 'people'} · total {fmt(total)} of your {fmt(max)} ${ticker}
          {over ? ` — ${fmt(total - max)} short` : ''}
        </p>
      )}
      {note && (
        <p className="text-[11px] m-0" style={{ color: '#98A2B3' }}>
          {note}
        </p>
      )}
      {picking && <FriendPicker onClose={() => setPicking(false)} onAdd={(c) => void addPeople(c)} />}
    </div>
  );
};

const FriendPicker = ({ onClose, onAdd }: { onClose: () => void; onAdd: (c: Contact[]) => void }) => {
  useBackClose(true, onClose);
  const contacts = useContacts().filter((c) => c.paymail || c.address);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const shown = filterContacts(contacts, query);
  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button type="button" onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white flex-1">Add friends</span>
        <button
          type="button"
          disabled={!chosen.size}
          onClick={() => onAdd(contacts.filter((c) => chosen.has(c.id)))}
          className="mr-2 rounded-lg px-3 py-1.5 text-sm font-bold border-0"
          style={{ background: '#F5B800', color: '#000', opacity: chosen.size ? 1 : 0.4 }}
        >
          Add {chosen.size || ''}
        </button>
      </div>
      <div className="px-4 pb-10 overflow-y-auto flex flex-col gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search friends"
          className="rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2 text-sm text-white outline-none"
        />
        {contacts.length === 0 && (
          <p className="text-sm text-center py-8" style={{ color: '#98A2B3' }}>
            No friends with a paymail yet. Add some in Wallet › Friends.
          </p>
        )}
        <ul className="m-0 p-0 list-none">
          {shown.map((c) => {
            const on = chosen.has(c.id);
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => toggle(c.id)}
                  className="w-full flex items-center gap-3 py-2 bg-transparent border-0 text-left cursor-pointer"
                >
                  <Avatar title={c.name} src={c.avatar} size={36} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-white truncate">{c.name}</span>
                    <span className="block text-[11px] truncate" style={{ color: '#98A2B3' }}>
                      {c.paymail || c.address}
                    </span>
                  </span>
                  <span
                    className="w-6 h-6 rounded-full flex items-center justify-center"
                    style={{ background: on ? '#F5B800' : 'transparent', border: `1px solid ${on ? '#F5B800' : '#475467'}` }}
                  >
                    {on && <Check size={14} color="#000" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
};
