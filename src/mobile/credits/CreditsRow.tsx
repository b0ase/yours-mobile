import { Suspense, lazy } from 'react';
import { BCREDITS_ENABLED } from '../storeBuild';

/**
 * Wallet › Credits (build-time insert into BsvWallet.tsx, vite.config.mobile.ts; desktop /m/credits): the
 * bCredits card, Top up and history. The UI is a lazy chunk behind the literal BCREDITS_ENABLED flag, so a
 * store build (no paying bCorp in the app, storeBuild.ts) has none of it, not even its strings.
 */
const CreditsPanel = BCREDITS_ENABLED ? lazy(() => import('./CreditsPanel')) : null;

export const CreditsRow = () =>
  BCREDITS_ENABLED && CreditsPanel ? (
    <Suspense fallback={null}>
      <CreditsPanel />
    </Suspense>
  ) : null;
