import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
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
import { PHONE_ADD_TO_DOCK, PHONE_GO, PHONE_TOAST } from './events';
import { ensureFavourite } from './homeFavourites';
import { lockAxis, PAGE_SNAP_MS, pageRelease, rubberBand } from './gesture';
import { getPageEl } from './pageEl';
import { ScreenPeek } from './pager';
import { PageDots } from './PageDots';
import { backGoesHome, setPhoneBack } from './phoneBack';
import { HOME, neighbour, screenById, screenForPath, STRIP, type Screen, type ScreenId } from './screens';
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
  const reduce = useReducedMotion();
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

  // iOS-style paging (plan §14.3): the page follows the finger with the neighbour sliding in beside it, then
  // snaps. Transforms only, set straight on the elements (no React render per move). Never from the dock, a
  // sideways scroller, a text field or an open sheet / bApp, so inner swipers keep working; the axis locks after
  // 10px, so vertical scrolling inside pages is untouched.
  const [peek, setPeek] = useState<{ id: ScreenId; side: -1 | 1 } | null>(null);
  const [dotTarget, setDotTarget] = useState<ScreenId | null>(null);
  const peekEl = useRef<HTMLDivElement | null>(null);
  const peekRect = useRef<DOMRect | null>(null);
  const pendingSlide = useRef<Screen | null>(null);
  const settling = useRef(false);
  const place = (tx: number, side: number, ms: number) => {
    const el = getPageEl();
    if (!el) return;
    const w = el.clientWidth;
    const t = ms ? `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
    el.style.transition = t;
    el.style.transform = tx ? `translate3d(${tx}px,0,0)` : '';
    const pe = peekEl.current;
    if (pe) {
      pe.style.transition = t;
      pe.style.transform = `translate3d(${side * w + tx}px,0,0)`;
    }
  };
  const showPeek = (id: ScreenId, side: -1 | 1) => {
    const el = getPageEl();
    if (el) peekRect.current = el.getBoundingClientRect();
    setPeek((p) => (p && p.id === id && p.side === side ? p : { id, side }));
  };
  /** Snap to `target` (a neighbour, already peeking) or back (null). */
  const settle = (target: Screen | null, side: -1 | 1, tx: number) => {
    const el = getPageEl();
    const w = el?.clientWidth ?? window.innerWidth;
    const ms = reduce ? 0 : Math.round(PAGE_SNAP_MS * Math.min(1, Math.max(0.4, (w - Math.abs(tx)) / w + 0.2)));
    settling.current = true;
    place(target ? -side * w : 0, side, ms);
    window.setTimeout(() => {
      if (target) {
        goRef.current(target); // the route changes; the layout effect below resets the transforms
      } else {
        place(0, side, 0);
        setPeek(null);
        settling.current = false;
      }
      setDotTarget(null);
    }, ms + 16);
  };
  // After the route changes, put the page back in place before the browser paints, then drop the preview.
  useLayoutEffect(() => {
    place(0, 0, 0);
    setPeek(null);
    settling.current = false;
  }, [pathname]);
  // A slide started by a tap (dock, dots): once the target is mounted beside the page, animate to it.
  useLayoutEffect(() => {
    const target = pendingSlide.current;
    if (!peek || !target || target.id !== peek.id) return;
    pendingSlide.current = null;
    place(0, peek.side, 0);
    requestAnimationFrame(() => settle(target, peek.side, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek]);
  /** Go to a strip page with a slide (dock and dots); the same page or reduced motion just goes. */
  const slideTo = (s: Screen) => {
    const here = current;
    if (reduce || !here || here.id === s.id || settling.current || !getPageEl()) return go(s);
    const side = STRIP.findIndex((x) => x.id === s.id) > STRIP.findIndex((x) => x.id === here.id) ? 1 : -1;
    pendingSlide.current = s;
    showPeek(s.id, side);
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
    const here = () => screenForPath(pathname);
    const down = (e: TouchEvent) => {
      d = null;
      if (settling.current || e.touches.length !== 1 || !here()) return;
      const t = e.target as Element | null;
      if (!t || t.closest?.(NO_SWIPE) || inSideScroller(t)) return;
      if (backStackSize() > 0 || getBappFrameState().session) return;
      const p = e.touches[0];
      d = { x: p.clientX, y: p.clientY, axis: null, lx: p.clientX, lt: performance.now(), vx: 0, tx: 0, side: 1 };
    };
    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      const h = here();
      if (!d || !p || !h) return;
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
      const n = neighbour(h.id, side);
      d.side = side;
      d.tx = n && !reduce ? dx : rubberBand(dx, w);
      if (n) showPeek(n.id, side);
      place(d.tx, side, 0);
      setDotTarget(n && Math.abs(dx) > w / 2 ? n.id : null);
    };
    const up = () => {
      const s = d;
      d = null;
      const h = here();
      if (!s || s.axis !== 'x' || !h) return;
      const w = getPageEl()?.clientWidth ?? window.innerWidth;
      const dir = pageRelease(s.tx, s.vx, w, !!neighbour(h.id, -1), !!neighbour(h.id, 1));
      const target = dir ? neighbour(h.id, dir) : null;
      if (reduce && target) {
        place(0, 0, 0);
        setPeek(null);
        return goRef.current(target);
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
  }, [pathname, reduce]);

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
      if (sc) slideRef.current(sc);
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
      if (s) slideRef.current(s);
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
          onAgent={() => navigate('/m/agent')}
          onChange={(next) => {
            // An app leaving the dock goes back on Home (an app is in the dock or on Home, never lost).
            for (const i of dock)
              if (i.kind === 'app' && !next.some((n) => n.kind === 'app' && n.url === i.url)) ensureFavourite(i.url);
            setDock(next);
          }}
          onAdd={() => setAdding(true)}
          pageKey={pathname}
          dots={
            current ? (
              <PageDots strip={STRIP} current={dotTarget ?? current.id} onGo={(s) => slideRef.current(s)} />
            ) : null
          }
        />
      )}
      {peek && (
        <div
          ref={peekEl}
          aria-hidden
          data-phone-peek
          className="fixed overflow-hidden pointer-events-none"
          style={{
            zIndex: 5,
            background: '#010101',
            top: peekRect.current?.top ?? 0,
            left: peekRect.current?.left ?? 0,
            width: peekRect.current?.width ?? '100%',
            height: peekRect.current?.height ?? '100%',
            transform: `translate3d(${peek.side * (peekRect.current?.width ?? window.innerWidth)}px,0,0)`,
            willChange: 'transform',
          }}
        >
          <ScreenPeek id={peek.id} />
        </div>
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
