import { lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import type { SpaceScreenProps } from './SpaceScreen';

/**
 * SpaceScreen loads when a Space opens, not at app start: it pulls in livekit-client (~0.55 MB) through
 * spaces/media.ts. The fallback is the Space screen's own backdrop, so opening one shows no flash.
 */
const Screen = lazy(() => import('./SpaceScreen').then((m) => ({ default: m.SpaceScreen })));

const Backdrop = () =>
  createPortal(
    <div
      className="fixed inset-0"
      style={{ zIndex: 1000, background: 'radial-gradient(140% 70% at 50% 0%, #1a160a 0%, #050505 65%)' }}
      aria-hidden
    />,
    document.body,
  );

export const SpaceScreen = (props: SpaceScreenProps) => (
  <Suspense fallback={<Backdrop />}>
    <Screen {...props} />
  </Suspense>
);
