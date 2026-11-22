/**
 * The sync's "held as failed" refusal (services/failedRowRepair.ts, report #385), in a module of its own so the address
 * sync and the back-off can recognise it without loading the wallet toolbox.
 */
export type HeldReason =
  | 'not-mined'
  | 'unchecked'
  | 'unavailable'
  | 'unrepaired'
  | 'conflict'
  | 'unconfirmed'
  | 'proof-pending';

const WHY: Record<HeldReason, string> = {
  'not-mined': 'not mined yet, so it stays out until it is',
  unchecked: 'its block proof couldn’t be checked yet; it tries again',
  unavailable: 'this device’s store can’t be repaired directly right now',
  unrepaired: 'the repair left it held',
  conflict: 'a confirmed payment of this wallet spent the same coins',
  unconfirmed: `a payment of this wallet that spent the same coins is settled once this one has 3 confirmations`,
  'proof-pending': 'its block proof checked out, but the wallet couldn’t confirm the proof yet; it tries again',
};

/** The wording every held refusal carries (internalizeBackoff matches it). */
export const HELD_AS_FAILED = 'is held as failed on this device';

/**
 * This device holds `txid` as failed and it could not be taken in. Not a sync failure: the intakes skip it with this
 * reason and look again later. The message avoids the toolbox's wording so it is not taken for that refusal.
 */
export class HeldAsFailedError extends Error {
  readonly txid: string;
  readonly reason: HeldReason;
  /** `detail`: the specific why, when there is one (which payment waits on which confirmations). */
  constructor(txid: string, reason: HeldReason, detail?: string) {
    super(`Transaction ${txid.slice(0, 8)}… ${HELD_AS_FAILED}: ${detail ?? WHY[reason]}`);
    this.name = 'HeldAsFailedError';
    this.txid = txid;
    this.reason = reason;
  }
}

export const isHeldAsFailed = (e: unknown): e is HeldAsFailedError =>
  e instanceof HeldAsFailedError || (e as { name?: unknown } | null)?.name === 'HeldAsFailedError';
