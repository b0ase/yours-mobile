/**
 * The sync's "held as failed" refusal (services/failedRowRepair.ts, report #385), in a module of its own so the address
 * sync and the back-off can recognise it without loading the wallet toolbox.
 */
export type HeldReason = 'not-mined' | 'unavailable' | 'unrepaired' | 'conflict';

const WHY: Record<HeldReason, string> = {
  'not-mined': 'not mined yet, so it stays out until it is',
  unavailable: 'this device’s store can’t be repaired directly right now',
  unrepaired: 'the repair left it held',
  conflict: 'a confirmed payment of this wallet spent the same coins',
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
  constructor(txid: string, reason: HeldReason) {
    super(`Transaction ${txid.slice(0, 8)}… ${HELD_AS_FAILED}: ${WHY[reason]}`);
    this.name = 'HeldAsFailedError';
    this.txid = txid;
    this.reason = reason;
  }
}

export const isHeldAsFailed = (e: unknown): e is HeldAsFailedError =>
  e instanceof HeldAsFailedError || (e as { name?: unknown } | null)?.name === 'HeldAsFailedError';
