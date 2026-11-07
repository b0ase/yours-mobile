import { useEffect } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTermsAccepted } from '../ugc/useTermsAccepted';
import { onChatAccountChange } from './chatAccount';
import { ensureChatSession } from './chatSession';

/**
 * Gets the native Chat's bChatX session in the background (chatSession.ts): once the wallet is open and its terms
 * agreed, on every account switch, and when the phone comes back online. Renders nothing. Mounted once (App.tsx).
 */
const ChatSessionWarmer = () => {
  const { apiContext, isLocked, isSwitchingAccount } = useServiceContext();
  const agreed = useTermsAccepted();
  useEffect(() => {
    if (isLocked || isSwitchingAccount || !agreed || !apiContext?.wallet) return;
    const go = () => {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) void ensureChatSession(apiContext);
    };
    // After the first paint: the wallet's own screen comes first.
    const t = setTimeout(go, 1200);
    const offAccount = onChatAccountChange(go);
    window.addEventListener('online', go);
    return () => {
      clearTimeout(t);
      offAccount();
      window.removeEventListener('online', go);
    };
  }, [apiContext, isLocked, isSwitchingAccount, agreed]);
  return null;
};

export default ChatSessionWarmer;
