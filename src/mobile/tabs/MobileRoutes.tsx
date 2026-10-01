import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

/** Mobile-only tab routes, mounted by vite.config.mobile.ts at /m/* in App.tsx. */
const SettingsHub = lazy(() => import('./SettingsHub'));
const MediaPage = lazy(() => import('../media/MediaPage'));
const MarketPage = lazy(() => import('../market/MarketPage'));

const MobileRoutes = () => (
  <Suspense fallback={null}>
    <Routes>
      <Route path="settings" element={<SettingsHub />} />
      <Route path="media" element={<MediaPage />} />
      <Route path="market" element={<MarketPage />} />
    </Routes>
  </Suspense>
);

export default MobileRoutes;
