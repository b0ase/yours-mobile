import { useContext, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BottomMenuContext } from '../../contexts/BottomMenuContext';
import { opensWalletNfts, routeFor } from './tabs';
import { setWalletKind } from '../wallet/walletKind';

/**
 * Mobile swap for src/hooks/useBottomMenu.tsx (vite.config.mobile.ts): same
 * contract, but routes the five mobile tabs (Wallet · Market · Apps · Feed · Chat) and Settings.
 */
export const useBottomMenu = () => {
  const context = useContext(BottomMenuContext);
  const navigate = useNavigate();

  if (!context) {
    throw new Error('useBottomMenu must be used within a BottomMenuProvier');
  }

  useEffect(() => {
    if (!context || !navigate) return;
    if (opensWalletNfts(context.selected)) setWalletKind('nfts');
    const route = routeFor(context.selected);
    if (route) navigate(route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.selected]);

  return context;
};
