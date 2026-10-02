import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ChevronLeft, Maximize2, RotateCw, X } from 'lucide-react';
import { pushBackCloser } from '../backStack';
import { handleSiteCall, lastUrlFor } from '../dappBrowser';
import {
  BAPP_FRAME_ALLOWLIST,
  bappFullScreen,
  closeBapp,
  getBappFrameState,
  reloadBapp,
  subscribeBappFrame,
} from './bappFrame';
import { isAllowedFrameOrigin, parseXdmRequest, toXdmResponse } from './frameBridge';

/**
 * The in-frame bApp: a slim header row and a cross-origin iframe filling the space between
 * TopNav (h-14 + safe inset) and the tab bar (3.75rem). Mounted with the tab bar so it survives
 * tab switches; shown only on the Apps tab. z-[90]: under the tab bar (100) and every overlay.
 */
export const BappFrameHost = () => {
  const { session, visible, opening } = useSyncExternalStore(subscribeBappFrame, getBappFrameState);
  const frame = useRef<HTMLIFrameElement>(null);

  // Wallet bridge (BRC-100 XDM): only our iframe, only its allowlisted origin.
  useEffect(() => {
    if (!session) return;
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      if (e.origin !== session.origin || !isAllowedFrameOrigin(e.origin, BAPP_FRAME_ALLOWLIST)) return;
      const req = parseXdmRequest(e.data);
      if (!req) return;
      const pageUrl = lastUrlFor(e.origin) ?? session.url;
      handleSiteCall(e.origin, pageUrl, req.call, req.args)
        .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }))
        .then((reply) => win.postMessage(toXdmResponse(req.id, reply), e.origin));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session]);

  // Back: the iframe's history first (it shares the joint session history; the wallet's
  // MemoryRouter adds no entries of its own), then close.
  const nav = useRef({ baseline: -1, lastLen: -1, depth: 0, pendingBack: 0 });
  const onLoad = () => {
    const n = nav.current;
    const len = window.history.length;
    if (n.baseline < 0) n.baseline = len;
    if (Date.now() < n.pendingBack) n.pendingBack = 0;
    else n.depth = Math.max(0, len - n.baseline);
    n.lastLen = len;
  };
  const back = () => {
    const n = nav.current;
    const len = window.history.length;
    if (n.baseline >= 0 && len !== n.lastLen) n.depth = Math.max(0, len - n.baseline); // in-page (pushState) navs
    n.lastLen = len;
    if (n.depth > 0) {
      n.depth -= 1;
      n.pendingBack = Date.now() + 1500;
      window.history.back();
      return true;
    }
    closeBapp();
    return false;
  };
  useEffect(() => {
    nav.current = { baseline: -1, lastLen: -1, depth: 0, pendingBack: 0 };
  }, [session?.key]);
  const backRef = useRef(back);
  backRef.current = back;
  const active = !!session && visible;
  useEffect(() => {
    if (!active) return;
    let unregister = () => {};
    const register = () => {
      unregister = pushBackCloser(() => {
        if (backRef.current()) register(); // still open: stay on the Back stack
      });
    };
    register();
    return () => unregister();
  }, [active]);

  const current = session ? (lastUrlFor(session.origin) ?? session.url) : '';

  return (
    <>
      {opening && visible && !session && (
        <div
          className="absolute left-0 right-0 z-[90] flex items-center justify-center text-[12px] text-[#98A2B3]"
          style={{
            top: 'calc(var(--wallet-inset-top, 0px) + 3.5rem)',
            height: '2.25rem',
            background: 'rgba(1,1,1,0.85)',
          }}
        >
          Opening {opening}…
        </div>
      )}
      {session && (
        <div
          className="absolute left-0 right-0 z-[90] flex flex-col"
          style={{
            top: 'calc(var(--wallet-inset-top, 0px) + 3.5rem)',
            bottom: '3.75rem',
            background: '#010101',
            visibility: visible ? 'visible' : 'hidden',
            pointerEvents: visible ? 'auto' : 'none',
          }}
          aria-hidden={!visible}
        >
          <div className="flex h-9 shrink-0 items-center gap-1 px-1 border-b border-[#1C1C1E]">
            <button type="button" onClick={back} className="w-9 h-9 flex items-center justify-center" aria-label="Back">
              <ChevronLeft size={18} color="#F2F2F0" />
            </button>
            <span className="flex-1 truncate text-[13px] font-semibold text-[#F2F2F0]">{session.name}</span>
            <button
              type="button"
              onClick={() => reloadBapp(current)}
              className="w-9 h-9 flex items-center justify-center"
              aria-label="Reload"
            >
              <RotateCw size={15} color="#98A2B3" />
            </button>
            <button
              type="button"
              onClick={() => void bappFullScreen(current)}
              className="w-9 h-9 flex items-center justify-center"
              aria-label="Open full screen"
            >
              <Maximize2 size={15} color="#98A2B3" />
            </button>
            <button
              type="button"
              onClick={closeBapp}
              className="w-9 h-9 flex items-center justify-center"
              aria-label="Close"
            >
              <X size={18} color="#F2F2F0" />
            </button>
          </div>
          <iframe
            key={session.key}
            ref={frame}
            src={session.url}
            title={session.name}
            onLoad={onLoad}
            className="w-full flex-1 border-0 bg-white"
            // Same rights as a top-level page in the full-screen browser, minus top navigation.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            allow="camera; microphone; clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      )}
    </>
  );
};
