import { APP_NAME } from '../storeBuild';
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, Maximize2, Monitor, RotateCw, Smartphone, X } from 'lucide-react';
import { BAPPS } from '../bapps';
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
import { BWX_CHANGED, answerBwx, isBwxOrigin, parseBwx, type BwxDeps } from './bwxBridge';
import {
  allAgentsStopped,
  getAgentAccount,
  getAgentLog,
  ghostColorOf,
  listAgentsOnly,
  onAgentsChange,
  setAgentDailyCap,
  setAgentLabels,
  setAgentStopped,
  setAllAgentsStopped,
  spentToday,
} from '../agents/agentAccounts';
import { startAgentCreate } from '../agents/agentCreate';
import { accountTag, useAccountSwitch } from '../account/accountSwitch';
import { accountNamesFor } from '../names/accountNames';
import { loadLastBalance } from '../wallet/balanceLoad';
import { cachedExchangeRate } from '../../utils/wallet';
import { useServiceContext } from '../../hooks/useServiceContext';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';

/**
 * The in-frame bApp: a slim header row and a cross-origin iframe filling the space between
 * TopNav (h-14 + safe inset) and the tab bar (3.75rem). Mounted with the tab bar so it survives
 * tab switches; shown only on the Apps tab. z-[90]: under the tab bar (100) and every overlay.
 */
export const BappFrameHost = () => {
  const { session, visible, opening } = useSyncExternalStore(subscribeBappFrame, getBappFrameState);
  const frame = useRef<HTMLIFrameElement>(null);

  const bwxDeps = useBwxDeps();
  const [ask, setAsk] = useState<{ text: string; resolve: (ok: boolean) => void } | null>(null);
  const askRef = useRef(ask);
  askRef.current = ask;

  // Wallet bridge (BRC-100 XDM): only our iframe, only its allowlisted origin.
  useEffect(() => {
    if (!session) return;
    // One wallet-drawn sheet at a time; a second ask while one is open is refused.
    const confirm = (text: string) =>
      askRef.current
        ? Promise.resolve(false)
        : new Promise<boolean>((resolve) => {
            const a = { text, resolve };
            askRef.current = a;
            setAsk(a);
          });
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win || e.origin !== session.origin) return;
      // BWX (agent data): first-party bAgents only, refused for every other origin (docs/BAGENTS-PLAN.md).
      const bwx = parseBwx(e.data);
      if (bwx) {
        if (!isBwxOrigin(e.origin)) return;
        void answerBwx(bwx, { ...bwxDeps.current, confirm } satisfies BwxDeps).then((reply) =>
          win.postMessage(reply, e.origin),
        );
        return;
      }
      if (!isAllowedFrameOrigin(e.origin, BAPP_FRAME_ALLOWLIST)) return;
      const req = parseXdmRequest(e.data);
      if (!req) return;
      const pageUrl = lastUrlFor(e.origin) ?? session.url;
      handleSiteCall(e.origin, pageUrl, req.call, req.args)
        .catch((error: unknown) => ({ success: false, error: error instanceof Error ? error.message : String(error) }))
        .then((reply) => win.postMessage(toXdmResponse(req.id, reply), e.origin));
    };
    window.addEventListener('message', onMessage);
    // Push: tell bAgents when agent data changes, so it can re-read.
    const offAgents = isBwxOrigin(session.origin)
      ? onAgentsChange(() => frame.current?.contentWindow?.postMessage(BWX_CHANGED, session.origin))
      : () => {};
    return () => {
      window.removeEventListener('message', onMessage);
      offAgents();
      // The app went away: an open question is answered "no".
      askRef.current?.resolve(false);
      askRef.current = null;
      setAsk(null);
    };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const wide = useWide();
  const [layout, setLayout] = useAppLayout(session?.origin);
  const phone = wide && layout === 'mobile';

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
            bottom: 'var(--dock-h, 3.75rem)',
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
            {wide && (
              <button
                type="button"
                onClick={() => setLayout(phone ? 'desktop' : 'mobile')}
                className="w-9 h-9 flex items-center justify-center"
                aria-label={phone ? 'Show desktop size' : 'Show phone size'}
                title={phone ? 'Desktop size' : 'Phone size'}
              >
                {phone ? <Monitor size={15} color="#98A2B3" /> : <Smartphone size={15} color="#98A2B3" />}
              </button>
            )}
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
          <div className={phone ? 'flex-1 flex justify-center py-3 min-h-0' : 'contents'}>
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
              style={
                phone
                  ? { width: 430, maxWidth: '100%', flex: 'none', borderRadius: 18, border: '1px solid #2b2f36' }
                  : undefined
              }
            />
          </div>
        </div>
      )}
      {ask && (
        <BwxConfirmSheet
          text={ask.text}
          from={session?.name ?? 'bAgents'}
          onAnswer={(ok) => {
            ask.resolve(ok);
            askRef.current = null;
            setAsk(null);
          }}
        />
      )}
    </>
  );
};

/** The wallet's own confirmation for a BWX change (resume, raise a cap): drawn by the wallet, above the frame. */
const BwxConfirmSheet = ({ text, from, onAnswer }: { text: string; from: string; onAnswer: (ok: boolean) => void }) =>
  createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-end justify-center bg-black/60"
      onClick={() => onAnswer(false)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-md rounded-t-3xl bg-[#111113] px-5 pt-5 border-t border-[#1C1C1E]"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.25rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[12px] text-[#98A2B3] mb-1">
          {APP_NAME} · asked by {from}
        </div>
        <div className="text-[15px] font-semibold text-[#F2F2F0] mb-5">{text}</div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => onAnswer(false)}
            className="flex-1 rounded-2xl py-3 font-bold border border-[#2b2f36] text-[#F2F2F0] bg-transparent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onAnswer(true)}
            className="flex-1 rounded-2xl py-3 font-bold border-0 text-black"
            style={{ background: '#FFC107' }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );

/**
 * Real BWX deps over agentAccounts and the account list (confirm is added by the host). Kept in a ref
 * so the message listener sees fresh hooks without re-subscribing.
 */
const useBwxDeps = () => {
  const { chromeStorageService } = useServiceContext();
  // The context, not useBottomMenu/useNavigate: the bApp frame host mounts above <Router>, where
  // useNavigate throws; that blanked the wallet right after unlock (5.1.69). Selecting the tab is
  // enough: the tab bar's useBottomMenu, inside the router, does the routing.
  const handleSelect = useContext(BottomMenuContext)?.handleSelect ?? (() => {});
  const { switchAccount } = useAccountSwitch();
  const info = (id: string) => {
    const acct = chromeStorageService.getAllAccounts().find((a) => a.addresses.identityAddress === id);
    const n = accountNamesFor(id, acct?.name ?? '', acct?.settings?.socialProfile?.displayName ?? '');
    return { name: n.displayName, handle: accountTag(id, n.displayName, n.paymail, n.handle) };
  };
  const deps: Omit<BwxDeps, 'confirm'> = {
    listAgents: listAgentsOnly,
    getAgent: getAgentAccount,
    ghostColorOf,
    accountInfo: info,
    currentId: () => chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress,
    // The last balance the Wallet tab saw for that account (sats) at the last known rate; null when either is missing.
    balanceUsd: (id) => {
      const sats = loadLastBalance(id);
      const rate = cachedExchangeRate() || chromeStorageService.getCurrentAccountObject().exchangeRateCache?.rate || 0;
      return sats === null || !(rate > 0) ? null : Math.round((sats / 1e8) * rate * 100) / 100;
    },
    getLog: getAgentLog,
    spentToday: (log) => spentToday(log),
    allStopped: allAgentsStopped,
    setStopped: (id, stopped) => setAgentStopped(id, stopped),
    setAllStopped: setAllAgentsStopped,
    setCap: setAgentDailyCap,
    setLabels: setAgentLabels,
    // Fund / Sweep / Receive live on the account itself: switch to it (the wallet reloads into it).
    openAccount: (id) => switchAccount(id),
    // Same as Account menu › Add agent account.
    createAgent: () => {
      startAgentCreate();
      handleSelect('settings', 'create-account');
    },
  };
  const ref = useRef(deps);
  ref.current = deps;
  return ref;
};

/** Wide screen (web, extension tab): apps can be phone-sized or desktop-sized. */
const useWide = () => {
  const q = '(min-width: 768px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return !!wide;
};

const LAYOUT_KEY = (origin: string) => `bwallet.appLayout.${origin}`;

/** The app's size on wide screens: the person's choice for this site, else its catalogue default (desktop). */
const useAppLayout = (origin?: string): ['mobile' | 'desktop', (l: 'mobile' | 'desktop') => void] => {
  const fallback = (): 'mobile' | 'desktop' => {
    if (!origin) return 'desktop';
    try {
      const saved = localStorage.getItem(LAYOUT_KEY(origin));
      if (saved === 'mobile' || saved === 'desktop') return saved;
    } catch {
      /* storage unavailable */
    }
    const app = BAPPS.find((a) => {
      try {
        return new URL(a.url).origin === origin;
      } catch {
        return false;
      }
    });
    return app?.layout ?? 'desktop';
  };
  const [layout, set] = useState(fallback);
  useEffect(() => set(fallback()), [origin]); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = (l: 'mobile' | 'desktop') => {
    set(l);
    try {
      if (origin) localStorage.setItem(LAYOUT_KEY(origin), l);
    } catch {
      /* storage unavailable */
    }
  };
  return [layout, choose];
};
