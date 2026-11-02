/**
 * The web banner's Swap into BSV / Buy BSV buttons (src/web/betaBanner.ts) live outside React; they send a window
 * event and this listener, inside the router, opens the same screens the wallet uses. Store builds have no web
 * banner, and the swap and buy gates (SWAP_ENABLED, BuyBsvSheet) still apply here.
 *
 * UK gate (src/mobile/region/region.ts): the two links are hidden by web.css until the region lookup says "not UK"
 * (html[data-bw-swap] / html[data-bw-buy], set here), and a click is ignored for a restricted visitor.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BuyBsvSheet } from '../mobile/wallet/BuyBsv';
import { requestWalletAction } from '../mobile/phone/walletAction';
import { BUY_CRYPTO_ENABLED, SWAP_ENABLED } from '../mobile/storeBuild';
import { BANNER_EVENT, type BannerAction } from './betaBanner';
import { buyCryptoAllowed, swapAllowed } from '../mobile/region/region';
import { useBuyCryptoAllowed, useSwapAllowed } from '../mobile/region/useRegion';

/** Shows a banner link (web.css) only while its gate is open; fail closed, so it starts hidden. */
const useRootFlag = (name: 'bwSwap' | 'bwBuy', on: boolean) =>
  useEffect(() => {
    const root = typeof document === 'undefined' ? null : document.documentElement;
    if (!root) return;
    if (on) root.dataset[name] = '1';
    else delete root.dataset[name];
  }, [name, on]);

export const BannerActions = () => {
  const navigate = useNavigate();
  const [buy, setBuy] = useState(false);
  useRootFlag('bwSwap', useSwapAllowed());
  useRootFlag('bwBuy', useBuyCryptoAllowed());
  useEffect(() => {
    const on = (e: Event) => {
      const a = (e as CustomEvent<BannerAction>).detail;
      if (a === 'swap' && SWAP_ENABLED && swapAllowed()) navigate('/m/exchange/swap');
      if (a === 'buy' && BUY_CRYPTO_ENABLED && buyCryptoAllowed()) setBuy(true);
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
