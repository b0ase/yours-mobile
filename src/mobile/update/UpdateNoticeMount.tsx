import { lazy, Suspense } from 'react';
import { UPDATE_NOTICE_ENABLED } from '../storeBuild';

/**
 * App-wide mount for the "newer bWalletX" banner (NewerBuildBanner.tsx). Behind a literal env check so a store build has
 * no banner chunk at all (storeBuild.ts UPDATE_NOTICE_ENABLED).
 */
const NewerBuildBanner = UPDATE_NOTICE_ENABLED ? lazy(() => import('./NewerBuildBanner')) : null;

export const UpdateNoticeMount = () =>
  NewerBuildBanner ? (
    <Suspense fallback={null}>
      <NewerBuildBanner />
    </Suspense>
  ) : null;
