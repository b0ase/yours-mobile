import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useAccountNames } from '../names/accountNames';
import { AccountAvatar } from '../names/AccountAvatar';
import { useAvatar } from '../names/useAvatar';
import { AccountList, AgentMark } from '../account/AccountSwitcher';
import { useAccountSwitch } from '../account/accountSwitch';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

/**
 * Settings: which account the "This account" settings apply to (owner, 6 Oct 2026: with several accounts,
 * each its own 12 words, it was unclear). "Settings for: [avatar] test-agent · AGENT ▾" with a switcher.
 */
export const SettingsAccountHeader = () => {
  const { chromeStorageService } = useServiceContext();
  const { account } = chromeStorageService.getCurrentAccountObject();
  const [open, setOpen] = useState(false);
  // Same switch as the account menu and the account strip: reload into the switched account (stays on Settings).
  const { current: id, switchingTo, switchAccount } = useAccountSwitch(() => setOpen(false));
  const names = useAccountNames(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '', false);
  const avatar = useAvatar(id);
  const accounts = chromeStorageService.getAllAccounts();

  return (
    <div className="mt-2 mb-1" data-testid="settings-account-header">
      <button
        onClick={() => accounts.length > 1 && setOpen((o) => !o)}
        className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left border-0"
        style={{ background: '#17191E', border: `1px solid ${GOLD}55` }}
        aria-expanded={open}
        aria-label="Settings for account"
      >
        <span className="text-xs shrink-0" style={{ color: MUTED }}>
          Settings for:
        </span>
        <AccountAvatar src={avatar} size={24} id={id} />
        <span className="min-w-0 flex-1 flex items-center gap-1.5">
          <span className="truncate text-sm font-bold text-white">{names.displayName || 'This account'}</span>
          <AgentMark id={id} />
        </span>
        {accounts.length > 1 && (
          <ChevronDown size={16} color={MUTED} style={{ transform: open ? 'rotate(180deg)' : '' }} />
        )}
      </button>
      {open && (
        <div className="mt-1 rounded-xl overflow-hidden p-1" style={{ background: '#101114' }} role="listbox">
          <AccountList current={id} switchingTo={switchingTo} onSwitch={(to) => void switchAccount(to)} compact />
        </div>
      )}
    </div>
  );
};

/** "This account" / "All accounts (wallet)" group headings on the Settings main page. */
export const SettingsGroup = ({ title, note, children }: { title: string; note?: string; children?: ReactNode }) => (
  <div className="mt-6 mb-1 px-1">
    <p className="m-0 text-[13px] font-extrabold uppercase tracking-wider" style={{ color: GOLD }}>
      {title}
    </p>
    {note && (
      <p className="m-0 mt-0.5 text-xs" style={{ color: MUTED }}>
        {note}
      </p>
    )}
    {children}
  </div>
);
