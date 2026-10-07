import validate from 'bitcoin-address-validation';
import type { OneSatContext } from '@1sat/actions';
import { STORE_BUILD, bcorpFeeAddress } from '../storeBuild';
import { hasRate, usdToSats } from '../money/money';
import { BCHAT_ORIGIN } from '../chat/api';
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

// ── First 1,000 rooms free (owner, 7 Oct 2026) ──

/**
 * What the server (bit-sign, the source of truth) says the bCorp setup fee is right now:
 * GET /api/bitsign/rooms/setup-fee → { feeUsd, freeRemaining, reason }. It is 0 while fewer than
 * 1,000 token rooms have ever been created. The wallet charges only what the server says, capped
 * at the build's ROOM_SETUP_FEE_USD; any failure or odd answer means FREE, never a charge.
 */
export type ServerSetupFee = { feeUsd: number; freeRemaining: number; reason: string };

export const SETUP_FEE_URL = `${BCHAT_ORIGIN}/api/bitsign/rooms/setup-fee`;
export const FREE_FEE: ServerSetupFee = { feeUsd: 0, freeRemaining: 0, reason: 'unknown' };

export const parseServerFee = (j: unknown): ServerSetupFee => {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const feeUsd = typeof o.feeUsd === 'number' && Number.isFinite(o.feeUsd) && o.feeUsd > 0 ? o.feeUsd : 0;
  const freeRemaining =
    typeof o.freeRemaining === 'number' && Number.isFinite(o.freeRemaining) && o.freeRemaining > 0
      ? Math.floor(o.freeRemaining)
      : 0;
  const reason = typeof o.reason === 'string' ? o.reason : 'unknown';
  return { feeUsd, freeRemaining, reason };
};

/** The dollars to charge: the server's figure, never more than this build's fee. */
export const chargeUsd = (server: ServerSetupFee | undefined, buildUsd = ROOM_SETUP_FEE_USD) =>
  server ? Math.min(server.feeUsd, buildUsd) : 0;

let cached: { at: number; fee: ServerSetupFee } | null = null;

/** Ask the server (cached 60 s). Never throws: a failure is FREE. */
export const fetchServerSetupFee = async (
  fetchFn: typeof fetch = (...a) => fetch(...a),
  now = Date.now(),
): Promise<ServerSetupFee> => {
  if (cached && now - cached.at < 60_000) return cached.fee;
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
    const t = ctl ? setTimeout(() => ctl.abort(), 5000) : undefined;
    const res = await fetchFn(SETUP_FEE_URL, { signal: ctl?.signal }).finally(() => t && clearTimeout(t));
    if (!res.ok) return FREE_FEE;
    const fee = parseServerFee(await res.json());
    cached = { at: now, fee };
    return fee;
  } catch {
    return FREE_FEE;
  }
};

/** Test hook. */
export const resetServerSetupFeeCache = () => {
  cached = null;
};

/** "Free: one of the first 1,000 rooms (N left)", or '' when the free offer doesn't apply. */
export const freeRoomNote = (server: ServerSetupFee | undefined) =>
  server && server.reason === 'free-first-1000' && server.freeRemaining > 0 && server.feeUsd === 0
    ? `Free: one of the first 1,000 rooms (${server.freeRemaining.toLocaleString('en-US')} left)`
    : '';

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

/**
 * The bCorp setup fee for this payer: only the token's issuer pays it. Any other holder funding the
 * index (token detail "Index $X") pays just the indexing cost (owner, 7 Oct 2026).
 */
export const setupFeeFor = (feeSats: number, isIssuer: boolean) => (isIssuer ? feeSats : 0);

/** The bCorp fee output of a room setup, if any (none when the fee is 0 or there is no fee address). */
export const roomSetupExtraOutputs = (ticker: string, feeSats: number, feeAddress = roomSetupFeeAddress()) =>
  feeAddress && feeSats > 0
    ? [{ address: feeAddress, satoshis: feeSats, outputDescription: `bWallet room setup ($${ticker})`.slice(0, 50) }]
    : [];

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
    extraOutputs: roomSetupExtraOutputs(ticker, feeSats, feeAddress),
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
