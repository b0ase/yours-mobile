import { useNavigate } from 'react-router-dom';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem, routeFor } from '../tabs/tabs';
import { setWalletKind } from './walletKind';

/**
 * Ask the Wallet home to reload its balance and token / NFT lists now (the same refresh as pull to refresh).
 * Fired after the wallet itself moved coins in (Settings › Sweep, 13 Oct 2026: "it didn't refresh
 * automatically"). The home listens through <WalletRefreshListener>, a build-time insert in BsvWallet.tsx.
 */
export const WALLET_REFRESH = 'bwallet:wallet-refresh';

export const requestWalletRefresh = () => {
  try {
    window.dispatchEvent(new Event(WALLET_REFRESH));
  } catch {
    /* no window (tests) */
  }
};

/** The route the bottom nav's Wallet uses. */
export const WALLET_HOME_ROUTE = routeFor('bsv') ?? '/bsv-wallet';

/** Go to the Wallet home exactly as the bottom nav's Wallet does (tab selected, Tokens view), then refresh it. */
export const useGoToWallet = () => {
  const navigate = useNavigate();
  const { handleSelect } = useBottomMenu();
  return () => {
    setWalletKind('tokens');
    handleSelect(asMenuItem('bsv'));
    navigate(WALLET_HOME_ROUTE);
    // A kept (already mounted) home gets the refresh now; a fresh mount loads its balance anyway.
    setTimeout(requestWalletRefresh, 0);
  };
};
