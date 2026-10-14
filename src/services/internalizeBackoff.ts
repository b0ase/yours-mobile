/**
 * Back-off for the receive guard's direct internalize (services/receiveGuard.ts).
 *
 * Owner, 14 Oct 2026 (Desktop): a 1-sat output of 2a5d3e03… sat at our receive address while storage held that
 * transaction as `failed`, so every address sync retried internalizeAction and got "The tx parameter must be
 * target transaction of internalizeAction has invalid status failed." forever. Such an error can't clear by
 * retrying; only a repair (services/recoverFailed.ts) can, and that clears the entry. Other errors back off
 * exponentially. In memory only: a fresh service worker tries once more.
 */

/** Errors no retry can fix: storage holds the transaction in a state internalizeAction refuses. */
const PERMANENT = [/invalid status failed/i, /invalid status invalid/i];

export const BASE_DELAY_MS = 60 * 1000;
export const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** A permanent refusal waits this long (or until clear(), after a repair). */
export const PERMANENT_DELAY_MS = 24 * 60 * 60 * 1000;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err ?? ''));

export const isPermanentInternalizeError = (err: unknown) => PERMANENT.some((re) => re.test(message(err)));

/** Delay after the n-th consecutive failure (n >= 1). */
export function backoffDelay(failures: number, err?: unknown): number {
  if (isPermanentInternalizeError(err)) return PERMANENT_DELAY_MS;
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, failures - 1));
}

export function createInternalizeBackoff(now: () => number = Date.now) {
  const entries = new Map<string, { failures: number; nextAt: number }>();
  return {
    /** True when txid may be tried now. */
    due(txid: string): boolean {
      const e = entries.get(txid);
      return !e || now() >= e.nextAt;
    },
    /** Record a failure; returns the delay before the next try. */
    fail(txid: string, err?: unknown): number {
      const failures = (entries.get(txid)?.failures ?? 0) + 1;
      const delay = backoffDelay(failures, err);
      entries.set(txid, { failures, nextAt: now() + delay });
      return delay;
    },
    clear(txid: string) {
      entries.delete(txid);
    },
  };
}

export const internalizeBackoff = createInternalizeBackoff();
