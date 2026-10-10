import { useEffect, useState } from 'react';
import {
  currentFx,
  getDisplayCurrency,
  onDisplayCurrencyChange,
  refreshFxRate,
  type Fx,
} from '../utils/displayCurrency';

/** The display currency + rate; re-renders when Settings › Currency changes or a fresh rate arrives. */
export const useDisplayCurrency = (): Fx => {
  const [fx, setFx] = useState<Fx>(currentFx);
  useEffect(() => {
    const update = () =>
      setFx((prev) => {
        const next = currentFx();
        return prev.currency === next.currency && prev.usdPerUnit === next.usdPerUnit ? prev : next;
      });
    const off = onDisplayCurrencyChange(update);
    if (getDisplayCurrency() !== 'USD') void refreshFxRate().then(update);
    update();
    return off;
  }, []);
  return fx;
};
