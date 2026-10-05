import { routeFor } from './tabs';
import { allAgentsStopped, getAgentAccount, isAgentAccount } from '../agents/agentAccounts';
import { AgentBadge } from '../agents/AgentsScreen';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useBackClose } from '../backStack';
import { accountNamesFor, useAccountNames } from '../names/MyNameBadge';
import { useKyc } from '../kyc/useKyc';
import { kycValid } from '../kyc/kyc';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Check, Download, Loader2, Menu, Phone, Play, Plus, ScanLine, Settings, Terminal, X } from 'lucide-react';
import { startAgentCreate } from '../agents/AgentAccountToggle';
import { AgentToolsSheet } from '../agents/AgentToolsSheet';
import bGlyph from '../brand/bwallet-glyph.svg';
import { isBWalletX } from '../storeBuild';
import { IS_EXTENSION } from '../extension';
import { initPairing, setAgentPairDeps } from '../pair/sessions';
import { onPairLink, takePairLink } from '../pair/links';

const PairSheet = lazy(() => import('../pair/PairSheet'));
import { useTheme } from '../../hooks/useTheme';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { CallsSheet } from '../calls/CallsSheet';
import { DrawerHandle } from '../names/DrawerHandle';
import { getPersonalLink } from '../names/personalToken';
import { identityRowText } from '../names/identityText';
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
// Logo (owner, 4 Oct 2026): no x in any logo. bWalletX = gold b on black; the store bWallet flips it:
// a yellow bar with a black b and black icons. The tab (Exchange / Market) and titles say which app it is.
const X_MARK = isBWalletX();
const FLIP = !X_MARK;
const BAR_BG = FLIP ? '#F5B800' : undefined;
const ICON = FLIP ? '#010101' : '#F2F2F0';
const ACCENT = FLIP ? '#010101' : '#F5B800';
const RING = FLIP ? '1px solid #01010133' : '1px solid #2A2A2C';
const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

export const TopNav = () => {
  const { theme } = useTheme();
  const { chromeStorageService, wallet, setIsSwitchingAccount, apiContext } = useServiceContext();
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
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairLink, setPairLink] = useState<string | null>(null);
  // A pairing QR scanned with the phone's camera opened the app (pair/links.ts): go straight to confirm.
  useEffect(() => {
    if (IS_EXTENSION) return;
    const show = () => {
      const url = takePairLink();
      if (url) {
        setPairLink(url);
        setPairOpen(true);
      }
    };
    show();
    return onPairLink(show);
  }, []);
  // Phone pairing (QR from a desktop site): reconnect paired sites. The extension is itself on the desktop.
  useEffect(() => {
    if (!IS_EXTENSION) initPairing();
  }, []);
  useBackClose(drawer && !switchingTo, () => setDrawer(false));
  const accountObj = chromeStorageService.getCurrentAccountObject();
  const current = accountObj.account?.addresses.identityAddress;
  // Paired bWalletX CLI / MCP calls run on the open account with this wallet context (pair/agentPairing.ts).
  useEffect(() => {
    if (!IS_EXTENSION) setAgentPairDeps({ ctx: apiContext, currentId: current, feeRate: () => chromeStorageService.getCustomFeeRate() });
  }, [apiContext, current, chromeStorageService]);
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
        style={{ backgroundColor: BAR_BG ?? theme.color.global.walletBackground, top: 'var(--wallet-inset-top)' }}
      >
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="w-9 h-9 flex items-center justify-center bg-transparent"
          aria-label="Accounts menu"
        >
          <Menu size={22} color={ICON} />
        </button>
        <button
          type="button"
          aria-label="Calls"
          onClick={() => setCallsOpen(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
          style={{ border: RING }}
        >
          <Phone size={16} color={ACCENT} />
        </button>
        {/* The b opens the b agent. */}
        <button
          type="button"
          aria-label={X_MARK ? 'bX agent' : 'b agent'}
          // Toggle: the b opens the b agent, and closes it again when it's already open.
          onClick={() => (onAgent ? navigate(-1) : navigate('/m/agent'))}
          aria-pressed={onAgent}
          className="relative w-10 h-10 flex items-center justify-center bg-transparent"
        >
          {FLIP ? (
            <svg viewBox="23 8 74 100" width={20} height={26} aria-hidden>
              <mask id="bnav">
                <rect x="0" y="0" width="140" height="140" fill="#fff" />
                <circle cx="60" cy="72" r="15" fill="#000" />
              </mask>
              <g fill="#010101" mask="url(#bnav)">
                <polygon points="45,12 45,76 27,76 27,30" />
                <circle cx="60" cy="72" r="33" />
              </g>
            </svg>
          ) : (
            <img src={bGlyph} alt="" width={26} height={26} className="w-[26px] h-[26px]" />
          )}
        </button>
        <button
          type="button"
          aria-label="Media"
          onClick={() => (onMedia ? navigate(-1) : navigate('/m/media'))}
          aria-pressed={onMedia}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
          style={{ border: RING }}
        >
          <Play size={16} color={ACCENT} fill={ACCENT} />
        </button>
        <button
          type="button"
          aria-label="Settings"
          onClick={() => go()}
          className="w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
          style={{ border: RING }}
        >
          <Settings size={16} color={ICON} />
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
                        <div className={`flex items-center gap-1 text-sm font-semibold text-white ${ELLIPSIS}`}>
                          {rowNames.displayName || rowNames.label}
                          {id === current && verified && <Check size={13} strokeWidth={3} color="#2ecc71" />}
                          {isAgentAccount(id) && <AgentBadge stopped={getAgentAccount(id)?.stopped || allAgentsStopped()} />}
                        </div>
                        {(() => {
                          // Always show the $handle: the personal token ticker, else the paymail/OpNS name.
                          const ticker = getPersonalLink(id)?.ticker;
                          const tag = ticker
                            ? `$${ticker.replace(/^\$/, '').toUpperCase()}`
                            : identityRowText(rowNames.displayName, rowNames.paymail, rowNames.handle).tag;
                          return tag ? (
                            <div className={`text-[15px] font-extrabold ${ELLIPSIS}`} style={{ color: '#FFD24D' }}>
                              {tag}
                            </div>
                          ) : null;
                        })()}
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
                {/* bWalletX: agent accounts and the tools that drive them (owner, 6 Oct 2026). */}
                {X_MARK &&
                  action(<Bot size={16} color="#fff" />, 'Add agent account', () => {
                    startAgentCreate();
                    go('create-account');
                  })}
                {X_MARK &&
                  action(<Terminal size={16} color="#fff" />, 'CLI & MCP for agents', () => {
                    setDrawer(false);
                    setToolsOpen(true);
                  })}
                {action(<Download size={16} color="#fff" />, 'Import account', () => go('restore-account'))}
                {!IS_EXTENSION &&
                  action(<ScanLine size={16} color="#fff" />, 'Scan to connect a website', () => {
                    setDrawer(false);
                    setPairOpen(true);
                  })}
                {action(<Settings size={16} color="#fff" />, 'Settings', () => go())}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <CallsSheet open={callsOpen} onClose={() => setCallsOpen(false)} />
      {toolsOpen && <AgentToolsSheet onClose={() => setToolsOpen(false)} />}
      {pairOpen && (
        <Suspense fallback={null}>
          <PairSheet
            initial={pairLink ?? undefined}
            onClose={() => {
              setPairOpen(false);
              setPairLink(null);
            }}
          />
        </Suspense>
      )}
      {handleOpen && <HandleFlow onClose={() => setHandleOpen(false)} />}
    </>
  );
};
