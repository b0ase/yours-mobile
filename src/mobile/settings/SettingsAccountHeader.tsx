import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { accountNamesFor, useAccountNames } from '../names/MyNameBadge';
import { AccountAvatar, useAvatar } from '../names/AccountAvatar';
import { getLocalAvatar, isDefaultAvatar, pickAvatar, resolveAvatarUrl } from '../names/avatar';
import { isAgentAccount } from '../agents/agentAccounts';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

const AgentTag = () => (
  <span
    className="shrink-0 rounded px-1.5 py-[1px] text-[10px] font-bold tracking-wide"
    style={{ background: '#7A5AF833', color: '#BDB4FE' }}
  >
    AGENT
  </span>
);

/**
 * Settings: which account the "This account" settings apply to (owner, 6 Oct 2026: with several accounts,
 * each its own 12 words, it was unclear). "Settings for: [avatar] test-agent · AGENT ▾" with a switcher.
 */
export const SettingsAccountHeader = () => {
  const { chromeStorageService, wallet, setIsSwitchingAccount } = useServiceContext();
  const { account } = chromeStorageService.getCurrentAccountObject();
  const id = account?.addresses?.identityAddress;
  const names = useAccountNames(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '', false);
  const avatar = useAvatar(id);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const accounts = chromeStorageService.getAllAccounts();

  const switchTo = async (to: string) => {
    if (switching) return;
    if (to === id) return setOpen(false);
    setSwitching(to);
    setIsSwitchingAccount(true);
    wallet?.close?.();
    try {
      await chromeStorageService.switchAccount(to);
    } catch (err) {
      console.error('[Settings] account switch failed:', err);
      setIsSwitchingAccount(false);
      setSwitching(null);
      return;
    }
    // Same as the account menu: reload into the switched account (stays on Settings).
    window.location.reload();
  };

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
        <AccountAvatar src={avatar} size={24} />
        <span className="min-w-0 flex-1 flex items-center gap-1.5">
          <span className="truncate text-sm font-bold text-white">{names.displayName || 'This account'}</span>
          {isAgentAccount(id) && <AgentTag />}
        </span>
        {accounts.length > 1 && <ChevronDown size={16} color={MUTED} style={{ transform: open ? 'rotate(180deg)' : '' }} />}
      </button>
      {open && (
        <div className="mt-1 rounded-xl overflow-hidden" style={{ background: '#17191E' }} role="listbox">
          {accounts.map((a) => {
            const aid = a.addresses.identityAddress;
            const n = accountNamesFor(aid, a.name, a.settings?.socialProfile?.displayName ?? '');
            const src = resolveAvatarUrl(
              pickAvatar({
                local: getLocalAvatar(aid),
                socialAvatar: a.settings?.socialProfile?.avatar,
                accountIcon: isDefaultAvatar(a.icon) ? '' : a.icon,
              }),
            );
            return (
              <button
                key={aid}
                role="option"
                aria-selected={aid === id}
                onClick={() => void switchTo(aid)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left border-0 bg-transparent active:bg-white/5"
              >
                {switching === aid ? <Loader2 size={20} className="animate-spin" color={GOLD} /> : <AccountAvatar src={src} size={20} ring={false} />}
                <span className="min-w-0 flex-1 flex items-center gap-1.5">
                  <span className="truncate text-sm text-white">{n.displayName || n.label}</span>
                  {isAgentAccount(aid) && <AgentTag />}
                </span>
                {aid === id && <Check size={14} color="#A1FF8B" />}
              </button>
            );
          })}
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
