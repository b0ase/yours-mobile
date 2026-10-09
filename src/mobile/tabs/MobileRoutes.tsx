import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { TermsGate } from '../ugc/UgcSheets';
import { SectionBoundary } from '../wallet/SectionBoundary';
import { BSPACES_ENABLED, MARKET_ENABLED } from '../storeBuild';

/** Mobile-only tab routes, mounted by vite.config.mobile.ts at /m/* in App.tsx. */
const SettingsHub = lazy(() => import('./SettingsHub'));
// bSpaces (Apps › bSpaces): bWalletX only, not even built into a store edition.
const SpacesPage = BSPACES_ENABLED ? lazy(() => import('../spaces/SpacesPage')) : null;
// No Market in a store build (storeBuild.ts MARKET_ENABLED): the chunk is not even built.
const MarketPage = MARKET_ENABLED ? lazy(() => import('../market/MarketPage')) : null;
const FeedTab = lazy(() => import('../feed/FeedTab'));
const ChatPage = lazy(() => import('./ChatPage'));
const MediaPage = lazy(() => import('../media/MediaPage'));
const AgentPage = lazy(() => import('../agent/AgentPage'));
// The top bar's mailbox: bMail in the content area, between the top bar and the tab bar.
const BMailPage = lazy(() => import('../bmail/BMailPage'));
// The top bar's phone button: bPhone Calls in the content area (active calls stay full-screen via CallScreen).
const CallsPage = lazy(() => import('../calls/CallsPage'));
// Phone layout (phone/, Settings › Testing switch): HOME, Games and People swipe screens. Apps stays /browser.
const HomeScreen = lazy(() => import('../phone/HomeScreen'));
const PeopleScreen = lazy(() => import('../phone/PeopleScreen'));
const BrowserPage = lazy(() => import('../BrowserPage'));
// The phone top bar's Lock BSV button (locks/, docs/TIME-LOCK-PLAN.md).
const LockScreen = lazy(() => import('../locks/LockScreen'));
const LockVerify = () => <LockScreen initialVerify={new URLSearchParams(window.location.search).get('tx') ?? ''} />;

// No app-wide error boundary upstream: one throw blanked the whole page (owner, 6 Oct 2026).
const MobileRoutes = () => (
  <SectionBoundary name="mobile tab" screen>
    <Suspense fallback={null}>
      <Routes>
        <Route path="settings" element={<SettingsHub />} />
        {/* The top bar's Play button: music & video. */}
        <Route path="media" element={<MediaPage />} />
        {/* The top bar's centre b: the b agent. */}
        <Route path="agent" element={<AgentPage />} />
        <Route path="bmail" element={<BMailPage />} />
        <Route path="calls" element={<CallsPage />} />
        <Route path="lock" element={<LockScreen />} />
        <Route path="lock/verify" element={<LockVerify />} />
        <Route path="home" element={<HomeScreen />} />
        <Route path="apps" element={<BrowserPage only="apps" />} />
        {/* Phone layout app screens 2, 3… (phone/pager.tsx renders them; this is the fallback with the switch off). */}
        <Route path="screen/:n" element={<BrowserPage only="apps" />} />
        <Route path="games" element={<BrowserPage only="games" />} />
        <Route path="people" element={<PeopleScreen />} />
        {MarketPage && <Route path="market" element={<MarketPage />} />}
        {SpacesPage && <Route path="spaces" element={<SpacesPage />} />}
        {/* Shared spaces: the terms (zero tolerance, Apple 1.2) are agreed once before first use. */}
        <Route
          path="feed"
          element={
            <TermsGate>
              <FeedTab />
            </TermsGate>
          }
        />
        <Route
          path="chat"
          element={
            <TermsGate>
              <ChatPage />
            </TermsGate>
          }
        />
      </Routes>
    </Suspense>
  </SectionBoundary>
);

export default MobileRoutes;
