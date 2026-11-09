import { lazy, Suspense } from 'react';
import { nativeChatEnabled } from './flag';

// Lazy: with the switch off (the default) this chunk is never fetched.
const NativeChatHost = lazy(() => import('./NativeChatHost'));

/** Beside the Chat page. Off (the default): renders nothing, and Chat is exactly the WebView it was. */
export const NativeChatMount = () =>
  nativeChatEnabled() ? (
    <Suspense fallback={null}>
      <NativeChatHost />
    </Suspense>
  ) : null;
