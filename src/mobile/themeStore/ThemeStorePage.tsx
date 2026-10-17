import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { THEME_STORE_PAID_ENABLED } from '../storeBuild';

// bWalletX only: a lazy chunk behind the inlined flag, so a store build (App Store / Play) has none of its text
// and /m/store goes home (owner, 16-17 Oct 2026: no bStore in store builds).
const BStore = THEME_STORE_PAID_ENABLED ? lazy(() => import('./StoreFront')) : null;

export default function ThemeStorePage() {
  if (!BStore) return <Navigate to="/m/home" replace />;
  return (
    <Suspense fallback={null}>
      <BStore />
    </Suspense>
  );
}
