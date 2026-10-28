import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { openDappBrowser } from '../dappBrowser';
import { requestRoomByTicker } from './segmentNav';
import { offerSignLink, onSignLink, parseWebBappLink, phoneSignUrl, takeSignLink } from './signLink';

/**
 * A "Sign on your phone" QR opened the app (chat/signLink.ts): open the room on that document, then the bChatX
 * signing page in the wallet's own browser, where the user reads, signs and seals. Every build: a signable
 * document isn't a token-room feature.
 */
// Any other web.bwalletx.com/bapp/<slug>?to=… link opens that bApp's frame screen in the app (/m/bapp/<slug>).
let bappRoute: string | null = null;
const bappListeners = new Set<() => void>();
/** Hand a link (camera, or the in-app scanner) to the sign / bApp routing below. */
export const offerSignOrBappLink = (url?: string | null) => {
  if (offerSignLink(url)) return;
  const b = parseWebBappLink(url);
  if (!b) return;
  bappRoute = b.route;
  bappListeners.forEach((l) => l());
};

if (Capacitor.isNativePlatform()) {
  void CapApp.addListener('appUrlOpen', ({ url }) => offerSignOrBappLink(url));
  void CapApp.getLaunchUrl().then((r) => offerSignOrBappLink(r?.url));
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
    const goBapp = () => {
      const r = bappRoute;
      bappRoute = null;
      if (r) navigate(r);
    };
    go();
    goBapp();
    bappListeners.add(goBapp);
    const off = onSignLink(go);
    return () => {
      off();
      bappListeners.delete(goBapp);
    };
  }, [navigate, enabled]);
};
