import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BottomMenuContext, type MenuItems } from '../../contexts/BottomMenuContext';
import { useServiceContext } from '../../hooks/useServiceContext';
import { backStackSize } from '../backStack';
import { getBappFrameState, openBapp } from '../bappFrame/bappFrame';
import { usePendingIndexing } from '../tokens/pendingIndexing';
import { indexingEnabled } from '../storeBuild';
import { TAB_TAP } from '../tabs/tabs';
import { setWalletKind } from '../wallet/walletKind';
import { AddToDockSheet } from './AddToDockSheet';
import { Dock } from './Dock';
import { addToDock, dockKey, type DockItem } from './dockModel';
import { useDock } from './dockStore';
import { usePhoneLayout } from './flag';
import { PHONE_ADD_TO_DOCK, PHONE_TOAST } from './events';
import { classifySwipe } from './gesture';
import { PageDots } from './PageDots';
import { backGoesHome, setPhoneBack } from './phoneBack';
import { HOME, neighbour, screenById, screenForPath, STRIP, type Screen } from './screens';
import { SendReceiveSheet } from './SendReceiveSheet';
import { useAppServices } from './useAppServices';
import { requestWalletAction, type WalletAction } from './walletAction';

const PairSheet = lazy(() => import('../pair/PairSheet'));

const LABELS: Record<string, string> = Object.fromEntries(STRIP.map((s) => [s.id, s.label]));

/** A touch that starts in one of these is never a page swipe. */
const NO_SWIPE =
  '[data-phone-dock],[data-no-strip-swipe],input,textarea,select,[contenteditable="true"],[role="slider"],[role="dialog"]';
const inSideScroller = (el: Element | null): boolean => {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1) {
      const o = getComputedStyle(n).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
  }
  return false;
};

/** First strip page this session: a cold start lands on HOME, not the wallet (plan §6). */
let landed = false;

/**
 * The phone layout (docs/PHONE-LAYOUT-PLAN.md), mounted ONCE inside the router (vite.config.mobile.ts App.tsx
 * patch). Renders nothing while the test switch is off. When on:
 *  - the URL stays the source of truth; swipes, dots and dock taps use replace-navigation, so they don't fill
 *    the back stack (opening inner screens still pushes, as before);
 *  - only the current screen is mounted (each is its own route), so there is never more than current ±1;
 *  - pairing listeners run here, once (useAppServices), not in every TopNav;
 *  - Android Back on a strip page other than HOME goes HOME (phoneBack.ts, main.ts).
 */
export const PhoneShell = () => {
  const on = usePhoneLayout();
  return on ? <Shell /> : null;
};

const Shell = () => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const menu = useContext(BottomMenuContext);
  const { apiContext, chromeStorageService } = useServiceContext();
  const { pairLink, clearPairLink } = useAppServices();
  const [dock, setDock] = useDock();
  const [sendReceive, setSendReceive] = useState(false);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const current = screenForPath(pathname);
  const visible = !!menu?.isVisible;

  const pending = usePendingIndexing(
    apiContext,
    chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress,
  ).length;

  /** Go to a strip page (replace), keeping the old bottom-bar selection in step for upstream callers. */
  const go = (s: Screen) => {
    const legacy = s.legacyIds[0];
    if (s.id === 'wallet') setWalletKind('tokens');
    if (screenForPath(pathname)?.id === s.id) {
      // Already here: reset the screen's inner pages, like re-tapping a tab did.
      if (legacy) window.dispatchEvent(new CustomEvent(TAB_TAP, { detail: legacy }));
      if (pathname !== s.route) navigate(s.route, { replace: true });
      return;
    }
    navigate(s.route, { replace: true });
    if (legacy) menu?.handleSelect(legacy as MenuItems);
    else menu?.clearSelection();
  };
  const goRef = useRef(go);
  goRef.current = go;
  const goHome = () => {
    const h = screenById(HOME);
    if (h) go(h);
  };

  // A cold start opens on HOME.
  useEffect(() => {
    if (landed || !current) return;
    landed = true;
    try {
      sessionStorage.removeItem('bwallet:apps-page');
    } catch {
      /* storage unavailable */
    }
    if (current.id === 'wallet') goHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  // Android Back: off HOME → HOME.
  useEffect(() => {
    setPhoneBack(() => {
      const s = current;
      if (!backGoesHome(s?.id)) return false;
      goHome();
      return true;
    });
    return () => setPhoneBack(null);
  });

  // Page swipes: a quick, mostly sideways swipe moves one page. Never from the dock, a sideways scroller,
  // a text field or an open sheet / bApp, so inner swipers keep working.
  useEffect(() => {
    let start: { x: number; y: number; t: number } | null = null;
    const down = (e: TouchEvent) => {
      start = null;
      if (e.touches.length !== 1 || !screenForPath(pathname)) return;
      const t = e.target as Element | null;
      if (!t || t.closest?.(NO_SWIPE) || inSideScroller(t)) return;
      if (backStackSize() > 0 || getBappFrameState().session) return;
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    };
    const up = (e: TouchEvent) => {
      const s = start;
      start = null;
      const p = e.changedTouches[0];
      if (!s || !p) return;
      const dir = classifySwipe(p.clientX - s.x, p.clientY - s.y, Date.now() - s.t);
      const here = screenForPath(pathname);
      if (!dir || !here) return;
      const next = neighbour(here.id, dir);
      if (next) goRef.current(next);
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
    };
  }, [pathname]);

  // Others (an app's details "Add to Dock") reach the shell by event.
  useEffect(() => {
    const add = (e: Event) => {
      const r = addToDock(dock, (e as CustomEvent<DockItem>).detail);
      if (r.ok) setDock(r.items);
      setToast(
        r.ok
          ? 'Added to the dock'
          : r.reason === 'full'
            ? 'Dock is full'
            : r.reason === 'already'
              ? 'Already in the dock'
              : 'Not available',
      );
    };
    const say = (e: Event) => setToast((e as CustomEvent<string>).detail);
    window.addEventListener(PHONE_ADD_TO_DOCK, add);
    window.addEventListener(PHONE_TOAST, say);
    return () => {
      window.removeEventListener(PHONE_ADD_TO_DOCK, add);
      window.removeEventListener(PHONE_TOAST, say);
    };
  }, [dock, setDock]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(t);
  }, [toast]);

  const walletAction = (a: WalletAction) => {
    setSendReceive(false);
    const w = screenById('wallet');
    if (w) go(w);
    requestWalletAction(a);
  };

  const open = (item: DockItem) => {
    if (item.kind === 'screen') {
      const s = screenById(item.id);
      if (s) go(s);
    } else if (item.kind === 'action') setSendReceive(true);
    else {
      const apps = screenById('apps');
      if (apps && current?.id !== 'apps') go(apps);
      openBapp(item.name, item.url).catch(() => setToast('Could not open the app'));
    }
  };

  const badges = useMemo(
    () => ({ 'screen:wallet': pending && indexingEnabled() ? String(pending) : undefined }),
    [pending],
  );

  return (
    <>
      {visible && (
        <Dock
          items={dock}
          labels={LABELS}
          activeKey={current ? dockKey({ kind: 'screen', id: current.id }) : null}
          badges={badges}
          onOpen={open}
          onHome={goHome}
          onChange={setDock}
          onAdd={() => setAdding(true)}
          pageKey={pathname}
          dots={current ? <PageDots strip={STRIP} current={current.id} onGo={go} /> : null}
        />
      )}
      {toast && (
        <div
          role="status"
          className="absolute left-1/2 -translate-x-1/2 z-[160] rounded-full px-4 py-2 text-[13px] font-semibold text-white"
          style={{ bottom: 'calc(var(--dock-h) + 2.5rem)', background: 'rgba(43,47,54,0.95)' }}
        >
          {toast}
        </div>
      )}
      {sendReceive && <SendReceiveSheet onPick={walletAction} onClose={() => setSendReceive(false)} />}
      {adding && (
        <AddToDockSheet
          items={dock}
          strip={STRIP}
          labels={LABELS}
          onAdd={(i) => {
            const r = addToDock(dock, i);
            if (r.ok) setDock(r.items);
            else setToast(r.reason === 'full' ? 'Dock is full' : 'Not available');
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {pairLink && (
        <Suspense fallback={null}>
          <PairSheet initial={pairLink} onClose={clearPairLink} />
        </Suspense>
      )}
    </>
  );
};

export default PhoneShell;
