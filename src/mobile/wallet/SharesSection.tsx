import { lazy, Suspense } from 'react';
import { PLACEMENT_ENABLED } from '../storeBuild';

// bShares holdings under the bShares balance card. Lazy behind the inlined flag: not in the store bundle.
const SharesList = PLACEMENT_ENABLED ? lazy(() => import('../placement/SharesList')) : null;

export const SharesSection = () =>
  SharesList ? (
    <Suspense fallback={null}>
      <SharesList />
    </Suspense>
  ) : null;
