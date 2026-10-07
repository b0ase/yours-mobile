import { useContext, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { opensWalletNfts, routeFor, TAB_TAP } from './tabs';
import { setWalletKind } from '../wallet/walletKind';

/**
 * Mobile swap for src/hooks/useBottomMenu.tsx (vite.config.mobile.ts): same
 * contract, but routes the five mobile tabs (Apps · Market · Wallet · Feed · Chat) and Settings.
 */
/**
 * The selection last routed. Many components call this hook (TopNav is mounted inside Media and the
 * b agent too); without this, each new instance's mount effect re-navigated to the current
 * selection, e.g. opening the b agent bounced straight back to Settings.
 */
let routedSelection: string | null | undefined;

export const useBottomMenu = () => {
  const context = useContext(BottomMenuContext);
  const navigate = useNavigate();
  const path = useRef('');
  path.current = useLocation().pathname;

  if (!context) {
    throw new Error('useBottomMenu must be used within a BottomMenuProvier');
  }

  useEffect(() => {
    if (!context || !navigate) return;
    if (context.selected === routedSelection) return;
    routedSelection = context.selected;
    if (opensWalletNfts(context.selected)) setWalletKind('nfts');
    const route = routeFor(context.selected);
    // Already there (e.g. the phone layout swiped to it): don't push a duplicate history entry.
    if (route && path.current !== route) navigate(route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.selected]);

  // A tap on the already-selected tab doesn't change `selected`, so route it here too.
  useEffect(() => {
    const onTap = (e: Event) => {
      const route = routeFor((e as CustomEvent<string>).detail);
      if (route && path.current !== route) navigate(route);
    };
    window.addEventListener(TAB_TAP, onTap);
    return () => window.removeEventListener(TAB_TAP, onTap);
  }, [navigate]);

  return context;
};
