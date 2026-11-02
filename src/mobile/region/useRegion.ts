import { useEffect, useSyncExternalStore } from 'react';
import { BUY_CRYPTO_ENABLED, MARKET_ENABLED, SWAP_ENABLED } from '../storeBuild';
import {
  REGION_GATE_ON,
  getRegionStatus,
  isRestrictedStatus,
  startRegionCheck,
  subscribeRegion,
  type RegionStatus,
} from './region';

/** The visitor's region status; starts the (once per run) lookup on first use. */
export const useRegionStatus = (): RegionStatus => {
  const s = useSyncExternalStore(subscribeRegion, getRegionStatus, getRegionStatus);
  useEffect(() => {
    void startRegionCheck();
  }, []);
  return s;
};

/** Exchange / Market (and everything that leads to it): MARKET_ENABLED and not a UK visitor (fail closed). */
export const useMarketAllowed = (): boolean => {
  const s = useRegionStatus();
  return MARKET_ENABLED && !isRestrictedStatus(s);
};

/** Swap into BSV: SWAP_ENABLED and not a UK visitor (fail closed). */
export const useSwapAllowed = (): boolean => {
  const s = useRegionStatus();
  return SWAP_ENABLED && !isRestrictedStatus(s);
};

/** Buy BSV (card / bank on-ramps): BUY_CRYPTO_ENABLED and not a UK visitor (fail closed). */
export const useBuyCryptoAllowed = (): boolean => {
  const s = useRegionStatus();
  return BUY_CRYPTO_ENABLED && !isRestrictedStatus(s);
};

/**
 * Price charts (BSV and tokens). Store builds keep theirs exactly as before (the gate is off there); bWalletX hides
 * them from a restricted visitor, so holdings read as plain balances.
 */
export const useChartsAllowed = (): boolean => {
  const s = useRegionStatus();
  return !REGION_GATE_ON || !isRestrictedStatus(s);
};
