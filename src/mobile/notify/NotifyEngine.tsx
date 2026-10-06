import { useEffect, useMemo } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useIdentity } from '../../hooks/useIdentity';
import { useAccountNames } from '../names/accountNames';
import { usePrefs } from '../settings/usePrefs';
import { loadSession } from '../chat/api';
import { mentionNames } from './notify';
import { startNotify, stopNotify } from './engine';

/**
 * App-wide, renders nothing: keeps the notification poller (engine.ts) running for the unlocked
 * account with its current addresses, BAP id, names and Twetch id. Mounted next to CallScreen
 * (vite.config.mobile.ts), which App renders only while unlocked.
 */
const NotifyEngine = () => {
  const { apiContext, isLocked, chromeStorageService } = useServiceContext();
  const account = chromeStorageService?.getCurrentAccountObject?.()?.account;
  const a = account?.addresses;
  const identity = useIdentity(apiContext, chromeStorageService);
  const { paymail, handle } = useAccountNames(a?.identityAddress, '', '', false);
  const [prefs] = usePrefs();
  const addresses = useMemo(
    () => [a?.identityAddress, a?.bsvAddress, a?.ordAddress].filter((x): x is string => !!x),
    [a?.identityAddress, a?.bsvAddress, a?.ordAddress],
  );
  const chatHandle = loadSession()?.handle ?? null;
  const names = useMemo(
    () => mentionNames([paymail, handle, chatHandle, identity.profile.name]),
    [paymail, handle, chatHandle, identity.profile.name],
  );
  useEffect(() => {
    if (isLocked || !apiContext?.wallet || !addresses.length) return stopNotify();
    startNotify({
      addresses,
      bapId: identity.bapId,
      names,
      twetchUserId: prefs.twetchUserId || null,
      ctx: apiContext,
    });
  }, [apiContext, isLocked, addresses, identity.bapId, names, prefs.twetchUserId]);
  useEffect(() => stopNotify, []);
  return null;
};

export default NotifyEngine;
