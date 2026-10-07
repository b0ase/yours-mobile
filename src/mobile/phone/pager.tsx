import { lazy, Suspense, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { hasLanded, keptPages, keptSnapshot, keptSubscribe, PeekContext, setPageEl } from './pageEl';
import { MARKET_ENABLED } from '../storeBuild';
import { TermsGate } from '../ugc/UgcSheets';
import { APPS_PAGED, usePhoneLayout } from './flag';
import { useAppScreens } from './appScreensStore';
import { appIndexForPath, pageForPath, type ScreenId } from './screens';

/**
 * Keep-alive and iOS-style paging (docs/PHONE-LAYOUT-PLAN.md §14.3, §14.4). <PhonePage> is patched round
 * upstream's <Routes> (vite.config.mobile.ts). With the phone layout on it renders, instead of the routed copy:
 *  - the app screens (Home, then the user's others) side by side in a track, all mounted, over one still
 *    wallpaper. Only these swipe: PhoneShell moves the track (data-dragging shows the neighbours, mobile.css);
 *  - the pages (Wallet, Exchange, Feed, Chat, People), each mounted the first time it opens and then kept, hidden
 *    while another is on screen, so it reopens instantly with its data, scroll and images as they were.
 * Anything else (Settings, the agent, onboarding…) is the routed page as before; the kept ones stay mounted but
 * hidden. At rest the page on screen has no transform, so its fixed sheets still sit above the dock. Only the page
 * on screen counts as on screen (PeekContext: its TopNav renders, it owns the bApp frame).
 */

const mountedScreens = new Set<number>();

const BrowserPage = lazy(() => import('../BrowserPage'));
const Wallpaper = lazy(() => import('../BrowserPage').then((m) => ({ default: m.AppsWallpaper })));
// The same components the routes use (App.tsx, tabs/MobileRoutes.tsx). Lazy, so the chunks are shared.
const BsvWallet = lazy(() => import('../../pages/BsvWallet').then((m) => ({ default: m.BsvWallet })));
// No Market in a store build: written inline so Rollup leaves the chunk out (same rule as MobileRoutes).
const MarketPage = MARKET_ENABLED ? lazy(() => import('../market/MarketPage')) : null;
const PeopleScreen = lazy(() => import('./PeopleScreen'));
const FeedTab = lazy(() => import('../feed/FeedTab'));
const ChatPage = lazy(() => import('../tabs/ChatPage'));

const pageElement = (id: ScreenId): ReactNode => {
  switch (id) {
    case 'wallet':
      return <BsvWallet />;
    case 'exchange':
      return MarketPage ? <MarketPage /> : null;
    case 'people':
      return <PeopleScreen />;
    case 'feed':
      return (
        <TermsGate>
          <FeedTab />
        </TermsGate>
      );
    case 'chat':
      return (
        <TermsGate>
          <ChatPage />
        </TermsGate>
      );
    default:
      return null;
  }
};

export const PhonePage = ({ children }: { children: ReactNode }) => {
  const on = usePhoneLayout();
  const { pathname } = useLocation();
  const screens = useAppScreens().screens;
  useSyncExternalStore(keptSubscribe, keptSnapshot, keptSnapshot);
  if (!on) return <>{children}</>;
  const idx = appIndexForPath(pathname, screens.length);
  const page = idx === null ? pageForPath(pathname) : null;
  // The Wallet route a cold start opens on is about to become Home: don't mount it behind Home.
  if (page && (hasLanded() || page.id !== 'wallet')) keptPages.add(page.id);
  // App screens: the one on show and its neighbours are mounted; once mounted, a screen stays mounted.
  if (idx !== null) for (const i of [idx - 1, idx, idx + 1]) if (i >= 0 && i < screens.length) mountedScreens.add(i);
  return (
    <>
      {idx === null && !page && children}
      {/* App screens: one wallpaper that stays still, and the track that moves. */}
      <div className="absolute inset-0" style={idx === null ? { display: 'none' } : undefined}>
        <Suspense fallback={null}>
          <Wallpaper />
        </Suspense>
        {!APPS_PAGED ? (
          // Round 8: one vertical Apps page, every screen a section (sticky headers). No track, no transforms.
          <div data-phone-screen={0} aria-hidden={idx === null || undefined} className="absolute inset-0">
            <PeekContext.Provider value={idx === null}>
              <Suspense fallback={null}>
                <BrowserPage screen={idx ?? 0} sections />
              </Suspense>
            </PeekContext.Provider>
          </div>
        ) : (
          <div ref={idx === null ? undefined : setPageEl} data-phone-track className="relative w-full h-full">
            {screens.map((_, i) => {
              if (!mountedScreens.has(i)) return null;
              const off = idx === null ? 1 : i - idx;
              return (
                <div
                  key={i}
                  data-phone-screen={i}
                  aria-hidden={off !== 0 || undefined}
                  className={`absolute inset-0 ${off === 0 ? '' : Math.abs(off) === 1 ? 'bw-page-off bw-page-near' : 'bw-page-off'}`}
                  style={off === 0 ? undefined : { transform: `translate3d(${off * 100}%,0,0)` }}
                >
                  <PeekContext.Provider value={off !== 0}>
                    <Suspense fallback={null}>
                      <BrowserPage screen={i} />
                    </Suspense>
                  </PeekContext.Provider>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* Pages: mounted once opened, then kept (hidden while another is on screen). */}
      {[...keptPages].map((id) => {
        const here = page?.id === id;
        return (
          <div
            key={id}
            data-phone-kept={id}
            aria-hidden={!here || undefined}
            className={`absolute inset-0 ${here ? '' : 'bw-page-off'}`}
          >
            <PeekContext.Provider value={!here}>
              <Suspense fallback={null}>{pageElement(id)}</Suspense>
            </PeekContext.Provider>
          </div>
        );
      })}
    </>
  );
};
