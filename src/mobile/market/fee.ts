import validate from 'bitcoin-address-validation';
import { bcorpFeeAddress } from '../storeBuild';

/**
 * Marketplace fee: an extra, clearly labelled "Marketplace fee" output on
 * every purchase made in the Market tab (owner's model: 1% per trade; the 1%
 * on listing creation applies once listing creation is re-enabled upstream).
 *
 * WHERE TO SET IT: the fee address is a build-time value. Build with
 *   BWALLET_MARKET_FEE_ADDRESS=1YourFeeAddress... pnpm cap:sync
 * (read in vite.config.mobile.ts). The default is EMPTY, which charges no fee.
 * An address only — never put a key here.
 */
declare const __MARKET_FEE_ADDRESS__: string;

export const MARKET_FEE_RATE = 0.01;

// Store build: no fee to bCorp (storeBuild.ts).
const configured = bcorpFeeAddress(typeof __MARKET_FEE_ADDRESS__ === 'string' ? __MARKET_FEE_ADDRESS__.trim() : '');

/** The fee address, or '' when unset/invalid (no fee is charged). */
export const marketFeeAddress = (address = configured): string => (address && validate(address) ? address : '');

/** Fee in sats for a purchase at this price, matching @1sat/actions (ceil(price * rate)). */
export const marketFeeSats = (priceSats: number, address = configured): number =>
  marketFeeAddress(address) ? Math.ceil(priceSats * MARKET_FEE_RATE) : 0;

/** Options to spread into buyOrdinal / buyBsv21. Empty when no fee is configured. */
export const marketFeeOptions = (address = configured): { marketplaceAddress?: string; marketplaceRate?: number } => {
  const a = marketFeeAddress(address);
  return a ? { marketplaceAddress: a, marketplaceRate: MARKET_FEE_RATE } : {};
};
