import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { TermsGate } from '../ugc/UgcSheets';
import { SectionBoundary } from '../wallet/SectionBoundary';
import { MARKET_ENABLED } from '../storeBuild';

/** Mobile-only tab routes, mounted by vite.config.mobile.ts at /m/* in App.tsx. */
const SettingsHub = lazy(() => import('./SettingsHub'));
// No Market in a store build (storeBuild.ts MARKET_ENABLED): the chunk is not even built.
const MarketPage = MARKET_ENABLED ? lazy(() => import('../market/MarketPage')) : null;
const FeedTab = lazy(() => import('../feed/FeedTab'));
const ChatPage = lazy(() => import('./ChatPage'));
const MediaPage = lazy(() => import('../media/MediaPage'));
const AgentPage = lazy(() => import('../agent/AgentPage'));
// Phone layout (phone/, Settings › Testing switch): HOME, Games and People swipe screens. Apps stays /browser.
const HomeScreen = lazy(() => import('../phone/HomeScreen'));
const PeopleScreen = lazy(() => import('../phone/PeopleScreen'));
const BrowserPage = lazy(() => import('../BrowserPage'));

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
        <Route path="home" element={<HomeScreen />} />
        <Route path="apps" element={<BrowserPage only="apps" />} />
        {/* Phone layout app screens 2, 3… (phone/pager.tsx renders them; this is the fallback with the switch off). */}
        <Route path="screen/:n" element={<BrowserPage only="apps" />} />
        <Route path="games" element={<BrowserPage only="games" />} />
        <Route path="people" element={<PeopleScreen />} />
        {MarketPage && <Route path="market" element={<MarketPage />} />}
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
