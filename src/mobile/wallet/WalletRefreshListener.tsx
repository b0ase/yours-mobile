import { useEffect, useRef } from 'react';
import { WALLET_REFRESH } from './walletRefresh';

/** Mounted on the Wallet home: runs `onRefresh` (the page's refreshUtxos) on every request. */
export const WalletRefreshListener = ({ onRefresh }: { onRefresh: () => unknown }) => {
  const ref = useRef(onRefresh);
  ref.current = onRefresh;
  useEffect(() => {
    const run = () => void ref.current();
    window.addEventListener(WALLET_REFRESH, run);
    return () => window.removeEventListener(WALLET_REFRESH, run);
  }, []);
  return null;
};
