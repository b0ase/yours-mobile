import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { WalletNftsRedirect } from '../wallet/KindSwitch';

/** Mobile-only tab routes, mounted by vite.config.mobile.ts at /m/* in App.tsx. */
const SettingsHub = lazy(() => import('./SettingsHub'));
const MarketPage = lazy(() => import('../market/MarketPage'));
const FeedTab = lazy(() => import('../feed/FeedTab'));
const ChatPage = lazy(() => import('./ChatPage'));

const MobileRoutes = () => (
  <Suspense fallback={null}>
    <Routes>
      <Route path="settings" element={<SettingsHub />} />
      {/* The old Media tab now lives in Wallet › NFTs. */}
      <Route path="media" element={<WalletNftsRedirect />} />
      <Route path="market" element={<MarketPage />} />
      <Route path="feed" element={<FeedTab />} />
      <Route path="chat" element={<ChatPage />} />
    </Routes>
  </Suspense>
);

export default MobileRoutes;
