/**
 * Getting a host or speaker back into a Space after the connection drops.
 *
 * 9 Oct 2026, LOUNGE: the host's iPhone lost the SFU connection three minutes in. The app turned
 * that straight into "This space has ended" on the phone, stopped heartbeating, and never told
 * bit-sign — so the Space stayed "live" on every page with nobody in it. Now a drop means
 * "Reconnecting…": rejoin with a fresh token, backing off, for about a minute; the mic and camera
 * come back as they were. Only after that does the phone give up (and leave properly).
 */

/** Waits between attempts, ms. Sums to ~60 s; the first try is immediate. */
export const REJOIN_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000];
export const REJOIN_BUDGET_MS = REJOIN_DELAYS_MS.reduce((a, b) => a + b, 0);

export type RejoinOutcome = 'rejoined' | 'ended' | 'gave-up' | 'cancelled';

/** A rejoin attempt can answer "the Space is over" — no point retrying that. */
export class SpaceOverError extends Error {}

export async function rejoinWithBackoff(o: {
  attempt: () => Promise<void>;
  cancelled: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  delays?: number[];
}): Promise<RejoinOutcome> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const d of o.delays ?? REJOIN_DELAYS_MS) {
    if (d) await sleep(d);
    if (o.cancelled()) return 'cancelled';
    try {
      await o.attempt();
      return 'rejoined';
    } catch (e) {
      if (e instanceof SpaceOverError) return 'ended';
    }
  }
  return o.cancelled() ? 'cancelled' : 'gave-up';
}
