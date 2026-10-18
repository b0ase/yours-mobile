/**
 * The web banner's Swap into BSV / Buy BSV buttons (src/web/betaBanner.ts) live outside React; they send a window
 * event and this listener, inside the router, opens the same screens the wallet uses. Store builds have no web
 * banner, and the swap and buy gates (SWAP_ENABLED, BuyBsvSheet) still apply here.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BuyBsvSheet } from '../mobile/wallet/BuyBsv';
import { requestWalletAction } from '../mobile/phone/walletAction';
import { BUY_CRYPTO_ENABLED, SWAP_ENABLED } from '../mobile/storeBuild';
import { BANNER_EVENT, type BannerAction } from './betaBanner';

export const BannerActions = () => {
  const navigate = useNavigate();
  const [buy, setBuy] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      const a = (e as CustomEvent<BannerAction>).detail;
      if (a === 'swap' && SWAP_ENABLED) navigate('/m/exchange/swap');
      if (a === 'buy' && BUY_CRYPTO_ENABLED) setBuy(true);
    };
    window.addEventListener(BANNER_EVENT, on);
    return () => window.removeEventListener(BANNER_EVENT, on);
  }, [navigate]);
  return buy ? (
    <BuyBsvSheet
      onClose={() => setBuy(false)}
      onReceive={() => {
        setBuy(false);
        navigate('/bsv-wallet');
        requestWalletAction('receive');
      }}
    />
  ) : null;
};
