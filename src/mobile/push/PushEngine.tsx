import { useContext, useEffect, useMemo } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { loadSession, SESSION_EVENT } from '../chat/api';
import { requestRoomByTicker } from '../chat/segmentNav';
import { asMenuItem } from '../tabs/tabs';
import { requestSignIns } from '../settings/signIns';
import { isNative } from '../native';
import { onSocialChange, socialReturnWaiting } from '../social/socialLogin';
import { routeFromQuery, type PushRoute } from './logic';
import { onPushRoute, syncPush, takeRouteFrom } from './register';

/**
 * App-wide, renders nothing (mounted next to NotifyEngine, vite.config.mobile.ts): keeps this device's
 * push registration in step with the bChat sign-in of the current account, and opens the room or DM a
 * tapped notification is about.
 */
const PushEngine = () => {
  const { chromeStorageService } = useServiceContext();
  // The context, not useBottomMenu: PushEngine mounts above <Router> (beside NotifyEngine), and
  // useBottomMenu calls useNavigate, which throws there and blanked the whole wallet after unlock.
  // Selecting the tab is enough: the TopNav/tab bar's useBottomMenu (inside the router) routes it.
  const ctxSelect = useContext(BottomMenuContext)?.handleSelect;
  const handleSelect = useMemo(() => ctxSelect ?? (() => {}), [ctxSelect]);
  const identityAddress = chromeStorageService?.getCurrentAccountObject?.()?.account?.addresses?.identityAddress;

  // Registration follows the bChat session (shared by the app, like the Chat tab's): sign-in registers
  // (native asks for permission once), sign-out removes the row, a new handle moves it. Re-checked when
  // the account changes.
  useEffect(() => {
    const sync = (ask: boolean) => void syncPush(loadSession(), { ask: ask && isNative });
    sync(true);
    const onSession = () => sync(true);
    window.addEventListener(SESSION_EVENT, onSession);
    return () => window.removeEventListener(SESSION_EVENT, onSession);
  }, [identityAddress]);

  // Back from X / Google (Settings › Connect, which the page reload closed): after the password unlock, go to
  // Settings, where Connect reopens with the verified profile (FeedSettings takes the return). One trip.
  useEffect(() => {
    if (!identityAddress) return;
    const go = () => socialReturnWaiting(identityAddress) && handleSelect(asMenuItem('settings'));
    go();
    return onSocialChange(go);
  }, [identityAddress, handleSelect]);

  // Tap → Chat tab → the room (or the DM) → open it.
  useEffect(() => {
    const go = (r: PushRoute) => {
      if (r.segment === 'signins') {
        handleSelect(asMenuItem('settings'));
        requestSignIns();
        return;
      }
      handleSelect(asMenuItem('chat'));
      requestRoomByTicker(r.ticker, r.segment === 'dms');
    };
    const off = onPushRoute(go);
    // Web Push: the service worker opened this page with ?push=… or posts to an open one.
    try {
      const r = routeFromQuery(window.location.search);
      if (r) {
        const url = new URL(window.location.href);
        url.searchParams.delete('push');
        window.history.replaceState(null, '', url.toString());
        takeRouteFrom(r);
      }
    } catch {
      /* no location */
    }
    const onSwMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; query?: string } | null;
      if (d?.type === 'bwallet-push-route' && typeof d.query === 'string') takeRouteFrom(routeFromQuery(d.query));
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => {
      off();
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, [handleSelect]);

  return null;
};

export default PushEngine;
