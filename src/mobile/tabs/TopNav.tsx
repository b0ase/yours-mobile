import { routeFor } from './tabs';
import { useState } from 'react';
import { useBackClose } from '../backStack';
import { accountNamesFor, useAccountNames } from '../names/MyNameBadge';
import { useKyc } from '../kyc/useKyc';
import { kycValid } from '../kyc/kyc';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Download, Loader2, Menu, Phone, Play, Plus, Settings, X } from 'lucide-react';
import bGlyph from '../brand/bwallet-glyph.svg';
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { CallsSheet } from '../calls/CallsSheet';
import { DrawerHandle } from '../names/DrawerHandle';
import { HandleFlow } from '../names/HandleFlow';
import { AccountAvatar, useAvatar } from '../names/AccountAvatar';
import { getLocalAvatar, isDefaultAvatar, pickAvatar, resolveAvatarUrl } from '../names/avatar';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Mobile swap for src/components/TopNav.tsx (vite.config.mobile.ts).
 * A hamburger at top-left opens a left drawer with the current account (name, handle,
 * verified), every account, Add / Import account and Settings. The centred b opens the
 * b agent (/m/agent).
 * Switching reuses upstream TopNav's sequence verbatim.
 */
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

export const TopNav = () => {
  const { theme } = useTheme();
  const { chromeStorageService, wallet, setIsSwitchingAccount } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const onAgent = pathname.startsWith('/m/agent');
  const onMedia = pathname.startsWith('/m/media');
  const { addSnackbar } = useSnackbar();
  const [drawer, setDrawer] = useState(false);
  const [handleOpen, setHandleOpen] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [callsOpen, setCallsOpen] = useState(false);
  useBackClose(drawer && !switchingTo, () => setDrawer(false));
  const accountObj = chromeStorageService.getCurrentAccountObject();
  const current = accountObj.account?.addresses.identityAddress;
  // Display name = BAP profile name (else account name); payable handle = OpNS name / paymail. Synced from chain.
  const names = useAccountNames(
    current,
    accountObj.account?.name ?? '',
    accountObj.account?.settings?.socialProfile?.displayName ?? '',
  );
  const payable = names.payable;
  const avatar = useAvatar(current);
  const { kyc } = useKyc();
  const verified = kycValid(kyc, Date.now());

  // Same as upstream TopNav.handleSwitchAccount.
  const handleSwitchAccount = async (identityAddress: string) => {
    if (switchingTo) return;
    if (identityAddress === current) return setDrawer(false);
    setSwitchingTo(identityAddress);
    setIsSwitchingAccount(true);
    wallet?.close?.();
    try {
      await chromeStorageService.switchAccount(identityAddress);
    } catch (err) {
      console.error('[TopNav] account switch failed:', err);
      setIsSwitchingAccount(false);
      setSwitchingTo(null);
      addSnackbar('Failed to switch account. Please try again.', 'error');
      return;
    }
    window.location.reload();
  };

  const go = (query?: string) => {
    setDrawer(false);
    handleSelect('settings', query);
    // Selecting the already-selected Settings changes nothing, so route explicitly (e.g. from Media).
    const route = routeFor('settings');
    if (route) navigate(route);
  };

  const action = (icon: React.ReactNode, label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left active:bg-white/5"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2b2f36]">{icon}</span>
      <span className="text-sm font-semibold text-white">{label}</span>
    </button>
  );

  return (
    <>
      {/* Five equal slots: Accounts · Calls · b agent · Media · Settings. */}
      <div
        className="grid grid-cols-5 items-center fixed top-0 w-full z-10 px-2 h-14 justify-items-center"
        style={{ backgroundColor: theme.color.global.walletBackground, top: 'var(--wallet-inset-top)' }}
      >
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="w-9 h-9 flex items-center justify-center bg-transparent"
          aria-label="Accounts menu"
        >
          <Menu size={22} color="#F2F2F0" />
        </button>
        <button
          type="button"
          aria-label="Calls"
          onClick={() => setCallsOpen(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
          style={{ border: '1px solid #2A2A2C' }}
        >
          <Phone size={16} color="#F5B800" />
        </button>
        {/* The b opens the b agent. */}
        <button
          type="button"
          aria-label="b agent"
          // Toggle: the b opens the b agent, and closes it again when it's already open.
          onClick={() => (onAgent ? navigate(-1) : navigate('/m/agent'))}
          aria-pressed={onAgent}
          className="w-10 h-10 flex items-center justify-center bg-transparent"
        >
          <img src={bGlyph} alt="" width={26} height={26} className="w-[26px] h-[26px]" />
        </button>
        <button
          type="button"
          aria-label="Media"
          onClick={() => (onMedia ? navigate(-1) : navigate('/m/media'))}
          aria-pressed={onMedia}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
          style={{ border: '1px solid #2A2A2C' }}
        >
          <Play size={16} color="#F5B800" fill="#F5B800" />
        </button>
        <button
          type="button"
          aria-label="Settings"
          onClick={() => go()}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
          style={{ border: '1px solid #2A2A2C' }}
        >
          <Settings size={16} color="#F2F2F0" />
        </button>
      </div>

      <AnimatePresence>
        {drawer && (
          <motion.div
            className="fixed inset-0 z-[300] bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !switchingTo && setDrawer(false)}
          >
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 420, damping: 40 }}
              className="absolute left-0 top-0 bottom-0 w-[82%] max-w-[340px] flex flex-col bg-[#101114] border-r border-white/5"
              style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 h-14">
                <span className="text-base font-bold text-white">Accounts</span>
                <button aria-label="Close" onClick={() => setDrawer(false)} className="p-2">
                  <X size={18} color="#98A2B3" />
                </button>
              </div>
              <div className="flex items-center gap-3 px-4 pb-3">
                <AccountAvatar src={avatar} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 min-w-0">
                    <span className={`text-[15px] font-semibold text-white ${ELLIPSIS}`}>
                      {names.displayName || short(current ?? '')}
                    </span>
                    {verified && (
                      <span aria-label="Verified identity" title="Verified identity" style={{ color: '#2ecc71' }}>
                        <Check size={14} strokeWidth={3} />
                      </span>
                    )}
                  </div>
                  {payable && payable.toLowerCase() !== names.displayName.toLowerCase() && (
                    <div className={`text-xs font-semibold ${ELLIPSIS}`} style={{ color: '#FFD24D' }}>
                      {payable}
                    </div>
                  )}
                </div>
              </div>
              <DrawerHandle
                identityAddress={current}
                paymail={names.paymail}
                handle={names.handle}
                onNavigate={() => setDrawer(false)}
                onGetName={() => {
                  setDrawer(false);
                  setHandleOpen(true);
                }}
              />
              <div className="flex-1 overflow-y-auto px-2">
                {chromeStorageService.getAllAccounts().map((account) => {
                  const id = account.addresses.identityAddress;
                  const isSwitching = switchingTo === id;
                  const rowNames = accountNamesFor(
                    id,
                    account.name,
                    account.settings?.socialProfile?.displayName ?? '',
                  );
                  return (
                    <button
                      key={id}
                      onClick={() => void handleSwitchAccount(id)}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left active:bg-white/5"
                      style={{
                        background: id === current ? '#17191E' : undefined,
                        opacity: switchingTo && !isSwitching ? 0.4 : 1,
                      }}
                    >
                      {isSwitching ? (
                        <Loader2 size={20} className="animate-spin w-9 h-9 p-2" color="#A1FF8B" />
                      ) : (
                        <AccountAvatar
                          size={36}
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
                        <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{rowNames.label}</div>
                        <div className="text-[11px] font-mono text-[#98A2B3]">
                          {short(account.primaryAddress ?? id)}
                        </div>
                      </div>
                      {id === current && <Check size={16} color="#A1FF8B" />}
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-white/5 px-2 py-2">
                {action(<Plus size={16} color="#fff" />, 'Add account', () => go('create-account'))}
                {action(<Download size={16} color="#fff" />, 'Import account', () => go('restore-account'))}
                {action(<Settings size={16} color="#fff" />, 'Settings', () => go())}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <CallsSheet open={callsOpen} onClose={() => setCallsOpen(false)} />
      {handleOpen && <HandleFlow onClose={() => setHandleOpen(false)} />}
    </>
  );
};
