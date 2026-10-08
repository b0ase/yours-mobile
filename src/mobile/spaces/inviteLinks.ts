/**
 * Space invite links opening the app: bwalletx://space/<code> (registered on iOS and Android) and,
 * once bwalletx.com serves the app-site files for /s/*, https://bwalletx.com/s/<code>. Held until a
 * screen with the router takes it and opens the Space view on that invite.
 *
 * Off entirely in a store build (BSPACES_ENABLED is inlined, so this listener is dropped).
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { BSPACES_ENABLED } from '../storeBuild';
import { spaceInviteCode } from './invite';

let pending: string | null = null;
const listeners = new Set<() => void>();

export const offerSpaceInviteUrl = (url?: string | null) => {
  const code = spaceInviteCode(url);
  if (!code) return;
  pending = code;
  listeners.forEach((l) => l());
};

export const takeSpaceInvite = () => {
  const c = pending;
  pending = null;
  return c;
};

export const onSpaceInvite = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

if (BSPACES_ENABLED && Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => offerSpaceInviteUrl(url));
  void CapApp.getLaunchUrl().then((r) => offerSpaceInviteUrl(r?.url));
}

/** Mounted once by the top bar (or PhoneShell): an invite link goes to the Spaces screen. */
export const useSpaceInviteLinks = (enabled = true) => {
  const navigate = useNavigate();
  useEffect(() => {
    if (!BSPACES_ENABLED || !enabled) return;
    const go = () => {
      const code = takeSpaceInvite();
      if (code) navigate(`/m/spaces?invite=${code}`);
    };
    go();
    return onSpaceInvite(go);
  }, [navigate, enabled]);
};
