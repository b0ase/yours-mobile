import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toPublic, toRouter } from './publicUrl';

// Read once at load, before anything replaces the address bar.
const START = typeof window === 'undefined' ? null : toRouter(window.location.pathname, window.location.search);

/**
 * Web and Desktop only: mirrors the in-app route into the address bar (publicUrl.ts), and opens a pasted or
 * bookmarked URL such as /spaces/bwallet-lounge once the wallet has started (after unlock and its first redirect).
 */
export const UrlSync = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const pending = useRef(START);
  useEffect(() => {
    if (pending.current) {
      // Wait for the start screen's own redirect, then open the URL the visitor came in on.
      if (location.pathname === '/') return;
      const to = pending.current;
      pending.current = null;
      if (to !== location.pathname + location.search) return void navigate(to, { replace: true });
    }
    const next = toPublic(location.pathname, location.search);
    if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, '', next);
  }, [location.pathname, location.search, navigate]);
  return null;
};
