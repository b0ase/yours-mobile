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
 * Never throws. PURE apart from the injected clock (sealWait.test.ts drives it with a frozen one).
 */

/** The longest a seal waits for the coin check, whatever the timers do. Then it pays. */
export const COIN_WAIT_CAP_MS = 8_000;
/** After this long the wait says why it is waiting. */
export const COIN_WAIT_SLOW_MS = 2_000;
/** How often the deadline is checked while timers run. */
export const COIN_WAIT_TICK_MS = 250;

export interface WakeClock {
  /** Wall-clock milliseconds (Date.now): keeps moving while the app sleeps. */
  now(): number;
  /** A repeating tick. It may be frozen (WKWebView in the background), so it is never the only way out. */
  every(ms: number, fn: () => void): () => void;
  /** Call `fn` when the page wakes or comes to the front. Returns the unsubscribe. */
  onWake(fn: () => void): () => void;
}

/** The browser's clock: Date.now, setInterval, and the page's visibilitychange / pageshow / focus. */
export const browserWakeClock = (): WakeClock => ({
  now: () => Date.now(),
  every: (ms, fn) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
  onWake: (fn) => {
    const g = globalThis as unknown as {
      document?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
      addEventListener?: EventTarget['addEventListener'];
      removeEventListener?: EventTarget['removeEventListener'];
    };
    const doc = g.document;
    doc?.addEventListener?.('visibilitychange', fn);
    const win = typeof g.addEventListener === 'function' ? g : null;
    win?.addEventListener?.('pageshow', fn);
    win?.addEventListener?.('focus', fn);
    return () => {
      doc?.removeEventListener?.('visibilitychange', fn);
      win?.removeEventListener?.('pageshow', fn);
      win?.removeEventListener?.('focus', fn);
    };
  },
});

export type CoinWaitEnd = 'done' | 'busy' | 'cap';

export function waitForCoinCheck(o: {
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
  const cap = o.capMs ?? COIN_WAIT_CAP_MS;
  const slow = o.slowMs ?? COIN_WAIT_SLOW_MS;
  return new Promise<CoinWaitEnd>((resolve) => {
    const start = o.clock.now();
    let ended = false;
    let saidSlow = false;
    const stops: (() => void)[] = [];
    const end = (why: CoinWaitEnd) => {
      if (ended) return;
      ended = true;
      for (const s of stops.splice(0))
        try {
          s();
        } catch {
          /* already gone */
        }
      resolve(why);
    };
    const check = () => {
      if (ended) return;
      const waited = o.clock.now() - start;
      if (waited >= cap) return end('cap');
      if (!saidSlow && waited >= slow) {
        saidSlow = true;
        try {
          o.onSlow?.();
        } catch {
          /* words only */
        }
      }
    };
    o.done.then(
      () => end('done'),
      () => end('done'),
    );
    if (o.storageBusy)
      Promise.resolve()
        .then(o.storageBusy)
        .then(
          (busy) => {
            if (busy) end('busy');
          },
          () => undefined,
        );
    // Both settle asynchronously, so nothing has ended yet: the deadline's two ways of being checked.
    stops.push(o.clock.every(o.tickMs ?? COIN_WAIT_TICK_MS, check));
    stops.push(o.clock.onWake(check));
  });
}
