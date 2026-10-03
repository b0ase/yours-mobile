import { useEffect, useRef } from 'react';
import { TAB_TAP, type MobileTab } from './tabs';

/**
 * Tapping a tab in the bar always lands on that tab's main screen (owner, 4 Oct 2026): pages with
 * inner screens (Manage Tokens, a token page, a Market room…) reset them here.
 */
export const useTabHome = (tab: MobileTab, reset: () => void) => {
  const cb = useRef(reset);
  cb.current = reset;
  useEffect(() => {
    const onTap = (e: Event) => (e as CustomEvent<string>).detail === tab && cb.current();
    window.addEventListener(TAB_TAP, onTap);
    return () => window.removeEventListener(TAB_TAP, onTap);
  }, [tab]);
};
