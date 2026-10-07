import { lazy, Suspense, type ReactNode } from 'react';
import { PeekContext, setPageEl } from './pageEl';
import { MARKET_ENABLED } from '../storeBuild';
import { TermsGate } from '../ugc/UgcSheets';
import { usePhoneLayout } from './flag';
import type { ScreenId } from './screens';

/**
 * iOS-style paging for the phone layout (docs/PHONE-LAYOUT-PLAN.md §14.3). The routed page sits in <PhonePage>
 * (patched round upstream's <Routes> in vite.config.mobile.ts); while a finger drags it sideways, PhoneShell
 * moves it with transforms and shows the neighbour page beside it, rendered from screenElement() inside a
 * PeekContext so its TopNav stays out of the way (the real bar is portalled to <body> and never moves).
 * On release the pair snaps (transform transition), then the route changes to the new page.
 */

export const PhonePage = ({ children }: { children: ReactNode }) => {
  const on = usePhoneLayout();
  if (!on) return <>{children}</>;
  return (
    // No transform or will-change at rest: either would trap the page's fixed sheets under the dock.
    <div ref={setPageEl} data-phone-page className="relative w-full h-full">
      {children}
    </div>
  );
};

// The same components the routes use (App.tsx, tabs/MobileRoutes.tsx). Lazy, so the chunks are shared.
const BsvWallet = lazy(() => import('../../pages/BsvWallet').then((m) => ({ default: m.BsvWallet })));
// No Market in a store build: written inline so Rollup leaves the chunk out (same rule as MobileRoutes).
const MarketPage = MARKET_ENABLED ? lazy(() => import('../market/MarketPage')) : null;
const HomeScreen = lazy(() => import('./HomeScreen'));
const BrowserPage = lazy(() => import('../BrowserPage'));
const PeopleScreen = lazy(() => import('./PeopleScreen'));
const FeedTab = lazy(() => import('../feed/FeedTab'));
const ChatPage = lazy(() => import('../tabs/ChatPage'));

const element = (id: ScreenId): ReactNode => {
  switch (id) {
    case 'wallet':
      return <BsvWallet />;
    case 'exchange':
      return MarketPage ? <MarketPage /> : null;
    case 'home':
      return <HomeScreen />;
    case 'apps':
      return <BrowserPage only="apps" />;
    case 'games':
      return <BrowserPage only="games" />;
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
  }
};

/** A neighbour page for the drag preview. */
export const ScreenPeek = ({ id }: { id: ScreenId }) => (
  <PeekContext.Provider value={true}>
    <Suspense fallback={<div className="w-full h-full" style={{ background: '#010101' }} />}>{element(id)}</Suspense>
  </PeekContext.Provider>
);
