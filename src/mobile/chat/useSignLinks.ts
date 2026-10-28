import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { openDappBrowser } from '../dappBrowser';
import { requestRoomByTicker } from './segmentNav';
import { offerSignLink, onSignLink, phoneSignUrl, takeSignLink } from './signLink';

/**
 * A "Sign on your phone" QR opened the app (chat/signLink.ts): open the room on that document, then the bChatX
 * signing page in the wallet's own browser, where the user reads, signs and seals. Every build: a signable
 * document isn't a token-room feature.
 */
if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => void offerSignLink(url));
  void CapApp.getLaunchUrl().then((r) => void offerSignLink(r?.url));
}

/** Mounted once by the top bar (or PhoneShell's app services), next to useSpaceInviteLinks. */
export const useSignLinks = (enabled = true) => {
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    const go = () => {
      const s = takeSignLink();
      if (!s) return;
      requestRoomByTicker(s.ticker, false, s.docId);
      navigate('/m/chat');
      openDappBrowser(phoneSignUrl(s)).catch((e) => console.error('[sign link]', e));
    };
    go();
    return onSignLink(go);
  }, [navigate, enabled]);
};
