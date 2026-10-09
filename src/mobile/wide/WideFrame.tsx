import { lazy, Suspense, type ReactNode } from 'react';
import { WIDE_ON } from './flag';

// Only fetched in the wide layout; everyone else gets the children untouched.
const WideShell = lazy(() => import('./WideShell'));

/** Wraps the app's routes (vite.config.mobile.ts patches App.tsx). A no-op unless the wide layout is on. */
export const WideFrame = ({ children }: { children: ReactNode }) =>
  WIDE_ON ? (
    <Suspense fallback={null}>
      <WideShell>{children}</WideShell>
    </Suspense>
  ) : (
    <>{children}</>
  );
