import { useState } from 'react';
import { useMyName } from '../names/MyNameBadge';
import { useKyc } from '../kyc/useKyc';
import { kycValid } from '../kyc/kyc';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Download, Loader2, Plus, Settings, X } from 'lucide-react';
import logo from '../../assets/logos/horizontal-logo.png';
import activeCircle from '../../assets/active-circle.png';
import { ThemeBadge } from '../../components/ThemeBadge';
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBottomMenu } from '../../hooks/useBottomMenu';

/**
 * Mobile swap for src/components/TopNav.tsx (vite.config.mobile.ts).
 * Phantom-style: the current account (avatar + name) at top-left opens a
 * left drawer with every account, Add / Import account and Settings.
 * Switching reuses upstream TopNav's sequence verbatim.
 */
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

export const TopNav = () => {
  const { theme } = useTheme();
  const { chromeStorageService, wallet, setIsSwitchingAccount } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const { addSnackbar } = useSnackbar();
  const [drawer, setDrawer] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const accountObj = chromeStorageService.getCurrentAccountObject();
  const current = accountObj.account?.addresses.identityAddress;
  const myName = useMyName(current);
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
      <div
        className="flex items-center justify-between fixed top-0 w-full z-10 px-4 h-14"
        style={{ backgroundColor: theme.color.global.walletBackground, top: 'var(--wallet-inset-top)' }}
      >
        <button onClick={() => setDrawer(true)} className="flex items-center gap-2 min-w-0" aria-label="Accounts">
          <img src={accountObj.account?.icon ?? activeCircle} className="w-8 h-8 rounded-full object-cover" alt="" />
          <span
            className={`text-sm font-semibold max-w-[140px] ${ELLIPSIS}`}
            style={{ color: theme.color.global.contrast }}
          >
            {accountObj.account?.name ?? short(current ?? '')}
          </span>
          {verified && (
            <span aria-label="Verified identity" title="Verified identity" style={{ color: '#2ecc71' }}>
              <Check size={14} strokeWidth={3} />
            </span>
          )}
          {myName && (
            <span className={`text-xs font-semibold max-w-[110px] ${ELLIPSIS}`} style={{ color: '#FFD24D' }}>
              {myName}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2">
          <ThemeBadge theme={theme} />
          <img src={logo} className="w-20 object-contain" alt="bWallet" />
        </div>
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
              <div className="flex-1 overflow-y-auto px-2">
                {chromeStorageService.getAllAccounts().map((account) => {
                  const id = account.addresses.identityAddress;
                  const isSwitching = switchingTo === id;
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
                        <img src={account.icon} className="w-9 h-9 rounded-full object-cover" alt="" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{account.name}</div>
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
    </>
  );
};
