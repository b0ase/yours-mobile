import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { crashRoute, localResumeStore, markAlive, markClean, markResumed, noteRoute } from './crashResume';
import { ONBOARDING } from './publicUrl';

/** How long after the start screen's redirect to reopen the saved route (lets the phone shell settle first). */
const SETTLE_MS = 400;

/**
 * Phone app only (iOS / Android): remembers the route on screen and, when the last run ended abnormally (iOS
 * killed the web view for memory and Capacitor reloaded it), reopens that route once the wallet has started
 * (after unlock and its first redirect). See crashResume.ts.
 */
export const CrashResume = () => {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const pending = useRef(crashRoute());

  useEffect(() => {
    const store = localResumeStore();
    if (!store) return;
    if (pending.current) {
      // Wait for the start screen's own redirect (and not during create/restore).
      if (pathname === '/' || ONBOARDING.has(pathname)) return;
      const to = pending.current;
      const t = window.setTimeout(() => {
        pending.current = null;
        markResumed(store, Date.now());
        if (to !== pathname + search) navigate(to, { replace: true });
      }, SETTLE_MS);
      return () => window.clearTimeout(t);
    }
    noteRoute(store, pathname + search, Date.now());
  }, [pathname, search, navigate]);

  useEffect(() => {
    const store = localResumeStore();
    if (!store) return;
    const onVis = () => (document.visibilityState === 'hidden' ? markClean(store) : markAlive(store, Date.now()));
    const onHide = () => markClean(store);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  return null;
};
