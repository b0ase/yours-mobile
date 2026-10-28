import type { TwetchAsk } from './mobile/twetch/twetchCalls';
import type { SwapSheet } from './mobile/p2p/swap/swapActions';

export type PromptKind =
  | 'unlock'
  | 'permission'
  | 'bundle'
  | 'groupedPermission'
  | 'counterpartyPermission'
  | 'oneSatPermission'
  | 'usbCheck'
  | 'streamGrant'
  | 'mintPrivate'
  | 'twetch'
  | 'swap';

/** A gated wallet call is waiting for a registered USB key to be confirmed present. */
export interface UsbCheckRequest {
  requestID: string;
  /** What the call does, for the copy: "sign a transaction", "decrypt data". */
  reason: string;
  originator?: string;
}

/** A site asks to stream payments while the user watches (services/streamGrants.ts). */
export interface StreamGrantPrompt {
  requestID: string;
  /** Browser-derived, never page-claimed. */
  originator: string;
  protocolName: string;
  capSatsPerHour: number;
  /** The wallet's global ceiling: the sheet never offers more. */
  ceilingSatsPerHour: number;
  /** ms since epoch. */
  expiresAt: number;
  description?: string;
  usdPerBsv?: number;
  /**
   * Envelopes (services/envelopes.ts, ALLOWANCES_ENABLED off): this sheet is "Put $X in <site>'s envelope" and the
   * answer is the sats to put in, not an hourly cap. `balanceSats` is what the envelope already holds.
   */
  envelope?: { balanceSats: number };
}

/** A site asks to lock posts privately to the user (services/mintPrivateSite.ts MintPrivateSheet). */
export interface MintPrivatePrompt {
  requestID: string;
  /** Browser-derived, never page-claimed. */
  originator: string;
  /** This call. */
  posts: number;
  sats: number;
  txs: number;
  /** A chunked run: the sheet approves the whole run. */
  sequence?: { chunks: number; index: number; totalPosts?: number; totalSats: number; totalTxs: number };
  usdPerBsv?: number;
}

/** A site asks to sign in to / post on Twetch with the linked Twetch key (mobile/twetch/twetchCalls.ts TwetchAsk). */
export type TwetchPrompt = TwetchAsk & {
  requestID: string;
  /** Browser-derived, never page-claimed. */
  originator: string;
};

/** bChatX asks to offer or accept a contract swap (mobile/p2p/swap/swapActions.ts SwapSheet). */
export type SwapPrompt = SwapSheet & {
  requestID: string;
  /** Browser-derived, never page-claimed. */
  originator: string;
};

export interface PromptRef {
  kind: PromptKind;
  requestID: string;
}
