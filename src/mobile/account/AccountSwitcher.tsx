import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { allAgentsStopped, getAgentAccount, isAgentAccount } from '../agents/agentAccounts';
import { AgentBadge } from '../agents/AgentsScreen';
import { accountNamesFor } from '../names/MyNameBadge';
import { AccountAvatar } from '../names/AccountAvatar';
import { getLocalAvatar, isDefaultAvatar, pickAvatar, resolveAvatarUrl } from '../names/avatar';
import { getPersonalLink } from '../names/personalToken';
import { identityRowText } from '../names/identityText';

const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

/**
 * Account switching, shared by the account drawer (TopNav), the account strip above it and Settings.
 * Same sequence as upstream TopNav.handleSwitchAccount: close the wallet, switch, reload into the account.
 */
export const useAccountSwitch = (onSame?: () => void) => {
  const { chromeStorageService, wallet, setIsSwitchingAccount } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const current = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress;

  const switchAccount = async (identityAddress: string) => {
    if (switchingTo) return;
    if (identityAddress === current) return onSame?.();
    setSwitchingTo(identityAddress);
    setIsSwitchingAccount(true);
    wallet?.close?.();
    try {
      await chromeStorageService.switchAccount(identityAddress);
    } catch (err) {
      console.error('[accounts] account switch failed:', err);
      setIsSwitchingAccount(false);
      setSwitchingTo(null);
      addSnackbar('Failed to switch account. Please try again.', 'error');
      return;
    }
    window.location.reload();
  };
  return { current, switchingTo, switchAccount };
};

/** The $handle for an account row: personal token ticker, else the paymail alias / OpNS name. */
export const accountTag = (id: string, displayName: string, paymail: string, handle: string) => {
  const ticker = getPersonalLink(id)?.ticker;
  return ticker
    ? `$${ticker.replace(/^\$/, '').toUpperCase()}`
    : identityRowText(displayName, paymail, handle).tag;
};

export const AgentMark = ({ id }: { id?: string }) =>
  id && isAgentAccount(id) ? <AgentBadge stopped={getAgentAccount(id)?.stopped || allAgentsStopped()} /> : null;

/** Every account as a tappable row. compact = the strip's dropdown (smaller, no address line). */
export const AccountList = ({
  current,
  switchingTo,
  onSwitch,
  verified = false,
  compact = false,
}: {
  current?: string;
  switchingTo: string | null;
  onSwitch: (id: string) => void;
  verified?: boolean;
  compact?: boolean;
}) => {
  const { chromeStorageService } = useServiceContext();
  const size = compact ? 28 : 36;
  return (
    <>
      {chromeStorageService.getAllAccounts().map((account) => {
        const id = account.addresses.identityAddress;
        const isSwitching = switchingTo === id;
        const n = accountNamesFor(id, account.name, account.settings?.socialProfile?.displayName ?? '');
        const tag = accountTag(id, n.displayName, n.paymail, n.handle);
        return (
          <button
            key={id}
            role="option"
            aria-selected={id === current}
            onClick={() => onSwitch(id)}
            className={`flex w-full items-center gap-3 rounded-xl text-left border-0 active:bg-white/5 ${compact ? 'px-3 py-2' : 'px-3 py-3'}`}
            style={{
              background: id === current ? '#17191E' : 'transparent',
              opacity: switchingTo && !isSwitching ? 0.4 : 1,
            }}
          >
            {isSwitching ? (
              <Loader2 size={20} className="animate-spin p-1.5" style={{ width: size, height: size }} color="#A1FF8B" />
            ) : (
              <AccountAvatar
                size={size}
                ring={false}
                src={resolveAvatarUrl(
                  pickAvatar({
                    local: getLocalAvatar(id),
                    socialAvatar: account.settings?.socialProfile?.avatar,
                    accountIcon: isDefaultAvatar(account.icon) ? '' : account.icon,
                  }),
                )}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className={`flex items-center gap-1 text-sm font-semibold text-white ${ELLIPSIS}`}>
                <span className={ELLIPSIS}>{n.displayName || n.label}</span>
                {id === current && verified && <Check size={13} strokeWidth={3} color="#2ecc71" />}
                <AgentMark id={id} />
              </div>
              {tag && (
                <div
                  className={`${compact ? 'text-xs' : 'text-[15px]'} font-extrabold ${ELLIPSIS}`}
                  style={{ color: '#FFD24D' }}
                >
                  {tag}
                </div>
              )}
              {!compact && (
                <div className="text-[11px] font-mono text-[#98A2B3]">{short(account.primaryAddress ?? id)}</div>
              )}
            </div>
            {id === current && <Check size={16} color="#A1FF8B" />}
          </button>
        );
      })}
    </>
  );
};
