import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

/** Mobile-only tab routes, mounted by vite.config.mobile.ts at /m/* in App.tsx. */
const SettingsHub = lazy(() => import('./SettingsHub'));
const MarketPage = lazy(() => import('../market/MarketPage'));
const FeedTab = lazy(() => import('../feed/FeedTab'));
const ChatPage = lazy(() => import('./ChatPage'));
const MediaPage = lazy(() => import('../media/MediaPage'));

const MobileRoutes = () => (
  <Suspense fallback={null}>
    <Routes>
      <Route path="settings" element={<SettingsHub />} />
      {/* The top bar's Play button: music & video. */}
      <Route path="media" element={<MediaPage />} />
      <Route path="market" element={<MarketPage />} />
      <Route path="feed" element={<FeedTab />} />
      <Route path="chat" element={<ChatPage />} />
    </Routes>
  </Suspense>
);

export default MobileRoutes;
