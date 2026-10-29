import { lazy, Suspense, useContext, useEffect, useState } from 'react';
import { SiteRoomChip } from './mobile/chat/SiteRoomViews';
import { keepPanelPort } from './services/panelPrompt';
import { STORE_BUILD } from './mobile/storeBuild';
import { wearActiveSite } from './mobile/theme/siteLook';
import { MemoryRouter as Router, Route, Routes } from 'react-router-dom';
import { Show } from './components/Show';
import { UnlockWallet } from './components/UnlockWallet';
import { UsbGate } from './components/UsbGate';
import { UsbBackupPill } from './components/UsbBackupPill';
import { useUsbBackupRunner } from './hooks/useUsbBackupRunner';
import { BottomMenuContext } from './contexts/BottomMenuContext';
import { useActivityDetector } from './hooks/useActivityDetector';
import { useTheme } from './hooks/useTheme';
import { AppsAndTools } from './pages/AppsAndTools';
import { CreateAccount } from './pages/onboarding/CreateAccount';
import { ImportAccount } from './pages/onboarding/ImportAccount';
import { RestoreAccount } from './pages/onboarding/RestoreAccount';
import { Start } from './pages/onboarding/Start';
import { OrdWallet } from './pages/OrdWallet';
import { Settings } from './pages/Settings';
import { PageLoader } from './components/PageLoader';
import { useServiceContext } from './hooks/useServiceContext';
import { SyncingBlocks } from './components/SyncingBlocks';
import { StorageRepairOverlay } from './components/StorageRepairOverlay';
import { MasterRestore } from './pages/onboarding/MasterRestore';
import { BlockHeightProvider } from './contexts/providers/BlockHeightProvider';
import { SyncProvider } from './contexts/providers/SyncProvider';
import { BottomMenuProvider } from './contexts/providers/BottomMenuProvider';
import { SnackbarProvider } from './contexts/providers/SnackbarProvider';
import { SentHost } from './components/sent/SentScreen';
import { SweepMigration } from './pages/SweepMigration';
import { PANEL_PROMPT_EVENT, PanelPrompt } from './mobile/PanelPrompt';
import { wearConnectedSiteTheme, wearingSiteLook } from './mobile/theme/accent';
import { accentById } from './mobile/theme/accents';
import { IS_EXTENSION } from './mobile/extension';
import { isWebApp } from './mobile/webApp';
import { HANDOFF_ENABLED, parseHandoffSearch } from './mobile/passkey/extHandoff';
import { ExtHandoffSend } from './mobile/passkey/ExtHandoffSend';
import { isHandoffNotLive } from './mobile/passkey/handoffNotLive';
import { UrlSync } from './mobile/url/UrlSync';
import { CrashResume } from './mobile/url/ResumeAfterCrash';
import { isNative } from './mobile/native';

import { PAY_STREAM_ENABLED } from './mobile/storeBuild';
import { guestMusicRoute } from './mobile/media/artists/guestRoute';
import { guestNamesRoute } from './mobile/names/store/guestRoute';
import { guestCheckRoute } from './mobile/bmint/check/guestRoute';
import { ROOM_TAB_ACTION, ROOM_TAB_EVENT } from './mobile/chat/gameRoomLive';

// bMusic artist/album pages are readable without a wallet on web/Desktop (bWalletX only: prices are not in a store
// build). Decided once at load from the address bar; only those read-only routes (guestRoute.ts).
const GUEST_START =
  (PAY_STREAM_ENABLED && typeof window !== 'undefined' && isWebApp() ? guestMusicRoute(window.location.pathname) : null) ??
  (typeof window !== 'undefined' && isWebApp() ? guestNamesRoute(window.location.pathname, window.location.search) : null) ??
  (typeof window !== 'undefined' && isWebApp() ? guestCheckRoute(window.location.pathname, window.location.search) : null);
const GuestMusic = PAY_STREAM_ENABLED ? lazy(() => import('./mobile/media/artists/GuestMusic')) : null;
// The Name Store (/names) is guest-first too: search and browse signed out (names/store/GuestNames.tsx).
const GuestNames = lazy(() => import('./mobile/names/store/GuestNames'));
// Check this mint (/bmint/check?o=…) works signed out too: a shared check link must open for anyone.
const GuestCheck = lazy(() => import('./mobile/bmint/check/GuestCheck'));

// Mobile-only (theme.settings.services.browser); lazy so the extension never loads it.
const BrowserPage = lazy(() => import('./mobile/BrowserPage'));
// Lazy, the same chunk as the phone pager's (mobile/phone/pager.tsx), so onboarding and unlock don't parse it.
const BsvWallet = lazy(() => import('./pages/BsvWallet').then((m) => ({ default: m.BsvWallet })));

/** Mounted inside the USB gate so the backup loop only runs while a key reads. */
const UsbBackupRunner = () => {
  useUsbBackupRunner();
  return null;
};

export const App = () => {
  const { theme } = useTheme();
  const { isLocked, isReady, chromeStorageService, setIsLocked, isSwitchingAccount } = useServiceContext();
  const menuContext = useContext(BottomMenuContext);

  const walletBg = theme.color.global.walletBackground;
  // Guest view until the visitor asks for the wallet; an already unlocked wallet just opens the page in the app.
  const [guest, setGuest] = useState(GUEST_START);
  const hasWallet = !!chromeStorageService?.getCurrentAccountObject?.()?.account?.encryptedKeys;
  const guestNames = !!guest && guest.startsWith('/m/names');
  const guestCheck = !!guest && guest.startsWith('/m/bmint/check');
  const showGuest = !!(guest && (guestNames || guestCheck || GuestMusic) && (isLocked || !hasWallet));

  useActivityDetector(isLocked, isReady, chromeStorageService);
  // Fetch the Wallet page's chunk as soon as a wallet exists (the lock screen is up meanwhile), so landing on
  // the Wallet after unlock shows no blank frame. Onboarding (no wallet yet) never loads it.
  useEffect(() => {
    if (hasWallet) void import('./pages/BsvWallet');
  }, [hasWallet]);
  // Once unlocked, warm the Apps chunk in idle time so the first swipe to Home/Apps is instant. Only the JS:
  // its clips load when they first show (ui/VideoBackground.tsx, games/BGamesHero.tsx).
  useEffect(() => {
    if (!hasWallet || isLocked) return;
    const t = setTimeout(() => void import('./mobile/BrowserPage'), 2000);
    return () => clearTimeout(t);
  }, [hasWallet, isLocked]);

  // Coins spent from another device (same seed) leave this device's balance high until checked: ask the background
  // for its throttled coin check whenever the app/popup is shown (owner, 29 Oct 2026: phone $3.47 vs extension $1.95
  // until REFRESH WALLET). The background decides whether one is due (services/autoCoinResync.ts).
  useEffect(() => {
    if (!hasWallet || isLocked) return;
    const ask = () => {
      if (document.visibilityState === 'hidden') return;
      try {
        void Promise.resolve(chrome.runtime.sendMessage({ action: 'COIN_CHECK_DUE' })).catch(() => undefined);
      } catch {
        /* worker not up yet: its own timer covers it */
      }
    };
    ask();
    document.addEventListener('visibilitychange', ask);
    return () => document.removeEventListener('visibilitychange', ask);
  }, [hasWallet, isLocked]);

  // Establish a port connection so the background knows the popup is open.
  // Port disconnects automatically when the popup closes — no timers needed.
  useEffect(() => {
    // Kept open across service-worker restarts (services/panelPrompt.ts keepPanelPort): a panel the new worker
    // can't see gets no prompts until the user happens to click or scroll (5.2.x after a Chrome restart).
    // bWalletX: approval prompts arrive here when the side panel is open (mobile/PanelPrompt.tsx).
    return keepPanelPort(() => chrome.runtime.connect({ name: 'extension-popup' }), (msg: unknown) => {
      // A site is waiting on waitForAuthentication: show the unlock screen even if this panel thought it was unlocked.
      if ((msg as { action?: string })?.action === 'SHOW_UNLOCK_PANEL') setIsLocked(true);
      // A connected site that declared a theme is the active tab (mobile/theme/connectTheme.ts); null = put ours back.
      if ((msg as { action?: string })?.action === 'SITE_THEME') {
        const t = (msg as { theme?: unknown }).theme;
        const o = (msg as { origin?: unknown }).origin;
        const pack = typeof t === 'string' && accentById(t).id === t ? t : null;
        // A bundled pack the page names wins; otherwise the site's own v2 file (mobile/theme/siteLook.ts).
        if (pack) {
          void wearActiveSite(null);
          wearConnectedSiteTheme(pack);
        } else {
          // Only one of the two is ever worn: drop a pack first, then (maybe) wear the site's file.
          if (!wearingSiteLook()) wearConnectedSiteTheme(null);
          const path = (msg as { path?: unknown }).path;
          void wearActiveSite(typeof o === 'string' ? o : null, typeof path === 'string' ? path : null);
        }
        return;
      }
      // A bChatX room tab playing a game room's video (mobile/chat/gameRoomLive.ts): the room's player listens.
      if ((msg as { action?: string })?.action === ROOM_TAB_ACTION) {
        window.dispatchEvent(new CustomEvent(ROOM_TAB_EVENT, { detail: msg }));
        return;
      }
      window.dispatchEvent(new CustomEvent(PANEL_PROMPT_EVENT, { detail: msg }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleUnlock = async () => {
    setIsLocked(false);
    menuContext?.handleSelect('bsv');
  };

  if (!isReady) {
    return (
      <div
        className="flex items-center justify-center relative p-0"
        style={{
          width: 'var(--wallet-width)',
          height: 'var(--wallet-height)',
          backgroundColor: walletBg,
        }}
      >
        <PageLoader message="Loading..." theme={theme} />
      </div>
    );
  }

  // The extension's "Sign in with a passkey" opens /restore?passkey=1&ext=<id>&n=<nonce> here. It must show BEFORE the
  // unlock screen: a browser that already holds a wallet here would otherwise unlock it instead (owner, 20 Oct 2026).
  const handoff =
    HANDOFF_ENABLED && isWebApp() && location.pathname.replace(/\/$/, '') === '/restore'
      ? parseHandoffSearch(location.search)
      : null;
  if (handoff) {
    return (
      <div
        className="flex items-start justify-center relative p-0 overflow-y-auto"
        style={{ width: 'var(--wallet-width)', height: 'var(--wallet-height)', backgroundColor: walletBg }}
      >
        <ExtHandoffSend nonce={handoff.nonce} />
      </div>
    );
  }
  if (isWebApp() && isHandoffNotLive(HANDOFF_ENABLED, location.pathname, location.search)) {
    return (
      <div
        className="flex items-center justify-center relative p-6"
        style={{ width: 'var(--wallet-width)', height: 'var(--wallet-height)', backgroundColor: walletBg }}
        data-testid="handoff-not-live"
      >
        <div className="flex flex-col gap-4 max-w-sm text-center" style={{ color: theme.color.global.contrast }}>
          <h1 className="text-xl font-bold m-0">Passkey sign-in isn&rsquo;t available yet</h1>
          <p className="text-sm m-0" style={{ color: theme.color.global.gray }}>
            Close this tab and go back to bWalletX in Chrome. Choose <strong>Restore Wallet</strong> to use your 12
            words or backup file, or <strong>Create New Wallet</strong> to start a new one with a password.
          </p>
          <button
            type="button"
            onClick={() => window.close()}
            className="rounded-xl h-11 text-sm font-bold border-0 cursor-pointer"
            style={{
              background: `linear-gradient(135deg, ${theme.color.component.primaryButtonLeftGradient}, ${theme.color.component.primaryButtonRightGradient})`,
              color: theme.color.component.primaryButtonText,
            }}
          >
            Close this tab
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-center justify-center relative p-0"
      style={{
        width: 'var(--wallet-width)',
        height: 'var(--wallet-height)',
        backgroundColor: walletBg,
      }}
    >
      <BlockHeightProvider>
        <SyncProvider>
          <BottomMenuProvider>
            <div
              className="flex items-center justify-center w-full h-full relative"
              style={{ backgroundColor: walletBg }}
            >
              <SnackbarProvider>
                <SyncingBlocks />
                <StorageRepairOverlay />
                <SentHost />
                {IS_EXTENSION && <PanelPrompt />}
                {showGuest && guestNames && guest && (
                  <Suspense fallback={<PageLoader message="Loading..." theme={theme} />}>
                    <GuestNames route={guest} onWallet={() => setGuest(null)} />
                  </Suspense>
                )}
                {showGuest && guestCheck && guest && (
                  <Suspense fallback={<PageLoader message="Loading..." theme={theme} />}>
                    <GuestCheck route={guest} onWallet={() => setGuest(null)} />
                  </Suspense>
                )}
                {showGuest && !guestNames && !guestCheck && GuestMusic && guest && (
                  <Suspense fallback={<PageLoader message="Loading..." theme={theme} />}>
                    <GuestMusic route={guest} onWallet={() => setGuest(null)} />
                  </Suspense>
                )}
                <Show when={!isLocked} whenFalseContent={<UnlockWallet onUnlock={handleUnlock} />}>
                  <UsbGate>
                    <UsbBackupRunner />
                    {/* The connected game's room: a chip to open it, never opened by itself (mobile/chat/siteRoom.ts); store builds never. */}
                    {!STORE_BUILD && <SiteRoomChip />}
                    <UsbBackupPill />
                    <Show
                      when={!isSwitchingAccount}
                      whenFalseContent={<PageLoader message="Switching account..." theme={theme} />}
                    >
                      <Router>
                        {isWebApp() && <UrlSync />}
                        {isNative && !IS_EXTENSION && <CrashResume />}
                        <Routes>
                          <Route path="/" element={<Start />} />
                          <Route
                            path="/create-wallet"
                            element={<CreateAccount onNavigateBack={() => null} newWallet />}
                          />
                          <Route
                            path="/restore-wallet"
                            element={<RestoreAccount onNavigateBack={() => null} newWallet />}
                          />
                          <Route
                            path="/import-wallet"
                            element={<ImportAccount onNavigateBack={() => null} newWallet />}
                          />
                          <Route path="/master-restore" element={<MasterRestore />} />
                          <Route path="/sweep" element={<SweepMigration />} />
                          <Route
                            path="/bsv-wallet"
                            element={
                              <Suspense fallback={<div className="w-full h-full" style={{ backgroundColor: walletBg }} />}>
                                <BsvWallet />
                              </Suspense>
                            }
                          />
                          <Route path="/ord-wallet" element={<OrdWallet />} />
                          <Route path="/tools" element={<AppsAndTools />} />
                          <Route path="/settings" element={<Settings />} />
                          <Route
                            path="/browser"
                            element={
                              <Suspense fallback={<PageLoader message="Loading..." theme={theme} />}>
                                <BrowserPage />
                              </Suspense>
                            }
                          />
                        </Routes>
                      </Router>
                    </Show>
                  </UsbGate>
                </Show>
              </SnackbarProvider>
            </div>
          </BottomMenuProvider>
        </SyncProvider>
      </BlockHeightProvider>
    </div>
  );
};
