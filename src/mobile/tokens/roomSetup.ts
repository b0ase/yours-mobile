import validate from 'bitcoin-address-validation';
import type { OneSatContext } from '@1sat/actions';
import { STORE_BUILD, bcorpFeeAddress } from '../storeBuild';
import { hasRate, usdToSats } from '../money/money';
import { INDEX_FUND_NETWORK_SATS, fundAmount, fundIndexing, type OverlayStatus } from './indexFund';

/**
 * "Set up $X's room": the one paid step that makes a user's own token visible (other wallets, the
 * Market) and opens its chat room. Minting no longer pays this (owner decision, 3 Oct 2026).
 *
 * Price = the indexer shortfall (fundAmount: up to the 1Sat `min_funding`) + a bCorp setup fee
 * priced in US dollars (BWALLET_ROOM_SETUP_FEE_USD, default $1.00) and paid in sats at the live
 * BSV/USD rate to BWALLET_ROOM_SETUP_FEE_ADDRESS (default '' = no fee). Both are read in
 * vite.config.mobile.ts; address only, never a key. A store build charges no bCorp fee
 * (bcorpFeeAddress), and an unknown rate charges none either (never guess a price).
 *
 * Both outputs go in ONE wallet transaction (fundIndexing's extraOutputs), so the fee can never be
 * charged without the setup. Used by the Wallet card (FinishIndexing), Settings › My tokens and Chat.
 */
declare const __ROOM_SETUP_FEE_USD__: string | undefined;
declare const __ROOM_SETUP_FEE_ADDRESS__: string | undefined;

const envFeeUsd = Number(typeof __ROOM_SETUP_FEE_USD__ === 'string' ? __ROOM_SETUP_FEE_USD__.trim() : '1');
/** The bCorp setup fee in dollars (build-time; default $1.00). */
export const ROOM_SETUP_FEE_USD = Number.isFinite(envFeeUsd) && envFeeUsd > 0 ? envFeeUsd : 0;

const envAddress = typeof __ROOM_SETUP_FEE_ADDRESS__ === 'string' ? __ROOM_SETUP_FEE_ADDRESS__.trim() : '';
/** bCorp address for the setup fee; '' in a store build, when unset, or when invalid. */
export const roomSetupFeeAddress = (address = envAddress, store = STORE_BUILD): string => {
  const a = bcorpFeeAddress(address, store);
  return a && validate(a) ? a : '';
};

/** The bCorp fee in sats: 0 in a store build, with no fee address, or when the BSV/USD rate is unknown. */
export const setupFeeSats = (
  usd: number,
  rate: number,
  store = STORE_BUILD,
  address: string = roomSetupFeeAddress(envAddress, store),
): number => {
  if (store || !address || !hasRate(rate) || !(usd > 0)) return 0;
  return usdToSats(usd, rate) ?? 0;
};

export type SetupTotal = {
  /** To the token's 1Sat fee address (up to min_funding). */
  indexSats: number;
  /** To bCorp (0 = no fee line). */
  feeSats: number;
  networkSats: number;
  totalSats: number;
};

/** What a room setup costs, line by line. */
export const setupTotal = (
  status: Pick<OverlayStatus, 'feePerOutput'> & Partial<Pick<OverlayStatus, 'balance' | 'minFunding'>>,
  feeSats: number,
): SetupTotal => {
  const indexSats = fundAmount(status);
  const fee = Number.isSafeInteger(feeSats) && feeSats > 0 ? feeSats : 0;
  return {
    indexSats,
    feeSats: fee,
    networkSats: INDEX_FUND_NETWORK_SATS,
    totalSats: indexSats + fee + INDEX_FUND_NETWORK_SATS,
  };
};

/** Pay a room setup (after the user's tap / confirmation): indexer + bCorp fee in one tx. */
export const payRoomSetup = (
  ctx: OneSatContext,
  tokenId: string,
  ticker: string,
  status: OverlayStatus,
  feeSats: number,
  feeAddress = roomSetupFeeAddress(),
) =>
  fundIndexing(ctx, tokenId, ticker, {
    status,
    timeoutMs: 8000,
    extraOutputs:
      feeAddress && feeSats > 0
        ? [
            {
              address: feeAddress,
              satoshis: feeSats,
              outputDescription: `bWallet room setup ($${ticker})`.slice(0, 50),
            },
          ]
        : [],
  });

// ── "Not now" (per token, this device) ──

export const DISMISS_PREFIX = 'bwallet.roomSetup.dismissed.';
export const ROOM_SETUP_DISMISSED_EVENT = 'bwallet-room-setup-dismissed';
const dismissKey = (tokenId: string) => `${DISMISS_PREFIX}${tokenId.replace('.', '_')}`;

export const isRoomSetupDismissed = (tokenId: string): boolean => {
  try {
    return localStorage.getItem(dismissKey(tokenId)) === '1';
  } catch {
    return false;
  }
};

/** Hide the Wallet card / badge for this token. Settings › My tokens and Chat still offer setup. */
export const dismissRoomSetup = (tokenId: string) => {
  try {
    localStorage.setItem(dismissKey(tokenId), '1');
    window.dispatchEvent(new Event(ROOM_SETUP_DISMISSED_EVENT));
  } catch {
    /* storage unavailable / no window in tests */
  }
};

export const withoutDismissed = <T extends { tokenId: string }>(list: T[]): T[] =>
  list.filter((t) => !isRoomSetupDismissed(t.tokenId));
