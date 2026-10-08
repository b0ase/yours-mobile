import { useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Download, Plus, Search, Sparkles, Star, Terminal, X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useMenuAccounts, type MenuEntry } from './useMenuAccounts';
import { AccountRow } from './AccountSwitcher';
import { getPinned, getRecent, orderAccounts, togglePinned } from './accountMenu';

const MUTED = '#98A2B3';
const GOLD = '#F5B800';

/** Full-height sheet over the drawer. */
const FullSheet = ({
  title,
  icon,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) => {
  useBackClose(true, onClose);
  return createPortal(
    <div
      role="dialog"
      aria-label={title}
      className="fixed inset-0 z-[400] flex flex-col"
      style={{ background: '#101114' }}
    >
      <div className="flex items-center gap-2 px-4 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 14px)' }}>
        {icon}
        <span className="flex-1 text-base font-bold text-white">{title}</span>
        <button type="button" aria-label="Close" onClick={onClose} className="p-1 border-0 bg-transparent">
          <X size={18} color={MUTED} />
        </button>
      </div>
      {children}
      {footer && (
        <div
          className="border-t border-white/5 px-2 pt-2"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 8px)' }}
        >
          {footer}
        </div>
      )}
    </div>,
    document.body,
  );
};

const SearchBox = ({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) => (
  <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: '#17191E' }}>
    <Search size={15} color={MUTED} />
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      className="min-w-0 flex-1 bg-transparent border-0 outline-none text-sm text-white"
    />
  </div>
);

const Heading = ({ children }: { children: ReactNode }) => (
  <div className="px-3 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED }}>
    {children}
  </div>
);

export const SheetAction = ({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left border-0 bg-transparent active:bg-white/5"
  >
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#2b2f36]">{icon}</span>
    <span className="min-w-0 text-sm font-semibold text-white">{label}</span>
  </button>
);

type SwitchProps = {
  current?: string;
  switchingTo: string | null;
  onSwitch: (id: string) => void;
  verified: boolean;
};

/** "All accounts (N)": search, pinned, recent, then A–Z; Add / Import at the bottom. No agent accounts. */
export const SwitchAccountSheet = ({
  onClose,
  onAdd,
  onImport,
  ...row
}: SwitchProps & { onClose: () => void; onAdd: () => void; onImport: () => void }) => {
  const { people } = useMenuAccounts();
  const [query, setQuery] = useState('');
  const [pinned, setPinned] = useState(getPinned);
  const recent = useMemo(getRecent, []);
  const s = orderAccounts(people, { query, recent, pinned });
  const rows = (xs: MenuEntry[]) =>
    xs.map((a) => (
      <AccountRow
        key={a.id}
        account={a.account}
        {...row}
        trailing={
          <button
            type="button"
            aria-label={pinned.includes(a.id) ? `Unpin ${a.name}` : `Pin ${a.name}`}
            aria-pressed={pinned.includes(a.id)}
            onClick={() => setPinned(togglePinned(a.id))}
            className="shrink-0 p-2 border-0 bg-transparent"
          >
            <Star
              size={16}
              color={pinned.includes(a.id) ? GOLD : '#475467'}
              fill={pinned.includes(a.id) ? GOLD : 'none'}
            />
          </button>
        }
      />
    ));
  const none = !s.pinned.length && !s.recent.length && !s.rest.length;
  return (
    <FullSheet
      title={`Accounts (${people.length})`}
      icon={null}
      onClose={onClose}
      footer={
        <>
          <SheetAction icon={<Plus size={16} color="#fff" />} label="Add account" onClick={onAdd} />
          <SheetAction icon={<Download size={16} color="#fff" />} label="Import account" onClick={onImport} />
        </>
      }
    >
      <SearchBox value={query} onChange={setQuery} placeholder="Search name, handle or paymail" />
      <div className="flex-1 overflow-y-auto px-2" role="listbox">
        {s.pinned.length > 0 && <Heading>Favourites</Heading>}
        {rows(s.pinned)}
        {s.recent.length > 0 && <Heading>Recent</Heading>}
        {rows(s.recent)}
        {s.rest.length > 0 && (s.pinned.length > 0 || s.recent.length > 0) && <Heading>All accounts</Heading>}
        {rows(s.rest)}
        {none && (
          <p className="m-0 px-3 py-6 text-sm" style={{ color: MUTED }}>
            No account matches “{query}”.
          </p>
        )}
      </div>
    </FullSheet>
  );
};

/** "Agents (N)": your agent accounts (search, tap to switch), the b agent, Add agent account, CLI / MCP. */
export const AgentsSheet = ({
  onClose,
  onAgent,
  onAddAgent,
  onTools,
  toolsLabel,
  ...row
}: SwitchProps & {
  onClose: () => void;
  /** The b agent (classic layout only; the phone layout has the dock b). */
  onAgent?: { label: string; go: () => void };
  onAddAgent?: () => void;
  onTools?: () => void;
  toolsLabel: string;
}) => {
  const { agents } = useMenuAccounts();
  const [query, setQuery] = useState('');
  const s = orderAccounts(agents, { query });
  const list = [...s.pinned, ...s.recent, ...s.rest];
  return (
    <FullSheet title={`Agents (${agents.length})`} icon={<Bot size={18} color={GOLD} />} onClose={onClose}>
      <div className="px-2">
        {onAgent && (
          <SheetAction icon={<Sparkles size={16} color="#fff" />} label={onAgent.label} onClick={onAgent.go} />
        )}
        {onAddAgent && (
          <SheetAction icon={<Plus size={16} color="#fff" />} label="Add agent account" onClick={onAddAgent} />
        )}
        {onTools && <SheetAction icon={<Terminal size={16} color="#fff" />} label={toolsLabel} onClick={onTools} />}
      </div>
      <Heading>
        <span className="px-2">Your agent accounts</span>
      </Heading>
      {agents.length > 0 && <SearchBox value={query} onChange={setQuery} placeholder="Search agents" />}
      <div className="flex-1 overflow-y-auto px-2 pb-6" role="listbox">
        {list.map((a) => (
          <AccountRow key={a.id} account={a.account} {...row} />
        ))}
        {!agents.length && (
          <p className="m-0 px-3 py-4 text-sm" style={{ color: MUTED }}>
            No agent accounts yet.
          </p>
        )}
        {agents.length > 0 && !list.length && (
          <p className="m-0 px-3 py-4 text-sm" style={{ color: MUTED }}>
            No agent matches “{query}”.
          </p>
        )}
      </div>
    </FullSheet>
  );
};
