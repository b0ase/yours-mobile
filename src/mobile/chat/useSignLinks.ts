import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { openDappBrowser } from '../dappBrowser';
import { NATIVE_SEAL_ENABLED } from '../storeBuild';
import { requestRoomByTicker } from './segmentNav';
import { offerSignLink, onSignLink, parseWebBappLink, phoneSignUrl, signFrameRoute, takeSignLink } from './signLink';

/**
 * A "Sign on your phone" QR opened the app (chat/signLink.ts): open the room on that document, then the bChatX
 * signing page inside the bChatX bApp frame (the wallet's own browser only if bChatX can't be framed), where the
 * user reads, signs and seals. Every build: a signable
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
      // The wallet's own Review & sign screen (chat/NativeSealPage.tsx): no web page on the phone (3 Nov 2026). Not in
      // a store build (NATIVE_SEAL_ENABLED): there the link opens bChatX's page in the frame, as before.
      if (NATIVE_SEAL_ENABLED && s.docId)
        return navigate(`/m/seal/${encodeURIComponent(s.ticker)}/${encodeURIComponent(s.docId)}`);
      requestRoomByTicker(s.ticker, false, s.docId);
      // In the bChatX frame, not the native browser: approval sheets draw over the frame, so Seal reaches the
      // wallet (iPhone, 1 Nov 2026: in the browser the seal waited 90 s and timed out).
      const route = signFrameRoute(s);
      if (route) return navigate(route);
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
