import { lazy, Suspense } from 'react';
import { nativeChatEnabled } from './flag';

// Lazy: with the switch off (the default) this chunk is never fetched. A literal env check so a store build, where the
// switch is always off, drops the chunk (and its debug text) entirely (store grep).
const NATIVE_CHAT_UI: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);
const NativeChatHost = NATIVE_CHAT_UI ? lazy(() => import('./NativeChatHost')) : null;

/** Beside the Chat page. Off (the default): renders nothing, and Chat is exactly the WebView it was. */
export const NativeChatMount = () =>
  NativeChatHost && nativeChatEnabled() ? (
    <Suspense fallback={null}>
      <NativeChatHost />
    </Suspense>
  ) : null;
