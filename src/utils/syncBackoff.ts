/**
 * Back-off for the wallet home's quiet refresh when the address sync fails (owner's iPhone, 1 Nov 2026: a sync that
 * timed out after 15 s was retried by the card's 5 s timer, and every dependent job — balance, MNEE, tokens, locks —
 * fired again with it, each time).
 *
 * After a failure the quiet refresh waits 15 s, then 30 s, 60 s, … up to 5 minutes before it tries again. A success
 * (the page's sync answered, or the wallet reported a finished sync) resets it. A manual refresh is never held back.
 * A lock clears it (sessionCaches.ts).
 */
import { onSessionReset } from './sessionCaches';

export const SYNC_BACKOFF_BASE_MS = 15_000;
export const SYNC_BACKOFF_MAX_MS = 5 * 60_000;

/** Wait after the n-th consecutive failure: 15 s, 30 s, 60 s, 120 s, 240 s, then 300 s. 0 when nothing failed. */
export const syncBackoffDelay = (failures: number, base = SYNC_BACKOFF_BASE_MS, max = SYNC_BACKOFF_MAX_MS): number =>
  failures <= 0 ? 0 : Math.min(max, base * 2 ** Math.min(failures - 1, 30));

export type Backoff = {
  /** Record a failure; returns how long to wait before the next try. */
  fail: () => number;
  /** Record a success: no wait. */
  succeed: () => void;
  /** True when the next try may go now. */
  ready: () => boolean;
  /** Milliseconds left to wait (0 when ready). */
  remainingMs: () => number;
  failures: () => number;
};

export const createBackoff = ({
  base = SYNC_BACKOFF_BASE_MS,
  max = SYNC_BACKOFF_MAX_MS,
  now = Date.now,
}: { base?: number; max?: number; now?: () => number } = {}): Backoff => {
  let failures = 0;
  let until = 0;
  return {
    fail: () => {
      failures++;
      const d = syncBackoffDelay(failures, base, max);
      until = now() + d;
      return d;
    },
    succeed: () => {
      failures = 0;
      until = 0;
    },
    ready: () => now() >= until,
    remainingMs: () => Math.max(0, until - now()),
    failures: () => failures,
  };
};

/** The wallet home's address-sync back-off (one per app session). */
export const syncBackoff = createBackoff();
onSessionReset(syncBackoff.succeed);
