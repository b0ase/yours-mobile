import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ONBOARDING, toPublic } from './publicUrl';
import { startRoute } from './resume';

/**
 * Web and Desktop only: mirrors the in-app route into the address bar (publicUrl.ts), and opens a pasted or
 * bookmarked URL such as /spaces/bwallet-lounge once the wallet has started (after unlock and its first redirect).
 */
export const UrlSync = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const pending = useRef(startRoute());
  useEffect(() => {
    if (pending.current) {
      // Wait for the start screen's own redirect, then open the URL the visitor came in on.
      // Not during create/restore either: the visitor comes back once the wallet is open.
      if (location.pathname === '/' || ONBOARDING.has(location.pathname)) return;
      const to = pending.current;
      pending.current = null;
      if (to !== location.pathname + location.search) return void navigate(to, { replace: true });
    }
    const next = toPublic(location.pathname, location.search);
    if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, '', next);
  }, [location.pathname, location.search, navigate]);
  return null;
};
