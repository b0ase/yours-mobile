import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { useLocation, useNavigate } from 'react-router-dom';
import { BottomMenuContext, type MenuItems } from '../../contexts/BottomMenuContext';
import { useServiceContext } from '../../hooks/useServiceContext';
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
import { PHONE_ADD_TO_DOCK, PHONE_GO, PHONE_TOAST } from './events';
import { placeFirstFree, renameScreen, screenTitle } from './appScreens';
import { getAppScreens, setAppScreens, useAppScreens } from './appScreensStore';
import { lockAxis, PAGE_SNAP_MS, pageRelease, rubberBand } from './gesture';
import { getPageEl } from './pageEl';
import { PageDots } from './PageDots';
import { backGoesHome, setPhoneBack } from './phoneBack';
import { appIndexForPath, appScreenRoute, pageForPath, screenById, STRIP, type Screen } from './screens';
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

/**
 * An open sheet or dialog on screen (not in a page kept off screen, phone/pager.tsx): no page swipe. The back
 * stack can't say this any more, since a kept page may hold its own open sheet while hidden.
 */
const sheetOnScreen = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"],[aria-modal="true"]')].some(
    (el) => !el.closest('.bw-page-off') && el.getClientRects().length > 0,
  );

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
  const screens = useAppScreens().screens;
  const count = screens.length;
  /** The app screen on show (swipeable), or the page (Wallet, Exchange, Feed, Chat…), or neither. */
  const curIdx = appIndexForPath(pathname, count);
  const current = curIdx === null ? pageForPath(pathname) : null;
  const reduce = useReducedMotion();
  const visible = !!menu?.isVisible;

  const pending = usePendingIndexing(
    apiContext,
    chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress,
  ).length;

  /** Go to app screen i (replace). */
  const goScreen = (i: number) => {
    const route = appScreenRoute(Math.max(0, Math.min(i, count - 1)));
    if (pathname !== route) navigate(route, { replace: true });
    menu?.clearSelection();
  };
  /** Go to a page (replace), keeping the old bottom-bar selection in step for upstream callers. Home, Apps and
   *  Games are app screens 1, 2 and 3 now (Option B). */
  const go = (s: Screen) => {
    if (s.id === 'home' || s.id === 'apps' || s.id === 'games')
      return goScreen(s.id === 'home' ? 0 : s.id === 'apps' ? 1 : 2);
    const legacy = s.legacyIds[0];
    if (s.id === 'wallet') setWalletKind('tokens');
    if (pageForPath(pathname)?.id === s.id) {
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
  const goScreenRef = useRef(goScreen);
  goScreenRef.current = goScreen;
  const goHome = () => goScreen(0);

  // A cold start opens on HOME.
  useEffect(() => {
    if (landed || (!current && curIdx === null)) return;
    landed = true;
    try {
      sessionStorage.removeItem('bwallet:apps-page');
    } catch {
      /* storage unavailable */
    }
    if (current?.id === 'wallet') goHome();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, curIdx]);

  // Android Back: off HOME → HOME.
  useEffect(() => {
    setPhoneBack(() => {
      if (!backGoesHome(current ? current.id : curIdx ? 'screen' : null)) return false;
      goHome();
      return true;
    });
    return () => setPhoneBack(null);
  });

  // iOS-style paging (plan §14.3): the page follows the finger with the neighbour sliding in beside it, then
  // snaps. Transforms only, set straight on the elements (no React render per move). Never from the dock, a
  // sideways scroller, a text field or an open sheet / bApp, so inner swipers keep working; the axis locks after
  // 10px, so vertical scrolling inside pages is untouched.
  const [dotTarget, setDotTarget] = useState<number | null>(null);
  const settling = useRef(false);
  /** Move the whole track (phone/pager.tsx) by tx px; while it is off rest, the neighbours show. */
  const place = (tx: number, ms: number, dragging: boolean) => {
    const el = getPageEl();
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
    el.style.transform = tx ? `translate3d(${tx}px,0,0)` : '';
    if (dragging) el.dataset.dragging = '1';
    else delete el.dataset.dragging;
  };
  /** Snap to `target` (a neighbour on `side`) or back (null). */
  const settle = (target: number | null, side: -1 | 1, tx: number) => {
    const w = getPageEl()?.clientWidth ?? window.innerWidth;
    const ms = reduce ? 0 : Math.round(PAGE_SNAP_MS * Math.min(1, Math.max(0.4, (w - Math.abs(tx)) / w + 0.2)));
    settling.current = true;
    place(target !== null ? -side * w : 0, ms, true);
    window.setTimeout(() => {
      if (target !== null) {
        goScreenRef.current(target); // the route changes; the layout effect below puts the track back at rest
      } else {
        place(0, 0, false);
        settling.current = false;
      }
      setDotTarget(null);
    }, ms + 16);
  };
  // After the route changes the new page is the track's centre: reset before the browser paints.
  useLayoutEffect(() => {
    place(0, 0, false);
    settling.current = false;
  }, [pathname]);
  /** Go to app screen `to`: a neighbour slides in (dots); further away, or reduced motion, just goes. */
  const slideTo = (to: number) => {
    const from = curIdx;
    if (reduce || from === null || settling.current || !getPageEl() || Math.abs(to - from) !== 1) return goScreen(to);
    const side: -1 | 1 = to > from ? 1 : -1;
    place(0, 0, true);
    requestAnimationFrame(() => settle(to, side, 0));
  };
  const slideRef = useRef(slideTo);
  slideRef.current = slideTo;

  useEffect(() => {
    type Drag = {
      x: number;
      y: number;
      axis: 'x' | 'y' | null;
      lx: number;
      lt: number;
      vx: number;
      tx: number;
      side: -1 | 1;
    };
    let d: Drag | null = null;
    const here = () => appIndexForPath(pathname, count);
    const exists = (i: number) => i >= 0 && i < count;
    const down = (e: TouchEvent) => {
      d = null;
      if (settling.current || e.touches.length !== 1 || here() === null) return;
      const t = e.target as Element | null;
      if (!t || t.closest?.(NO_SWIPE) || inSideScroller(t)) return;
      if (sheetOnScreen() || getBappFrameState().session) return;
      const p = e.touches[0];
      d = { x: p.clientX, y: p.clientY, axis: null, lx: p.clientX, lt: performance.now(), vx: 0, tx: 0, side: 1 };
    };
    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      const h = here();
      if (!d || !p || h === null) return;
      const dx = p.clientX - d.x;
      if (!d.axis) {
        d.axis = lockAxis(dx, p.clientY - d.y);
        if (!d.axis) return;
      }
      if (d.axis === 'y') return void (d = null);
      e.preventDefault(); // horizontal: the page moves, not the scroller
      const now = performance.now();
      if (now > d.lt) d.vx = 0.8 * ((p.clientX - d.lx) / (now - d.lt)) + 0.2 * d.vx;
      d.lx = p.clientX;
      d.lt = now;
      const w = getPageEl()?.clientWidth ?? window.innerWidth;
      const side: -1 | 1 = dx < 0 ? 1 : -1;
      const n = exists(h + side) ? h + side : null;
      d.side = side;
      d.tx = n !== null && !reduce ? dx : rubberBand(dx, w);
      place(d.tx, 0, true);
      setDotTarget(n !== null && Math.abs(dx) > w / 2 ? n : null);
    };
    const up = () => {
      const s = d;
      d = null;
      const h = here();
      if (!s || s.axis !== 'x' || h === null) return;
      const w = getPageEl()?.clientWidth ?? window.innerWidth;
      const dir = pageRelease(s.tx, s.vx, w, exists(h - 1), exists(h + 1));
      const target = dir ? h + dir : null;
      if (reduce && target !== null) {
        place(0, 0, false);
        return goScreenRef.current(target);
      }
      settle(target, s.side, s.tx);
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, reduce, count]);

  // Others (an app's details "Add to Dock") reach the shell by event.
  useEffect(() => {
    const add = (e: Event) => {
      const r = addToDock(dock, (e as CustomEvent<DockItem>).detail);
      if (r.ok) setDock(r.items);
      setToast(
        r.ok
          ? 'Added to the dock'
          : r.reason === 'full'
            ? 'The dock is full (4). Remove one first.'
            : r.reason === 'already'
              ? 'Already in the dock'
              : 'Not available',
      );
    };
    const say = (e: Event) => setToast((e as CustomEvent<string>).detail);
    // A Home screen tile (Wallet, Exchange, Feed…) opens its page.
    const goTo = (e: Event) => {
      const sc = screenById((e as CustomEvent<string>).detail);
      if (sc) goRef.current(sc);
    };
    window.addEventListener(PHONE_GO, goTo);
    window.addEventListener(PHONE_ADD_TO_DOCK, add);
    window.addEventListener(PHONE_TOAST, say);
    return () => {
      window.removeEventListener(PHONE_ADD_TO_DOCK, add);
      window.removeEventListener(PHONE_TOAST, say);
      window.removeEventListener(PHONE_GO, goTo);
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
      if (curIdx === null) goHome();
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
          onAgent={() => navigate('/m/agent')}
          onChange={(next) => {
            // An app leaving the dock goes to the first free slot on the app screens (never lost). Page tiles
            // (Wallet…) are placed by the app-screens store itself (appScreensStore.ts reconcile).
            let placed = getAppScreens();
            for (const i of dock)
              if (i.kind === 'app' && !next.some((n) => n.kind === 'app' && n.url === i.url))
                placed = placeFirstFree(placed, i.url);
            if (placed !== getAppScreens()) setAppScreens(placed);
            setDock(next);
          }}
          onAdd={() => setAdding(true)}
          pageKey={pathname}
          dots={
            curIdx !== null ? (
              <PageDots
                titles={screens.map((x, i) => screenTitle(x, i))}
                current={dotTarget ?? curIdx}
                onGo={(i) => slideRef.current(i)}
                onRename={(i) => {
                  const name = window.prompt('Name this screen', screenTitle(screens[i], i));
                  if (name !== null) setAppScreens(renameScreen(getAppScreens(), i, name));
                }}
              />
            ) : null
          }
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
