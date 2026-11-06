/**
 * How long a seal waits for the pre-tap coin check, on the WALL CLOCK (owner's iPhone, 6 Nov 2026, doc 2ddfb0ce).
 *
 * The app had been in the background for about an hour. He opened the document and approved; the coin check
 * (STORAGE_RESYNC_COINS) had just started, behind a failing backup heal that held the storage locks. The seal waited on
 * it with a plain `setTimeout(45_000)`, and WKWebView freezes timers while the app is in the background, so the screen
 * sat on "Finding a fresh coin…" far longer than 45 s. He gave up and sealed from the desktop: paid twice.
 *
 * So the wait:
 *   - ends when the coin check finishes, or when the storage is busy with a heal or sync (then the check would only
 *     queue behind it: pay now, and the background createAction's in-flight spent-coin retry covers a spent coin);
 *   - otherwise ends at a deadline measured with `now()` (Date.now), checked on a short tick AND whenever the page
 *     wakes (visibilitychange, pageshow, focus): a frozen tick can delay the check, never the deadline;
 *   - says what it is doing after 2 s (`onSlow`).
 * Never throws. The wall-clock wait itself is services/wallClock.ts (shared with the heal wait in deviceActive.ts).
 * PURE apart from the injected clock (sealWait.test.ts drives it with a frozen one).
 */

import {
  WALL_TICK_MS,
  WALL_TIMEOUT,
  browserWakeClock,
  withinWallClock,
  type WakeClock,
} from '../../services/wallClock';

export { browserWakeClock, type WakeClock };

/** The longest a seal waits for the coin check, whatever the timers do. Then it pays. */
export const COIN_WAIT_CAP_MS = 8_000;
/** After this long the wait says why it is waiting. */
export const COIN_WAIT_SLOW_MS = 2_000;
/** How often the deadline is checked while timers run. */
export const COIN_WAIT_TICK_MS = WALL_TICK_MS;

export type CoinWaitEnd = 'done' | 'busy' | 'cap';

export async function waitForCoinCheck(o: {
  /** The coin check itself; its result does not matter, only that it ended. */
  done: Promise<unknown>;
  /** True when a backup heal or sync holds the storage locks: the check would only queue behind it. */
  storageBusy?: () => Promise<boolean>;
  clock: WakeClock;
  capMs?: number;
  slowMs?: number;
  tickMs?: number;
  onSlow?: () => void;
}): Promise<CoinWaitEnd> {
  const finished = o.done.then(
    () => 'done' as const,
    () => 'done' as const,
  );
  const busy = new Promise<'busy'>((resolve) => {
    if (!o.storageBusy) return;
    Promise.resolve()
      .then(o.storageBusy)
      .then(
        (b) => {
          if (b) resolve('busy');
        },
        () => undefined,
      );
  });
  const why = await withinWallClock(Promise.race([finished, busy]), o.capMs ?? COIN_WAIT_CAP_MS, {
    clock: o.clock,
    tickMs: o.tickMs ?? COIN_WAIT_TICK_MS,
    slowMs: o.slowMs ?? COIN_WAIT_SLOW_MS,
    onSlow: o.onSlow,
  });
  return why === WALL_TIMEOUT ? 'cap' : why;
}
